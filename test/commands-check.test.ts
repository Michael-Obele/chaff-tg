/**
 * `chaff check` end to end, through `runCli`.
 *
 * The point of the command is the question a filter cannot ask: a chat that is
 * banned has no dialog left to list and no member count to filter on, so the
 * only way to answer "is this id dead" is to ask Telegram about an id the
 * account already has. Every case here drives the real dispatch path with the
 * fake client, so no socket is opened (`AGENTS.md` rule 1).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyFilters } from "../src/cli/args";
import { EXIT } from "../src/core/errors";
import { serializeManifest } from "../src/core/manifest";
import type { ChatRecord, Plan } from "../src/core/types";
import { FIXTURES, fakeEnv, run } from "./harness";

/** A hash-shaped string, distinct enough that a leak cannot hide in a match. */
const API_HASH = "0123456789abcdef0123456789abcdef";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An environment with a throwaway root this file cleans up. */
function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const { root, env: built } = fakeEnv(extra);
  roots.push(root);
  return built;
}

/** One row of the JSON document, as a user's script would read it. */
interface CheckRow {
  id: number;
  status: string;
  title: string | null;
}

/** The rows a `check --json` run printed, with the exit code that came with them. */
async function checked(
  argv: string[],
  extra: Record<string, string | undefined> = {},
): Promise<{ code: number; rows: CheckRow[] }> {
  const { code, stdout } = await run(["check", "--json", ...argv], env(extra));
  const document = JSON.parse(stdout.text()) as { chats: CheckRow[] };
  return { code, rows: document.chats };
}

const records = (await Bun.file(join(FIXTURES, "dialogs.json")).json()) as ChatRecord[];

/** The record fixture row for an id, or a chat built by hand when it has none. */
function record(id: number): ChatRecord {
  const row = records.find((chat) => chat.id === id);
  if (row !== undefined) return row;
  return {
    id,
    type: "supergroup",
    title: "Long Gone",
    username: null,
    members: null,
    muted: false,
    archived: false,
    pinned: false,
    unread: 0,
    manuallyUnread: false,
    isScam: false,
    isFake: false,
    isVerified: false,
    banned: false,
    unavailable: false,
    lastMessageAt: null,
  };
}

/** A manifest holding `ids`, written where the command can read it. */
function manifestWith(root: string, ids: number[]): string {
  const plan: Plan = {
    version: 1,
    createdAt: "2026-10-12T00:00:00.000Z",
    account: { id: 1, username: "chaff_tester" },
    filters: emptyFilters(),
    summary: { matched: ids.length, estimatedSeconds: ids.length },
    chats: ids.map((id) => ({ ...record(id), why: ["muted"] })),
  };
  const path = join(root, "cleanup.json");
  writeFileSync(path, serializeManifest(plan));
  return path;
}

describe("chaff check", () => {
  test("answers ok, banned and gone for the ids it was given, in order", async () => {
    const { code, rows } = await checked(["--id", "-1001,-1016,-9999"]);

    expect(code).toBe(EXIT.OK);
    expect(rows).toEqual([
      { id: -1001, status: "ok", title: "Signal Room" },
      { id: -1016, status: "banned", title: "Forbidden Vault" },
      { id: -9999, status: "gone", title: null },
    ]);
  });

  test("counts every verdict in the summary line", async () => {
    const { stdout } = await run(["check", "--id", "-1001,-1016,-9999"], env());
    expect(stdout.text()).toContain("Checked 3 chats: 1 ok, 1 banned, 0 unavailable, 1 gone");
  });

  test("prints a table a person can read", async () => {
    const { code, stdout } = await run(["check", "--id", "-1016"], env());
    expect(code).toBe(EXIT.OK);
    expect(stdout.text()).toContain("banned");
    expect(stdout.text()).toContain("Forbidden Vault");
  });

  test("reads the ids out of a manifest, and merges them with any --id", async () => {
    const { root, env: built } = fakeEnv();
    roots.push(root);
    const path = manifestWith(root, [-1001, -9999]);

    const { code, stdout } = await run(["check", "--json", "--from", path, "--id", "-1016"], built);
    const rows = (JSON.parse(stdout.text()) as { chats: CheckRow[] }).chats;

    expect(code).toBe(EXIT.OK);
    // The typed ids come first, then the manifest's: `--id` is the more
    // specific input, and the report keeps the order it was asked in.
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [-1016, "banned"],
      [-1001, "ok"],
      [-9999, "gone"],
    ]);
  });

  test("a manifest it cannot trust exits 2 with the diagnosis, not 1", async () => {
    const { root, env: built } = fakeEnv();
    roots.push(root);
    const path = join(root, "broken.json");
    writeFileSync(path, "{ not json");

    const { code, stderr } = await run(["check", "--from", path], built);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr.text()).toContain("not valid JSON");
  });

  test("with neither --id nor --from it refuses to guess", async () => {
    const { code, stderr } = await run(["check"], env());
    expect(code).toBe(EXIT.USAGE);
    expect(stderr.text()).toContain("needs ids");
  });

  test("no api hash on stdout or stderr", async () => {
    const { stdout, stderr } = await run(
      ["check", "--id", "-1001"],
      env({ CHAFF_API_HASH: API_HASH }),
    );
    expect(stdout.text()).not.toContain(API_HASH);
    expect(stderr.text()).not.toContain(API_HASH);
  });
});
