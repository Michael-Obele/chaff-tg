/**
 * The resume journal: bun:sqlite, one row per planned chat
 * (plan/architecture.md, "Session and journal"; plan/safety.md, "Local
 * privileges and files").
 *
 * Contract under test:
 * - `startRun` takes the planned chats and seeds every one of them `pending`
 *   in the same transaction as the `runs` row, so a run cannot exist with
 *   zero pending rows through caller omission.
 * - Crash halfway -> `latestUnfinished()` still returns the run and
 *   `pending()` returns every untouched chat exactly once, with the ones
 *   already marked `left`/`failed`/`skipped` absent.
 * - `latestUnfinished()` is the newest run that is unfinished *and* still has
 *   a `pending` row: a run whose chats were all acted on is not offered.
 * - Marking the same `(run_id, chat_id)` twice updates the single row; it
 *   never inserts a second one, and the run's counters do not double count.
 * - `finishRun` sets `finished_at`; an unfinished run has it `NULL`, and
 *   `latestUnfinished()` ignores finished runs.
 * - The file is created mode 600 and its parent directory mode 700.
 * - Timestamps come from the injected clock, so every assertion here is
 *   deterministic and no test reads the wall clock.
 * - Every test works in a fresh temp directory; nothing touches
 *   `~/.local/share/chaff-tg`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type RunRow } from "../src/core/journal";
import * as core from "../src/core/index";

/** Every temp root this file created, removed in `afterAll`. */
const roots: string[] = [];

/** A fresh directory under the system temp dir; never a real user path. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "chaff-journal-"));
  roots.push(root);
  return root;
}

/** A journal path in a brand new temp root. */
function tempJournalPath(): string {
  return join(tempRoot(), "journal.db");
}

/** The clock every test injects; `at`/`started_at` must equal this string. */
const FIXED_ISO = "2026-01-02T03:04:05.000Z";
const fixedClock = (): Date => new Date(FIXED_ISO);

/** The five chats a test run plans over. */
const CHATS = [
  { id: -1001, title: "Big Signals Premium" },
  { id: -1002, title: "Airdrop Farm" },
  { id: -1003, title: "Quiet Rust Group" },
  { id: -1004, title: "Old Study Chat" },
  { id: -1005, title: "News Dump" },
];

/** The serialized filters the journal stores verbatim, never re-interpreted. */
const FILTERS_JSON = '{"keyword":["signal"],"exclude":[-1005]}';

/**
 * Start a run over the first `planned` chats. `startRun` seeds every one of
 * them `pending` itself, in one commit with the `runs` row, so there is no
 * caller-side seeding loop here that a caller could forget.
 */
function startedRun(j: Journal, planned = 5): number {
  return j.startRun("leave", FILTERS_JSON, CHATS.slice(0, planned));
}

/** Row count in `actions`, read with a second connection (white box). */
function actionRows(path: string): number {
  const raw = new Database(path, { readonly: true });
  const row = raw.query("select count(*) as n from actions").get() as { n: number };
  raw.close();
  return row.n;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("journal file and directory modes", () => {
  test("creates the parent directory 700 and the database file 600", () => {
    const dir = join(tempRoot(), "nested", "deep");
    const path = join(dir, "journal.db");
    const j = Journal.open(path, fixedClock);
    j.close();

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The rule is about where the file lands: never the real user data dir.
    expect(path.startsWith(tmpdir())).toBe(true);
  });

  test("an existing directory keeps its mode and the file is never truncated", () => {
    const path = tempJournalPath();
    const first = Journal.open(path, fixedClock);
    startedRun(first);
    first.close();

    // Reopening the same path must not wipe what is already in it.
    const second = Journal.open(path, fixedClock);
    expect(second.pending(1)).toHaveLength(5);
    second.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("startRun and listRuns", () => {
  test("startRun returns the new id and listRuns reports the run's shape", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const runId = startedRun(j);

    expect(runId).toBe(1);
    expect(j.listRuns()).toEqual([
      {
        id: 1,
        startedAt: FIXED_ISO,
        finishedAt: null,
        mode: "leave",
        planned: 5,
        left: 0,
        failed: 0,
      } satisfies RunRow,
    ]);
    j.close();
  });

  test("listRuns is ordered by id, oldest first, and counts derive from actions", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const first = startedRun(j);
    j.finishRun(first);

    const second = j.startRun("dry-run", FILTERS_JSON, CHATS.slice(0, 2));
    j.mark(second, CHATS[0]!, "left");
    j.mark(second, CHATS[1]!, "failed", "FLOOD_WAIT_90");

    const runs = j.listRuns();
    expect(runs.map((r) => r.id)).toEqual([1, 2]);
    expect(runs[0]!.mode).toBe("leave");
    expect(runs[1]!).toEqual({
      id: 2,
      startedAt: FIXED_ISO,
      finishedAt: null,
      mode: "dry-run",
      planned: 2,
      left: 1,
      failed: 1,
    } satisfies RunRow);
    j.close();
  });

  test("listRuns is empty on a fresh journal", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    expect(j.listRuns()).toEqual([]);
    expect(j.latestUnfinished()).toBeNull();
    j.close();
  });

  test("startRun seeds every planned chat pending, in plan order, as rows", () => {
    const path = tempJournalPath();
    const j = Journal.open(path, fixedClock);
    const runId = j.startRun("leave", FILTERS_JSON, CHATS);

    expect(j.listRuns()[0]!.planned).toBe(5);
    expect(j.pending(runId)).toEqual(CHATS.map((chat) => ({ id: chat.id, title: chat.title })));
    // The rows are really on disk, not only in the accessor's cache.
    expect(actionRows(path)).toBe(5);
    j.close();
  });

  test("a run row never lands without its pending rows (one transaction)", () => {
    const path = tempJournalPath();
    const j = Journal.open(path, fixedClock);
    // `chat_id` is NOT NULL, so seeding this chat fails mid-way through the
    // seed loop. Because the seed is one transaction with the run insert, the
    // whole thing rolls back: no run can exist whose pending() is silently [].
    expect(() =>
      j.startRun("leave", FILTERS_JSON, [{ id: null as unknown as number, title: "bad" }]),
    ).toThrow();
    expect(j.listRuns()).toEqual([]);
    expect(actionRows(path)).toBe(0);
    expect(j.latestUnfinished()).toBeNull();
    j.close();
  });
});

describe("crash halfway and resume", () => {
  test("an interrupted run keeps every untouched chat pending, exactly once", () => {
    const path = tempJournalPath();
    const before = Journal.open(path, fixedClock);
    const runId = startedRun(before);

    // Two leaves landed, then the process died: no finishRun.
    before.mark(runId, CHATS[0]!, "left");
    before.mark(runId, CHATS[1]!, "left");
    before.close();

    const after = Journal.open(path, fixedClock);
    expect(after.latestUnfinished()).toMatchObject({ id: runId, finishedAt: null, left: 2 });
    expect(after.pending(runId)).toEqual([
      { id: -1003, title: "Quiet Rust Group" },
      { id: -1004, title: "Old Study Chat" },
      { id: -1005, title: "News Dump" },
    ]);
    // "exactly once": no duplicates in the resume set.
    const ids = after.pending(runId).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    after.close();
  });

  test("left, failed and skipped chats are all absent from pending", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const runId = startedRun(j);
    j.mark(runId, CHATS[0]!, "left");
    j.mark(runId, CHATS[1]!, "failed", "network down");
    j.mark(runId, CHATS[2]!, "skipped", "CHANNEL_PRIVATE");

    expect(j.pending(runId).map((c) => c.id)).toEqual([-1004, -1005]);
    expect(j.listRuns()[0]!.left).toBe(1);
    expect(j.listRuns()[0]!.failed).toBe(1);
    j.close();
  });

  test("pending is empty for an unknown run", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    expect(j.pending(404)).toEqual([]);
    j.close();
  });

  test("resume after reopen: mark the remainder, then the run is not offered", () => {
    const path = tempJournalPath();
    const before = Journal.open(path, fixedClock);
    const runId = before.startRun("leave", FILTERS_JSON, CHATS);
    before.mark(runId, CHATS[0]!, "left");
    before.mark(runId, CHATS[1]!, "left");
    before.close();

    // The real resume path: open the existing file and finish the run's work.
    const after = Journal.open(path, fixedClock);
    expect(after.latestUnfinished()!.id).toBe(runId);
    expect(after.pending(runId).map((c) => c.id)).toEqual([-1003, -1004, -1005]);

    for (const chat of after.pending(runId)) after.mark(runId, chat, "left");
    expect(after.pending(runId)).toEqual([]);
    expect(after.listRuns()[0]!.left).toBe(5);

    // Unfinished but complete: no pending row, so no confusing no-op offer.
    expect(after.listRuns()[0]!.finishedAt).toBeNull();
    expect(after.latestUnfinished()).toBeNull();

    after.finishRun(runId);
    expect(after.latestUnfinished()).toBeNull();
    expect(after.listRuns()[0]!.finishedAt).toBe(FIXED_ISO);
    after.close();
  });
});

describe("idempotent marking", () => {
  test("marking the same chat twice updates the single row", () => {
    const path = tempJournalPath();
    const j = Journal.open(path, fixedClock);
    const runId = startedRun(j, 2);

    j.mark(runId, CHATS[0]!, "pending");
    j.mark(runId, CHATS[0]!, "left");
    // A retry of the same leave must not add a row.
    j.mark(runId, CHATS[0]!, "left");

    expect(actionRows(path)).toBe(2); // the two planned chats, not three
    expect(j.pending(runId).map((c) => c.id)).toEqual([-1002]);
    expect(j.listRuns()[0]!.left).toBe(1); // derived, so no double count
    j.close();
  });

  test("a later state wins and the title and error are refreshed", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const runId = startedRun(j, 1);

    j.mark(runId, { id: -1001, title: "stale title" }, "pending");
    j.mark(runId, CHATS[0]!, "failed", "PEER_FLOOD");

    expect(j.pending(runId)).toEqual([]);
    expect(j.listRuns()[0]!.failed).toBe(1);
    j.close();
  });

  test("re-marking a failed chat as left moves it between counters", () => {
    const path = tempJournalPath();
    const j = Journal.open(path, fixedClock);
    const runId = startedRun(j, 1);

    j.mark(runId, CHATS[0]!, "failed", "network down");
    expect(j.listRuns()[0]!.failed).toBe(1);
    j.mark(runId, CHATS[0]!, "left");

    expect(j.listRuns()[0]!.left).toBe(1);
    expect(j.listRuns()[0]!.failed).toBe(0);
    expect(actionRows(path)).toBe(1);
    j.close();
  });

  test("mark moves a seeded chat straight to left, leaving the rest pending", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const runId = startedRun(j);
    j.mark(runId, CHATS[4]!, "left");
    expect(j.listRuns()[0]!.left).toBe(1);
    expect(j.pending(runId).map((c) => c.id)).toEqual([-1001, -1002, -1003, -1004]);
    j.close();
  });
});

describe("finishRun and latestUnfinished", () => {
  test("an unfinished run has finished_at NULL and finishRun sets it", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const runId = startedRun(j);
    expect(j.listRuns()[0]!.finishedAt).toBeNull();

    j.finishRun(runId);
    expect(j.listRuns()[0]!.finishedAt).toBe(FIXED_ISO);
    expect(j.latestUnfinished()).toBeNull();
    j.close();
  });

  test("latestUnfinished ignores finished runs and picks the newest unfinished one", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const first = startedRun(j);
    j.finishRun(first);

    const second = startedRun(j);
    expect(j.latestUnfinished()!.id).toBe(second);

    const third = j.startRun("dry-run", FILTERS_JSON, CHATS.slice(0, 1));
    expect(j.latestUnfinished()!.id).toBe(third);
    expect(j.latestUnfinished()!.mode).toBe("dry-run");
    j.close();
  });

  test("latestUnfinished skips an unfinished run that has no pending rows", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const runId = startedRun(j);
    // Every chat was acted on, then the process died before finishRun: the run
    // is unfinished but there is nothing left to resume, so it is not offered.
    for (const chat of j.pending(runId)) j.mark(runId, chat, "left");

    expect(j.listRuns()[0]!.finishedAt).toBeNull();
    expect(j.pending(runId)).toEqual([]);
    expect(j.latestUnfinished()).toBeNull();

    // A newer run that still has work is offered again.
    const second = startedRun(j, 2);
    expect(j.latestUnfinished()!.id).toBe(second);
    j.close();
  });

  test("a finished run makes its leftover pending chats invisible to resume", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const runId = startedRun(j);
    j.mark(runId, CHATS[0]!, "left");
    j.finishRun(runId);

    // The rows are still there for `journal --run`, but resume will not offer
    // a run the user already ended.
    expect(j.pending(runId)).toHaveLength(4);
    expect(j.latestUnfinished()).toBeNull();
    j.close();
  });
});

describe("latestStates across runs", () => {
  test("reports each chat's state from its newest run, whatever that run's status", () => {
    const j = Journal.open(tempJournalPath(), fixedClock);
    const first = startedRun(j, 3);
    j.mark(first, CHATS[0]!, "left");
    j.mark(first, CHATS[1]!, "failed", "boom");
    j.finishRun(first);

    // A newer run over one of the same chats: its verdict is the latest one,
    // even though the older run is the one that carries the other states.
    const second = j.startRun("leave", FILTERS_JSON, CHATS.slice(0, 1));
    j.mark(second, CHATS[0]!, "left");
    j.finishRun(second);

    // One row per chat, in the order the ids were asked for. `pending` is a
    // state like any other here; only the *newest* run is consulted per chat.
    expect(j.latestStates(CHATS.slice(0, 3).map((c) => c.id))).toEqual([
      { id: CHATS[0]!.id, title: CHATS[0]!.title, state: "left", error: null },
      { id: CHATS[1]!.id, title: CHATS[1]!.title, state: "failed", error: "boom" },
      { id: CHATS[2]!.id, title: CHATS[2]!.title, state: "pending", error: null },
    ]);

    // A chat with no recorded row anywhere is absent, not invented.
    expect(j.latestStates([-9999])).toEqual([]);
    expect(j.latestStates([])).toEqual([]);
    j.close();
  });
});

describe("timestamps come from the injected clock", () => {
  test("every recorded instant is the injected clock's, never the wall clock", () => {
    const path = tempJournalPath();
    let tick = 0;
    const clock = (): Date => new Date(Date.UTC(2026, 0, 2, 3, 4, 5 + tick++));

    const j = Journal.open(path, clock);
    const runId = j.startRun("leave", FILTERS_JSON, CHATS.slice(0, 1));
    j.mark(runId, CHATS[0]!, "left");
    j.finishRun(runId);

    const run = j.listRuns()[0]!;
    expect(run.startedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(run.finishedAt).toBe("2026-01-02T03:04:07.000Z");

    const raw = new Database(path, { readonly: true });
    const action = raw
      .query("select at from actions where run_id = ? and chat_id = ?")
      .get(runId, CHATS[0]!.id) as {
      at: string;
    };
    raw.close();
    expect(action.at).toBe("2026-01-02T03:04:06.000Z");
    j.close();
  });
});

describe("the core barrel", () => {
  test("exports the journal surface", () => {
    expect(core.Journal).toBe(Journal);
  });
});
