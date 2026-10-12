/**
 * `chaff list` end to end, through `runCli` (`plan/implementation-plan.md`,
 * Task 11). Every case drives the real dispatch path with an injected
 * environment and a temporary XDG root, so nothing here reads a real
 * `~/.local/share/chaff-tg`, and the fake client (`CHAFF_FAKE`) is the only
 * Telegram the suite talks to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/core/errors";
import { runCli, type CliContext } from "../src/cli/index";

/** The Task 2 fixtures, which `CHAFF_FIXTURE` points the fake client at. */
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A hash-shaped string, distinct enough that a leak cannot hide in a match. */
const API_HASH = "0123456789abcdef0123456789abcdef";

/** The columns `plan/cli.md` and the brief name, in order. */
const COLUMNS = ["id", "type", "title", "username", "members", "last", "flags"] as const;

//
// Sandbox and capture helpers.
//

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary root, removed after the test. */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "chaff-list-"));
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
    now: () => new Date("2026-10-12T00:00:00Z"),
    isTTY: false,
  };
  return { code: await runCli(ctx), stdout, stderr };
}

/** The verbose per-chat lines a table-mode run wrote to stdout. */
function verboseLines(stdout: Sink): string[] {
  return stdout
    .text()
    .split("\n")
    .filter((line) => line.startsWith("keep ") || line.startsWith("drop "));
}

//
// Tests.
//

describe("chaff list", () => {
  test("lists the account's dialogs as a table and exits 0", async () => {
    const { env } = fakeEnv();
    const { code, stdout, stderr } = await run(["list"], env);

    expect(code).toBe(EXIT.OK);
    expect(stderr.text()).toBe("");
    // The count is chatter; the table follows it. Both are on stdout, which is
    // the documented arrangement with no machine format.
    expect(stdout.text()).toContain("Found 15 chats");
    const header =
      stdout
        .text()
        .split("\n")
        .find((line) => line.includes("title")) ?? "";
    for (const column of COLUMNS) expect(header).toContain(column);
    expect(stdout.text()).toContain("Signal Room");
    expect(stdout.text()).toContain("Crypto Chat Lounge");
  });

  test("prints an object with a chats array, keys in the documented order", async () => {
    const { env } = fakeEnv();
    const { code, stdout } = await run(["list", "--json"], env);

    expect(code).toBe(EXIT.OK);
    const document = JSON.parse(stdout.text()) as { chats: Array<Record<string, unknown>> };

    expect(Object.keys(document)).toEqual(["chats"]);
    expect(document.chats.length).toBeGreaterThan(0);
    for (const chat of document.chats) expect(Object.keys(chat)).toEqual([...COLUMNS]);

    const signal = document.chats.find((chat) => chat["id"] === -1001);
    expect(signal).toEqual({
      id: -1001,
      type: "channel",
      title: "Signal Room",
      username: "signalroom",
      members: 4821,
      last: "2024-08-02T09:12:00Z",
      flags: ["muted", "unread:412", "scam"],
    });
  });

  test("--json is byte-identical between two runs: the key order is stable", async () => {
    const first = await run(["list", "--json"], fakeEnv().env);
    const second = await run(["list", "--json"], fakeEnv().env);
    expect(first.stdout.text()).toBe(second.stdout.text());
  });

  test("applies the filters every other command takes", async () => {
    const { env } = fakeEnv();
    const mute = await run(["list", "--muted", "--json"], env);
    const all = await run(["list", "--json"], env);

    const muted = JSON.parse(mute.stdout.text()) as { chats: Array<{ flags: string[] }> };
    const every = JSON.parse(all.stdout.text()) as { chats: unknown[] };

    expect(muted.chats.length).toBeGreaterThan(0);
    expect(muted.chats.length).toBeLessThan(every.chats.length);
    for (const chat of muted.chats) expect(chat.flags).toContain("muted");
  });

  test("an empty result is an empty table and an empty array", async () => {
    const { env } = fakeEnv();
    const { code, stdout } = await run(["list", "--keyword", "zzz-no-such-chat", "--json"], env);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout.text())).toEqual({ chats: [] });
  });

  test("-v shows each chat as it is processed", async () => {
    const { env } = fakeEnv();
    const { stdout } = await run(["-v", "list", "--muted"], env);

    const lines = verboseLines(stdout);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.startsWith("keep "))).toBe(true);
    expect(lines.some((line) => line.startsWith("drop "))).toBe(true);
  });

  test("--limit caps the gathering, not just the printed rows", async () => {
    // A filter that rejects everything is what makes this discriminating. The
    // fixture holds 15 dialogs; a cap applied only after gathering them all
    // would still evaluate all 15, so the per-chat lines would run past the
    // limit. Three lines means the cap reached the client's iterator.
    const { env } = fakeEnv();
    const { stdout } = await run(["-v", "list", "--limit", "3", "--keyword", "zzz-nothing"], env);

    expect(verboseLines(stdout)).toHaveLength(3);
  });

  test("--limit is visible in the accepted rows too", async () => {
    const { env } = fakeEnv();
    const { stdout } = await run(["list", "--limit", "2", "--json"], env);
    const document = JSON.parse(stdout.text()) as { chats: unknown[] };
    expect(document.chats).toHaveLength(2);
  });

  test("no session and no fake is a plain sentence and exit 3", async () => {
    const { env } = sandbox();
    const { code, stdout, stderr } = await run(["list"], env);

    expect(code).toBe(EXIT.NOT_LOGGED_IN);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("session");
    expect(stderr.text()).not.toContain("at Object.");
    expect(stderr.text().split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("a session file that exists but cannot be opened is exit 3, with no hash", async () => {
    // The other half of "Not logged in, or the session is unreadable"
    // (`plan/cli.md`, "Exit codes"): the file is there, so the missing-session
    // branch does not fire, and the credentials resolve, so the
    // missing-credentials branch does not either. What is left is a failure to
    // open the file. It has to be a *file* — `sessionExists` requires
    // `isFile()` — with contents that are not a database, so the failure is
    // local and the suite stays offline.
    const { env } = sandbox({ CHAFF_API_ID: "12345", CHAFF_API_HASH: API_HASH });
    const sessionDir = join(env.XDG_DATA_HOME as string, "chaff-tg");
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(sessionDir, "default.session"), "not a database\n".repeat(20), {
      mode: 0o600,
    });

    const { code, stdout, stderr } = await run(["list"], env);

    expect(code).toBe(EXIT.NOT_LOGGED_IN);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("could not be opened");
    expect(stderr.text()).not.toContain(API_HASH);
    expect(stderr.text()).not.toContain("at Object.");
    expect(stderr.text().split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("the api hash never reaches stdout or stderr", async () => {
    const { env } = fakeEnv({ CHAFF_API_ID: "12345", CHAFF_API_HASH: API_HASH });
    const table = await run(["-v", "list"], env);
    const json = await run(["--json", "list"], env);
    const missing = await run(["list"], sandbox({ CHAFF_API_HASH: API_HASH }).env);

    // The two fake runs have to succeed, or "no hash in the output" would hold
    // for the trivial reason that there was no output.
    expect(table.code).toBe(EXIT.OK);
    expect(json.code).toBe(EXIT.OK);
    expect(missing.code).toBe(EXIT.NOT_LOGGED_IN);
    expect(json.stdout.text()).toContain("Signal Room");

    for (const result of [table, json, missing]) {
      expect(result.stdout.text()).not.toContain(API_HASH);
      expect(result.stderr.text()).not.toContain(API_HASH);
    }
  });

  test("a fake run touches no local state: the data directory is not created", async () => {
    const { root, env } = fakeEnv();
    const { code } = await run(["list", "--json"], env);
    expect(code).toBe(EXIT.OK);
    expect(existsSync(join(root, "data"))).toBe(false);
  });

  test("a config file is not needed for the fake path", async () => {
    const { root, env } = fakeEnv();
    const configDir = join(root, "config", "chaff-tg");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "{ this is not json");

    const { code } = await run(["list"], env);
    expect(code).toBe(EXIT.OK);
  });
});
