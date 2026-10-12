/**
 * `chaff leave` end to end, through `runCli` (`plan/implementation-plan.md`,
 * Task 13), plus the two interactive pieces driven directly with scripted
 * input streams.
 *
 * The command is the only writer Telegram ever sees, so the tests here are
 * about the gates around it: a dry run touches nothing, `--yes` records every
 * planned chat in the journal, a flood stops the run and the next run resumes
 * exactly the remainder, and `--exclude` beats every other selection. The fake
 * client's scripted failure list reaches the command through
 * `CHAFF_FAKE_FAILURES` (`chatId:error[:times]`, comma separated), which is
 * how `FLOOD_WAIT_90` and friends are provoked without provoking them.
 *
 * Everything runs offline: a temporary XDG root per test, the shipped fake
 * client, and `--delay 0` so the pacer's jitter is the only wait.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { emptyFilters } from "../src/cli/args";
import { runChecklist, runConfirm, type ChecklistItem } from "../src/cli/checklist";
import { runCli, type CliContext } from "../src/cli/index";
import { checklistItems } from "../src/cli/commands/leave";
import { EXIT } from "../src/core/errors";
import { Journal } from "../src/core/journal";
import { buildPlan } from "../src/core/plan";
import type { ChatRecord } from "../src/core/types";

/** The Task 2 fixtures, which `CHAFF_FIXTURE` points the fake client at. */
const FIXTURES = join(import.meta.dir, "fixtures");

/** The clock every plan in this file is stamped with. */
const NOW = new Date("2026-10-12T00:00:00Z");

/** The muted fixture chats, in fixture order: what `--muted` selects. */
const MUTED = [-1001, -1002, -1005, -1010, -1012] as const;

//
// Sandbox and capture helpers (the same shape test/commands-list.test.ts uses).
//

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary root, removed after the test. */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "chaff-leave-"));
  roots.push(dir);
  return dir;
}

/** An environment pointed at a temporary root, so no real path is ever read. */
function fakeEnv(extra: Record<string, string | undefined> = {}): {
  root: string;
  env: Record<string, string | undefined>;
} {
  const root = tempRoot();
  return {
    root,
    env: {
      HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      CHAFF_FAKE: "1",
      CHAFF_FIXTURE: FIXTURES,
      ...extra,
    },
  };
}

/** Where the command's journal lives under a sandbox root. */
function journalPath(root: string): string {
  return join(root, "data", "chaff-tg", "journal.db");
}

interface Sink {
  write(s: string): unknown;
  text(): string;
}

function sink(): Sink {
  const parts: string[] = [];
  return {
    write(chunk: string) {
      parts.push(chunk);
      return true;
    },
    text() {
      return parts.join("");
    },
  };
}

interface Run {
  code: number;
  stdout: Sink;
  stderr: Sink;
}

/** Run one command line through the real front end, capturing every byte. */
async function run(argv: string[], env: Record<string, string | undefined>): Promise<Run> {
  const stdout = sink();
  const stderr = sink();
  const ctx: CliContext = {
    argv,
    env,
    stdout,
    stderr,
    now: () => NOW,
    isTTY: false,
  };
  return { code: await runCli(ctx), stdout, stderr };
}

/** Scripted stdin: one line per entry, exactly as a user would type them. */
function script(lines: string[]): { input: unknown; output: Sink } {
  return { input: Readable.from(lines.map((line) => `${line}\n`)), output: sink() };
}

//
// The checklist, driven with a scripted input stream.
//

const ITEMS: ChecklistItem[] = [
  {
    id: -1,
    title: "Scam Room",
    type: "channel",
    members: 4821,
    lastMessageAt: "2024-08-02T09:12:00Z",
    scam: true,
    preselected: true,
  },
  {
    id: -2,
    title: "Family Group",
    type: "group",
    members: 12,
    lastMessageAt: "2026-10-10T18:00:00Z",
    scam: false,
    preselected: false,
  },
  {
    id: -3,
    title: "Plain Chat",
    type: "supergroup",
    members: null,
    lastMessageAt: null,
    scam: false,
    preselected: false,
  },
];

describe("runChecklist (scripted input)", () => {
  test("pre-ticked rows are selected on Enter, unticked rows are not", async () => {
    const io = script([""]);
    const picked = await runChecklist(ITEMS, io);

    expect(picked).toEqual([-1]);
    // The boxes are their own padded columns, so the marker and the title are
    // asserted separately; which row is ticked is the ids assertion above.
    const text = io.output.text();
    expect(text).toContain("[x]");
    expect(text).toContain("Scam Room");
    expect(text).toContain("Family Group");
    expect(text).toContain("1 of 3 selected");
  });

  test("a number toggles that row, and Enter returns the set in item order", async () => {
    const io = script(["2", "3", ""]);
    expect(await runChecklist(ITEMS, io)).toEqual([-1, -2, -3]);
  });

  test("a pre-ticked row can be toggled away", async () => {
    expect(await runChecklist(ITEMS, script(["1", ""]))).toEqual([]);
  });

  test("a selects all, and a again clears all", async () => {
    expect(await runChecklist(ITEMS, script(["a", ""]))).toEqual([-1, -2, -3]);
    expect(await runChecklist(ITEMS, script(["a", "a", ""]))).toEqual([]);
  });

  test("q quits with null, and so does the input ending unconfirmed", async () => {
    expect(await runChecklist(ITEMS, script(["q"]))).toBeNull();
    expect(await runChecklist(ITEMS, script([]))).toBeNull();
  });
});

describe("checklistItems", () => {
  test("scam chats are pre-ticked; pinned chats are shown but never pre-ticked", async () => {
    // The expected-record fixture, not the raw one: `loadFixtures` carries only
    // the raw dialogs the seam normalises now, and `checklistItems` is a pure
    // function over a plan, so its input is the records themselves.
    const dialogs = (await Bun.file(
      new URL("./fixtures/dialogs.json", import.meta.url),
    ).json()) as ChatRecord[];
    const plan = buildPlan(dialogs, emptyFilters(), { id: 1, username: "chaff_tester" }, NOW);
    const items = checklistItems(plan);

    // Every chat is shown, pinned ones included: the checklist is the review.
    expect(items.map((item) => item.id)).toEqual(dialogs.map((chat) => chat.id));

    const scam = items.find((item) => item.id === -1001);
    expect(scam?.scam).toBe(true);
    expect(scam?.preselected).toBe(true);

    const pinned = items.find((item) => item.id === -1003);
    expect(pinned?.preselected).toBe(false);
  });
});

//
// The final confirmation: above 20 selected, the word `leave` or nothing.
//

describe("the typed confirmation", () => {
  async function confirm(count: number, lines: string[]): Promise<{ ok: boolean; text: string }> {
    const io = script(lines);
    const ok = await runConfirm({ count, paceMs: 1200, estimateSeconds: 25 }, io);
    return { ok, text: io.output.text() };
  }

  test("above 20 selected, the wrong word does not confirm, and neither does Enter", async () => {
    expect((await confirm(21, ["yes"])).ok).toBe(false);
    expect((await confirm(21, [""])).ok).toBe(false);
    expect((await confirm(21, [])).ok).toBe(false);
  });

  test("above 20 selected, the word leave confirms", async () => {
    expect((await confirm(21, ["leave"])).ok).toBe(true);
  });

  test("20 or fewer confirm on Enter, and q cancels", async () => {
    expect((await confirm(20, [""])).ok).toBe(true);
    expect((await confirm(3, ["q"])).ok).toBe(false);
  });

  test("the screen names the count, the pace and the estimate", async () => {
    const { text } = await confirm(21, ["leave"]);
    expect(text).toContain("21");
    expect(text).toContain("1200ms");
    expect(text).toContain("25s");
    expect(text).toContain("leave");
  });
});

//
// The command.
//

describe("chaff leave", () => {
  test("without --yes nothing is left: every leave scripted to fail still exits 0", async () => {
    // The tripwire: if any leaveChat call happened, its scripted failure would
    // be thrown, classified, and turn the run into exit 4. Exit 0 with the
    // dry-run summary is the proof that no leave was attempted at all.
    const allFail = MUTED.map((id) => `${id}:boom:999`).join(",");
    const { env, root } = fakeEnv({ CHAFF_FAKE_FAILURES: allFail });
    const { code, stdout } = await run(["leave", "--muted"], env);

    expect(code).toBe(EXIT.OK);
    expect(stdout.text()).toContain("dry run");
    expect(stdout.text()).toContain(`would leave ${MUTED.length}`);
    // A rehearsal writes nothing, not even a journal.
    expect(existsSync(join(root, "data"))).toBe(false);
  });

  test("leave --yes with a scripted failure exits 4 and the journal has the rows", async () => {
    const { env, root } = fakeEnv({ CHAFF_FAKE_FAILURES: "-1005:boom:999" });
    const { code, stdout } = await run(
      ["leave", "--muted", "--yes", "--force", "--delay", "0"],
      env,
    );

    expect(code).toBe(EXIT.PARTIAL);
    expect(stdout.text()).toContain("failed");

    const journal = Journal.open(journalPath(root));
    const runs = journal.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0]?.mode).toBe("leave");
    expect(runs[0]?.planned).toBe(MUTED.length);
    expect(runs[0]?.left).toBe(MUTED.length - 1);
    expect(runs[0]?.failed).toBe(1);
    // Finished: --force kept going, so nothing is left pending.
    expect(runs[0]?.finishedAt).not.toBeNull();

    const rows = journal.actions(runs[0]?.id ?? 0);
    expect(rows.find((row) => row.id === -1005)?.state).toBe("failed");
    expect(rows.filter((row) => row.state === "left").map((row) => row.id)).toEqual([
      -1001, -1002, -1010, -1012,
    ]);
    journal.close();
  });

  test("a flood stops with exit 5, and the next leave --yes leaves exactly the remainder", async () => {
    const { env, root } = fakeEnv({ CHAFF_FAKE_FAILURES: "-1002:FLOOD_WAIT_90" });
    const first = await run(["leave", "--muted", "--yes", "--delay", "0"], env);

    expect(first.code).toBe(EXIT.FLOOD);
    expect(first.stderr.text()).toContain("90");

    {
      const journal = Journal.open(journalPath(root));
      const runs = journal.listRuns();
      expect(runs.length).toBe(1);
      expect(runs[0]?.finishedAt).toBeNull();
      const rows = journal.actions(runs[0]?.id ?? 0);
      expect(rows.filter((row) => row.state === "left").map((row) => row.id)).toEqual([-1001]);
      expect(rows.filter((row) => row.state === "pending").map((row) => row.id)).toEqual([
        -1002, -1005, -1010, -1012,
      ]);
      journal.close();
    }

    // The resume run: no flood script (a fresh process gets a fresh fake), but
    // a tripwire on the chat the first run already left. Exit 0 proves that
    // chat was never attempted again; a double leave would fire the failure.
    const second = await run(["leave", "--muted", "--yes", "--delay", "0"], {
      ...env,
      CHAFF_FAKE_FAILURES: "-1001:boom:999",
    });
    expect(second.code).toBe(EXIT.OK);

    {
      const journal = Journal.open(journalPath(root));
      const runs = journal.listRuns();
      // The same run, continued -- not a second one beside it.
      expect(runs.length).toBe(1);
      expect(runs[0]?.finishedAt).not.toBeNull();
      expect(runs[0]?.planned).toBe(MUTED.length);
      expect(runs[0]?.left).toBe(MUTED.length);
      expect(runs[0]?.failed).toBe(0);
      expect(journal.pending(runs[0]?.id ?? 0)).toEqual([]);
      journal.close();
    }
  });

  test("--exclude wins over the filters: an excluded chat is never even planned", async () => {
    const { env, root } = fakeEnv();
    const { code } = await run(
      ["leave", "--muted", "--exclude", "-1001,-1002", "--yes", "--delay", "0"],
      env,
    );

    expect(code).toBe(EXIT.OK);
    const journal = Journal.open(journalPath(root));
    const rows = journal.actions(journal.listRuns()[0]?.id ?? 0);
    expect(rows.map((row) => row.id)).toEqual([-1005, -1010, -1012]);
    journal.close();
  });

  test("--exclude wins over --select: the excluded id is dropped from the selection", async () => {
    const { env, root } = fakeEnv();
    const { code } = await run(
      ["leave", "--select", "-1001,-1002", "--exclude", "-1001", "--yes", "--delay", "0"],
      env,
    );

    expect(code).toBe(EXIT.OK);
    const journal = Journal.open(journalPath(root));
    const rows = journal.actions(journal.listRuns()[0]?.id ?? 0);
    expect(rows.map((row) => row.id)).toEqual([-1002]);
    journal.close();
  });

  test("--from replays a manifest at the caller's pace, with --delay threaded through", async () => {
    const { env, root } = fakeEnv();
    // The manifest is written by the real report command, so the replay path
    // meets the exact bytes a user would hand it.
    const written = await run(["report", "--muted", "--out", join(root, "cleanup.json")], env);
    expect(written.code).toBe(EXIT.OK);

    // A rehearsal sleeps nothing, so the caller's pace can be large: 4 chats
    // at 5000ms is 20s, where the 1200ms default would say 5s. This is the
    // Task-4 binding: the estimate before a destructive run must be the
    // estimate for the pace the user asked for.
    const rehearsal = await run(
      ["leave", "--from", join(root, "cleanup.json"), "--exclude", "-1005", "--delay", "5000"],
      env,
    );
    expect(rehearsal.code).toBe(EXIT.OK);
    expect(rehearsal.stdout.text()).toContain("would leave 4 chats");
    expect(rehearsal.stdout.text()).toContain("about 20s at a 5000ms pace");

    // And the live replay leaves exactly the non-excluded chats.
    const { code } = await run(
      [
        "leave",
        "--from",
        join(root, "cleanup.json"),
        "--exclude",
        "-1005",
        "--yes",
        "--delay",
        "0",
      ],
      env,
    );
    expect(code).toBe(EXIT.OK);

    const journal = Journal.open(journalPath(root));
    const rows = journal.actions(journal.listRuns()[0]?.id ?? 0);
    expect(rows.map((row) => row.id)).toEqual([-1001, -1002, -1010, -1012]);
    journal.close();
  });

  test("--yes with no journal refuses: exit 2, one plain sentence, no hash", async () => {
    // A file where the data directory should be: the journal cannot be opened.
    const root = tempRoot();
    writeFileSync(join(root, "data"), "not a directory");
    const env = {
      HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      CHAFF_FAKE: "1",
      CHAFF_FIXTURE: FIXTURES,
      CHAFF_API_HASH: "0123456789abcdef0123456789abcdef",
    };

    const { code, stdout, stderr } = await run(["leave", "--muted", "--yes", "--delay", "0"], env);

    expect(code).toBe(EXIT.USAGE);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("journal");
    expect(stderr.text()).not.toContain("0123456789abcdef");
    // And nothing was left: the refusal happens before the loop starts.
    expect(stderr.text()).not.toContain("left");
  });

  test("a machine format with no explicit set refuses: exit 2, nothing left", async () => {
    // `--json` cannot host the checklist or the typed confirmation, and with
    // neither `--select` nor `--from` there is nothing else to choose the set
    // from -- quietly acting on the whole plan would be the worst outcome, so
    // the combination is refused before the journal exists.
    const { env } = fakeEnv();
    const { code, stdout, stderr } = await run(
      ["leave", "--muted", "--yes", "--json", "--delay", "0"],
      env,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(stderr.text()).toContain("machine output format");
    expect(stderr.text()).not.toContain("left ");
  });

  test("--select stays scriptable under a machine format", async () => {
    // The refusal is narrow on purpose: naming the set explicitly under
    // `--json` is the documented scripting path and has to keep working.
    const { env } = fakeEnv();
    const { code } = await run(
      ["leave", "--select", "-1005", "--yes", "--json", "--delay", "0"],
      env,
    );

    expect(code).not.toBe(EXIT.USAGE);
  });

  test("the api hash reaches neither stream nor the journal", async () => {
    const hash = "fedcba9876543210fedcba9876543210";
    const { env, root } = fakeEnv({
      CHAFF_API_HASH: hash,
      CHAFF_FAKE_FAILURES: "-1005:boom:999",
    });
    const { code, stdout, stderr } = await run(
      ["leave", "--muted", "--yes", "--force", "--delay", "0"],
      env,
    );

    expect(code).toBe(EXIT.PARTIAL);
    expect(stdout.text()).not.toContain(hash);
    expect(stderr.text()).not.toContain(hash);
    expect(readFileSync(journalPath(root)).includes(hash)).toBe(false);
  });
});
