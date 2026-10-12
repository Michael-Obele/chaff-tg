/**
 * `chaff report` end to end, through `runCli` (`plan/implementation-plan.md`,
 * Task 12). The command is the review step that makes the tool safe: it writes
 * the manifest a user reads before anything destructive, and `--from` reads
 * such a file back. Every case drives the real dispatch path with an injected
 * environment and a temporary XDG root, and the fake client
 * (`CHAFF_FAKE` + `CHAFF_FIXTURE`) is the only Telegram the suite talks to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFilters } from "../src/cli/args";
import { runCli, type CliContext } from "../src/cli/index";
import { EXIT } from "../src/core/errors";
import { filterRecords } from "../src/core/filters";
import { parseManifest } from "../src/core/manifest";
import type { ChatRecord } from "../src/core/types";

/** The Task 2 fixtures, which `CHAFF_FIXTURE` points the fake client at. */
const FIXTURES = join(import.meta.dir, "fixtures");

/** A hash-shaped string, distinct enough that a leak cannot hide in a match. */
const API_HASH = "0123456789abcdef0123456789abcdef";

/** The clock `run` injects, so `why` recomputation sees the same moment. */
const NOW = new Date("2026-10-12T00:00:00Z");

//
// Sandbox and capture helpers, mirrored from test/commands-list.test.ts.
//

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary root, removed after the test. */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "chaff-report-"));
  roots.push(dir);
  return dir;
}

/** An environment pointed at a temporary root, so no real path is ever read. */
function sandbox(extra: Record<string, string | undefined> = {}): {
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
      ...extra,
    },
  };
}

/** The environment that makes the CLI use the shipped fake client. */
function fakeEnv(extra: Record<string, string | undefined> = {}): {
  root: string;
  env: Record<string, string | undefined>;
} {
  return sandbox({ CHAFF_FAKE: "1", CHAFF_FIXTURE: FIXTURES, ...extra });
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

//
// Tests.
//

describe("chaff report", () => {
  test("--out writes a manifest that parses back to the same ids and why arrays", async () => {
    const { env } = fakeEnv();
    const out = join(tempRoot(), "cleanup.json");

    const { code } = await run(["report", "--muted", "--out", out], env);
    expect(code).toBe(EXIT.OK);

    const plan = parseManifest(readFileSync(out, "utf8"));

    // The same ids the same filters produce through `list`: one engine, one
    // order, two commands.
    const listed = await run(["list", "--muted", "--json"], env);
    const listedIds = (
      JSON.parse(listed.stdout.text()) as { chats: Array<{ id: number }> }
    ).chats.map((chat) => chat.id);
    expect(plan.chats.map((chat) => chat.id)).toEqual(listedIds);
    expect(plan.summary.matched).toBe(listedIds.length);

    // And the same `why` arrays the engine computes for those filters — the
    // tokens are the difference between a list you trust and one you re-check.
    const dialogs = (await Bun.file(join(FIXTURES, "dialogs.json")).json()) as ChatRecord[];
    const rows = filterRecords(dialogs, { ...emptyFilters(), muted: true }, NOW).filter(
      (row) => row.ok,
    );
    expect(plan.chats.map((chat) => chat.why)).toEqual(rows.map((row) => row.why));

    // The estimate is the pacing formula at the default delay (1200 ms).
    expect(plan.summary.estimatedSeconds).toBe(Math.round(plan.summary.matched * 1.2));
  });

  test("--json stdout is byte-identical to the manifest file", async () => {
    const { env } = fakeEnv();
    const out = join(tempRoot(), "cleanup.json");

    const { code, stdout } = await run(["report", "--json", "--out", out], env);
    expect(code).toBe(EXIT.OK);
    expect(stdout.text()).toBe(readFileSync(out, "utf8"));
    expect(parseManifest(stdout.text()).version).toBe(1);
  });

  test("--md --out cleanup.md writes markdown, not the manifest", async () => {
    const { env } = fakeEnv();
    const out = join(tempRoot(), "cleanup.md");

    const { code, stdout } = await run(["report", "--muted", "--md", "--out", out], env);
    expect(code).toBe(EXIT.OK);

    const written = readFileSync(out, "utf8");
    expect(written).toBe(stdout.text());
    expect(written).toContain("|");
    expect(written).toContain("Signal Room");
  });

  test("--from replays a manifest without touching Telegram", async () => {
    const { env } = fakeEnv();
    const out = join(tempRoot(), "cleanup.json");
    const written = await run(["report", "--out", out], env);
    expect(written.code).toBe(EXIT.OK);

    // A sandbox with no CHAFF_FAKE and no session: the replay path is local.
    const { env: bareEnv } = sandbox();
    const { code, stdout } = await run(["report", "--from", out, "--json"], bareEnv);

    expect(code).toBe(EXIT.OK);
    // Byte-identical: parseManifest then serializeManifest is the identity
    // (Task 3), so a replay echoes the file it was given.
    expect(stdout.text()).toBe(readFileSync(out, "utf8"));
  });

  test("--from a future version is exit 2, with the ManifestError message", async () => {
    const file = join(tempRoot(), "future.json");
    writeFileSync(
      file,
      JSON.stringify(
        {
          version: 2,
          createdAt: "2030-01-01T00:00:00.000Z",
          account: { id: 1, username: null },
          filters: {},
          summary: { matched: 0, estimatedSeconds: 0 },
          chats: [],
        },
        null,
        2,
      ),
    );

    const { env } = sandbox();
    const { code, stdout, stderr } = await run(["report", "--from", file], env);

    expect(code).toBe(EXIT.USAGE);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("manifest version 2 is not supported");
    expect(stderr.text()).toContain("manifest version 1");
  });

  test("--out inside a git repository warns on stderr but still writes", async () => {
    const { env } = fakeEnv();
    const repo = join(tempRoot(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const out = join(repo, "cleanup.json");

    const { code, stdout, stderr } = await run(["report", "--out", out], env);

    expect(code).toBe(EXIT.OK);
    expect(stderr.text()).toContain("git repository");
    expect(stderr.text()).toContain(repo);
    // Not fatal: the manifest exists and parses.
    expect(parseManifest(readFileSync(out, "utf8")).version).toBe(1);
    // The warning is chatter, not the payload: stdout stays the table.
    expect(stdout.text()).not.toContain("git repository");
  });

  test("the api hash reaches neither the manifest nor either stream", async () => {
    const out = join(tempRoot(), "cleanup.json");
    const { env } = fakeEnv({ CHAFF_API_ID: "12345", CHAFF_API_HASH: API_HASH });

    const table = await run(["report", "--out", out], env);
    const json = await run(["--json", "report"], env);

    // The runs have to succeed, or "no hash anywhere" would hold for the
    // trivial reason that there was no output.
    expect(table.code).toBe(EXIT.OK);
    expect(json.code).toBe(EXIT.OK);
    const manifest = readFileSync(out, "utf8");
    expect(manifest).toContain("chaff_tester");
    expect(manifest).not.toContain(API_HASH);

    for (const result of [table, json]) {
      expect(result.stdout.text()).not.toContain(API_HASH);
      expect(result.stderr.text()).not.toContain(API_HASH);
    }
  });

  test("a fake report touches no local state: the data directory is not created", async () => {
    const { root, env } = fakeEnv();
    const out = join(tempRoot(), "cleanup.json");
    const { code } = await run(["report", "--out", out], env);
    expect(code).toBe(EXIT.OK);
    expect(existsSync(join(root, "data"))).toBe(false);
  });
});
