/**
 * The leave loop: the one function both front ends call
 * (plan/architecture.md, "The TUI seam"; plan/cli.md, "Selection and pacing").
 *
 * Contract under test:
 * - Without `yes` nothing is left, nothing is journalled, nothing is slept:
 *   `onProgress` gets one `pending` line per planned chat and the result is all
 *   zeros. A dry run writes no `runs` row at all, because a row would either
 *   show up in `chaff journal` as a run that never happened or make
 *   `latestUnfinished()` offer to resume it.
 * - Every chat that advances is marked in the journal as it happens, so a run
 *   that stops can be continued. A resume continues the *same* `runs` row, skips
 *   the chats already `left`/`failed`/`skipped` (reporting their recorded state
 *   instead of touching them again), and leaves exactly the remainder.
 * - `flood-long` / `peer-flood` stop the run at once: the wait is reported, the
 *   chat is not retried, and the chat plus everything after it stays `pending`.
 * - `flood-short` sleeps for the reported seconds and retries once.
 * - `skippable` marks the chat `skipped` and keeps going.
 * - `network` retries twice with backoff, then records the failure and continues.
 * - `unknown` records the failure and stops, unless `force`.
 * - A cap (`maxLeave`) cuts the run short and says so with `capped: true`.
 * - An abort finishes the chat in flight (journalling it only if it was really
 *   left) and claims `aborted: true`; nothing in flight is ever claimed as left.
 * - `sleep` and `random` are injected, so no test here waits on real time.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/core";
import { Journal } from "../src/core/journal";
import type { LeaveOptions, Progress } from "../src/core/leave";
import type { Filters, Plan, PlanChat } from "../src/core/types";
import { FakeClient, fakeRpcError } from "./fake-client";

/** Every temp root this file created, removed in `afterAll`. */
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fresh directory under the system temp dir; never a real user path. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chaff-leave-"));
  roots.push(dir);
  return dir;
}

/** The clock every test injects. */
const FIXED_ISO = "2026-01-02T03:04:05.000Z";
const fixedClock = (): Date => new Date(FIXED_ISO);

/** One accepted plan row with every non-filtered field at a boring default. */
function chat(id: number, title: string): PlanChat {
  return {
    id,
    type: "channel",
    title,
    username: null,
    members: null,
    muted: null,
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
    why: ["keyword:signal"],
  };
}

/** The five chats every run here plans over, in plan order. */
const CHATS: PlanChat[] = [
  chat(-1001, "Big Signals Premium"),
  chat(-1002, "Airdrop Farm"),
  chat(-1003, "Quiet Rust Group"),
  chat(-1004, "Old Study Chat"),
  chat(-1005, "News Dump"),
];

/** Every filter unset: the leave loop never re-filters, it only journals them. */
const NO_FILTERS: Filters = {
  types: null,
  keyword: [],
  any: [],
  not: [],
  regex: null,
  ids: null,
  muted: null,
  archived: null,
  inactiveDays: null,
  members: null,
  scam: false,
  fake: false,
  banned: false,
  unavailable: false,
  unread: null,
  pinned: null,
  include: [],
  exclude: [],
  limit: null,
};

function planOf(chats: PlanChat[] = CHATS): Plan {
  return {
    version: 1,
    createdAt: FIXED_ISO,
    account: { id: 1, username: "chaff_tester" },
    filters: structuredClone(NO_FILTERS),
    summary: { matched: chats.length, estimatedSeconds: chats.length },
    chats,
  };
}

/** Records every `sleep(ms)` and returns at once. It never waits. */
interface Recorder {
  readonly sleeps: number[];
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function recordingSleep(): Recorder {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

/**
 * The options every test starts from: a real run, no cap, no pause, a
 * deterministic `random` (so a delay is exactly `delayMs`), and an injected
 * sleep. Individual tests override what they care about.
 */
function options(recorder: Recorder, over: Partial<LeaveOptions> = {}): LeaveOptions {
  return {
    yes: true,
    maxLeave: 0,
    delayMs: 0,
    clear: false,
    force: false,
    journal: null,
    random: () => 0.5,
    sleep: recorder.sleep,
    ...over,
  };
}

function openJournal(): Journal {
  return Journal.open(join(tempDir(), "journal.db"), fixedClock);
}

/** The progress stream as a compact `state:chatId` transcript. */
function transcript(progress: Progress[]): string[] {
  return progress.map((p) => `${p.state}:${p.chatId}`);
}

/** The recorded state of every action row, as `state:chatId`. */
function journalTranscript(journal: Journal, runId: number): string[] {
  return journal.actions(runId).map((row) => `${row.state}:${row.id}`);
}

describe("the barrel", () => {
  test("exposes runLeave alongside the pacer and the taxonomy", () => {
    expect(typeof core.runLeave).toBe("function");
    expect(typeof core.Pacer).toBe("function");
    expect(typeof core.classify).toBe("function");
  });
});

describe("dry run (no `yes`)", () => {
  test("reports every chat pending, records nothing, and never touches the account or the journal", async () => {
    const client = new FakeClient();
    const journal = openJournal();
    const recorder = recordingSleep();
    const progress: Progress[] = [];

    const result = await core.runLeave(
      client,
      planOf(),
      options(recorder, { yes: false, journal }),
      (p) => progress.push(p),
    );

    expect(transcript(progress)).toEqual([
      "pending:-1001",
      "pending:-1002",
      "pending:-1003",
      "pending:-1004",
      "pending:-1005",
    ]);
    expect(progress.map((p) => [p.index, p.total])).toEqual([
      [0, 5],
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
    ]);
    expect(progress[0]!.title).toBe("Big Signals Premium");

    expect(client.attempts).toEqual([]);
    expect(client.left).toEqual([]);
    expect(recorder.sleeps).toEqual([]);

    expect(result).toEqual({
      planned: 5,
      left: 0,
      failed: 0,
      skipped: 0,
      aborted: false,
      capped: false,
      floodWaitSeconds: null,
      failures: [],
    });

    // `open` created the file and the schema, but the run wrote no row.
    expect(journal.listRuns()).toEqual([]);
    journal.close();
  });
});

describe("a real run", () => {
  test("leaves 3 of 5, records 2 failures forced past, and journals every chat as it happens", async () => {
    const client = new FakeClient({
      failures: [
        { chatId: -1002, error: fakeRpcError("USER_NOT_PARTICIPANT") },
        { chatId: -1004, error: fakeRpcError("USER_NOT_PARTICIPANT") },
      ],
    });
    const journal = openJournal();
    const recorder = recordingSleep();
    const progress: Progress[] = [];

    const result = await core.runLeave(
      client,
      planOf(),
      options(recorder, { journal, force: true, delayMs: 1200 }),
      (p) => progress.push(p),
    );

    expect(transcript(progress)).toEqual([
      "left:-1001",
      "failed:-1002",
      "left:-1003",
      "failed:-1004",
      "left:-1005",
    ]);
    expect(progress.map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
    expect(progress.every((p) => p.total === 5)).toBe(true);

    expect(client.left).toEqual([-1001, -1003, -1005]);
    expect(client.attempts).toHaveLength(5);
    expect(client.attempts[0]!.params).toEqual({ clear: false });

    expect(result.planned).toBe(5);
    expect(result.left).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.aborted).toBe(false);
    expect(result.capped).toBe(false);
    expect(result.floodWaitSeconds).toBeNull();
    expect(result.failures.map((f) => f.chatId)).toEqual([-1002, -1004]);
    expect(result.failures.map((f) => f.title)).toEqual(["Airdrop Farm", "Old Study Chat"]);
    expect(result.failures[0]!.error).toContain("USER_NOT_PARTICIPANT");

    // One jittered pause per chat, at the injected `random` exactly on the base.
    expect(recorder.sleeps).toEqual([1200, 1200, 1200, 1200, 1200]);

    const runs = journal.listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.mode).toBe("leave");
    expect(run.planned).toBe(5);
    expect(run.left).toBe(3);
    expect(run.failed).toBe(2);
    expect(journalTranscript(journal, run.id)).toEqual([
      "left:-1001",
      "failed:-1002",
      "left:-1003",
      "failed:-1004",
      "left:-1005",
    ]);
    expect(journal.pending(run.id)).toEqual([]);
    expect(run.finishedAt).toBe(FIXED_ISO);
    journal.close();
  });
});

describe("flood stops", () => {
  test("a long flood stops the run, reports the wait, and leaves the rest pending", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1002, error: fakeRpcError("FLOOD_WAIT_90") }],
    });
    const journal = openJournal();
    const recorder = recordingSleep();
    const progress: Progress[] = [];

    const result = await core.runLeave(
      client,
      planOf(),
      options(recorder, { journal, delayMs: 1200 }),
      (p) => progress.push(p),
    );

    expect(result.floodWaitSeconds).toBe(90);
    expect(result.left).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.aborted).toBe(false);
    expect(result.capped).toBe(false);
    expect(result.failures).toEqual([]);

    // Attempted once, never retried, and never slept through.
    expect(client.attempts.map((a) => a.chatId)).toEqual([-1001, -1002]);
    expect(recorder.sleeps).toEqual([1200, 1200]);
    expect(transcript(progress)).toEqual(["left:-1001"]);

    const run = journal.listRuns()[0]!;
    expect(journal.pending(run.id).map((c) => c.id)).toEqual([-1002, -1003, -1004, -1005]);
    expect(run.finishedAt).toBeNull();
    journal.close();
  });

  test("a peer flood is the same hard stop, with no wait to report", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1001, error: fakeRpcError("PEER_FLOOD") }],
    });
    const journal = openJournal();

    const result = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      () => {},
    );

    expect(result.floodWaitSeconds).toBeNull();
    expect(result.left).toBe(0);
    expect(client.attempts.map((a) => a.chatId)).toEqual([-1001]);
    const run = journal.listRuns()[0]!;
    expect(journal.pending(run.id)).toHaveLength(5);
    journal.close();
  });

  test("a short flood sleeps it out and retries the chat exactly once", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1001, error: fakeRpcError("FLOOD_WAIT_30") }],
    });
    const journal = openJournal();
    const recorder = recordingSleep();
    const progress: Progress[] = [];

    const result = await core.runLeave(client, planOf(), options(recorder, { journal }), (p) =>
      progress.push(p),
    );

    expect(client.attempts.map((a) => a.chatId)).toEqual([
      -1001, -1001, -1002, -1003, -1004, -1005,
    ]);
    expect(recorder.sleeps).toContain(30000);
    expect(result.left).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    // A wait that was survived is not a stop, so the run's exit stays clean.
    expect(result.floodWaitSeconds).toBeNull();
    expect(progress[0]!.state).toBe("left");
    expect(progress[0]!.error).toContain("30");
    journal.close();
  });

  test("a short flood that repeats after the one retry stops the run", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1002, error: fakeRpcError("FLOOD_WAIT_30"), times: 2 }],
    });
    const journal = openJournal();
    const recorder = recordingSleep();

    const result = await core.runLeave(client, planOf(), options(recorder, { journal }), () => {});

    expect(result.floodWaitSeconds).toBe(30);
    expect(client.attempts.map((a) => a.chatId)).toEqual([-1001, -1002, -1002]);
    expect(recorder.sleeps.filter((ms) => ms === 30000)).toHaveLength(1);
    const run = journal.listRuns()[0]!;
    expect(journal.pending(run.id).map((c) => c.id)).toEqual([-1002, -1003, -1004, -1005]);
    journal.close();
  });
});

describe("resume", () => {
  test("a resumed run continues the same run row, skips what is already settled, and leaves exactly the rest", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1002, error: fakeRpcError("FLOOD_WAIT_90") }],
    });
    const journal = openJournal();

    const first = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(first.left).toBe(1);
    expect(first.floodWaitSeconds).toBe(90);
    const runId = journal.listRuns()[0]!.id;

    const progress: Progress[] = [];
    const second = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      (p) => progress.push(p),
    );

    // -1002 is tried again because the flood left it pending; -1001 is not.
    expect(client.attempts.map((a) => a.chatId)).toEqual([
      -1001, -1002, -1002, -1003, -1004, -1005,
    ]);
    expect(client.left).toEqual([-1001, -1002, -1003, -1004, -1005]);

    // Everything already left is reported as left, not skipped or re-attempted.
    expect(transcript(progress)).toEqual([
      "left:-1001",
      "left:-1002",
      "left:-1003",
      "left:-1004",
      "left:-1005",
    ]);
    expect(second.planned).toBe(5);
    expect(second.left).toBe(5);
    expect(second.failed).toBe(0);
    expect(second.aborted).toBe(false);

    const runs = journal.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.left).toBe(5);
    expect(runs[0]!.finishedAt).toBe(FIXED_ISO);
    expect(journal.pending(runId)).toEqual([]);
    journal.close();
  });

  test("a chat a previous run failed is reported failed, not retried", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1002, error: fakeRpcError("USER_NOT_PARTICIPANT") }],
    });
    const journal = openJournal();

    // The unrecognised failure stops the first run: -1001 is left, -1002 is
    // failed, and the rest never got their turn.
    const first = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(first.left).toBe(1);
    expect(first.failed).toBe(1);

    const progress: Progress[] = [];
    const second = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      (p) => progress.push(p),
    );

    // The failed chat is reported again but never attempted again.
    expect(client.attempts.map((a) => a.chatId)).toEqual([-1001, -1002, -1003, -1004, -1005]);
    expect(transcript(progress)).toEqual([
      "left:-1001",
      "failed:-1002",
      "left:-1003",
      "left:-1004",
      "left:-1005",
    ]);
    expect(second.left).toBe(4);
    expect(second.failed).toBe(1);
    expect(second.failures.map((f) => f.chatId)).toEqual([-1002]);
    expect(second.failures[0]!.error).toContain("USER_NOT_PARTICIPANT");
    journal.close();
  });

  test("a plan that is not the unfinished run's plan starts its own run and leaves the old one alone", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1002, error: fakeRpcError("FLOOD_WAIT_90") }],
    });
    const journal = openJournal();

    // Run A plans the first four chats and stops on the flood at -1002.
    const first = await core.runLeave(
      client,
      planOf(CHATS.slice(0, 4)),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(first.planned).toBe(4);
    expect(first.left).toBe(1);
    const runA = journal.listRuns()[0]!;
    expect(journalTranscript(journal, runA.id)).toEqual([
      "left:-1001",
      "pending:-1002",
      "pending:-1003",
      "pending:-1004",
    ]);

    // A chat run A never planned must not be folded into run A: that would
    // append a row the run did not plan and leave its own chats unfinishable.
    const second = await core.runLeave(
      client,
      planOf([chat(-2001, "Fresh Find")]),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(second.planned).toBe(1);
    expect(second.left).toBe(1);

    const runs = journal.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.id).toBe(runA.id);
    expect(runs[0]!.planned).toBe(4);
    expect(runs[0]!.left).toBe(1);
    expect(runs[0]!.finishedAt).toBeNull();
    expect(journalTranscript(journal, runA.id)).toEqual([
      "left:-1001",
      "pending:-1002",
      "pending:-1003",
      "pending:-1004",
    ]);
    expect(journal.pending(runA.id).map((c) => c.id)).toEqual([-1002, -1003, -1004]);
    expect(journalTranscript(journal, runs[1]!.id)).toEqual(["left:-2001"]);
    journal.close();
  });

  test("a rerun of a finished plan touches no chat and reports every one as already settled", async () => {
    const journal = openJournal();
    const first = new FakeClient();
    const done = await core.runLeave(
      first,
      planOf(),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(done.left).toBe(5);
    expect(journal.listRuns()[0]!.finishedAt).toBe(FIXED_ISO);

    // The same plan again: the journal already says every chat was left, so
    // nothing may be left a second time. The chats are still reported.
    const again = new FakeClient();
    const recorder = recordingSleep();
    const progress: Progress[] = [];
    const second = await core.runLeave(again, planOf(), options(recorder, { journal }), (p) =>
      progress.push(p),
    );

    expect(again.attempts).toEqual([]);
    expect(recorder.sleeps).toEqual([]);
    expect(transcript(progress)).toEqual([
      "left:-1001",
      "left:-1002",
      "left:-1003",
      "left:-1004",
      "left:-1005",
    ]);
    expect(second.left).toBe(5);
    expect(second.failed).toBe(0);

    const runs = journal.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.planned).toBe(5);
    expect(runs[1]!.left).toBe(5);
    expect(runs[1]!.finishedAt).toBe(FIXED_ISO);
    expect(journalTranscript(journal, runs[1]!.id)).toEqual([
      "left:-1001",
      "left:-1002",
      "left:-1003",
      "left:-1004",
      "left:-1005",
    ]);
    journal.close();
  });

  test("a chat left while surviving a short flood is re-reported on resume without an error", async () => {
    const client = new FakeClient({
      failures: [
        { chatId: -1001, error: fakeRpcError("FLOOD_WAIT_30") },
        { chatId: -1002, error: fakeRpcError("FLOOD_WAIT_90") },
      ],
    });
    const journal = openJournal();

    const first = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(first.left).toBe(1);
    expect(first.floodWaitSeconds).toBe(90);

    // The wait that was survived is a note, not a failure: `error` is for
    // `failed`/`skipped` rows only.
    const runId = journal.listRuns()[0]!.id;
    const leftRow = journal.actions(runId).find((row) => row.id === -1001)!;
    expect(leftRow.state).toBe("left");
    expect(leftRow.error).toBeNull();

    const progress: Progress[] = [];
    await core.runLeave(client, planOf(), options(recordingSleep(), { journal }), (p) =>
      progress.push(p),
    );

    const resumedLeft = progress.find((p) => p.chatId === -1001)!;
    expect(resumedLeft.state).toBe("left");
    expect(resumedLeft.error).toBeUndefined();
    journal.close();
  });

  test("an unfinished run's stale pending seed does not hide a chat an earlier run already left", async () => {
    const journal = openJournal();

    // Run 0 leaves -1001 and finishes.
    const run0 = await core.runLeave(
      new FakeClient(),
      planOf([chat(-1001, "Already Gone")]),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(run0.left).toBe(1);
    expect(journal.listRuns()[0]!.finishedAt).toBe(FIXED_ISO);

    // Run 1 plans a chat that floods, plus -1001. It breaks before reaching
    // -1001, so that chat's *seed* stays pending and is newer than run 0's
    // `left` -- a seed is not a verdict and must not un-settle the chat.
    const flooding = new FakeClient({
      failures: [{ chatId: -2001, error: fakeRpcError("FLOOD_WAIT_90") }],
    });
    const run1 = await core.runLeave(
      flooding,
      planOf([chat(-2001, "Fresh Find"), chat(-1001, "Already Gone")]),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(run1.left).toBe(0);
    expect(run1.floodWaitSeconds).toBe(90);

    // Run 2 continues run 1: -2001 is left, -1001 is already settled and must
    // never be left a second time.
    const client = new FakeClient();
    const progress: Progress[] = [];
    const run2 = await core.runLeave(
      client,
      planOf([chat(-2001, "Fresh Find"), chat(-1001, "Already Gone")]),
      options(recordingSleep(), { journal }),
      (p) => progress.push(p),
    );

    expect(client.attempts.map((a) => a.chatId)).toEqual([-2001]);
    expect(client.left).toEqual([-2001]);
    expect(transcript(progress)).toEqual(["left:-2001", "left:-1001"]);
    expect(run2.left).toBe(2);
    journal.close();
  });

  test("a run-local failure does not outrank a newer run's leave", async () => {
    const journal = openJournal();

    // Run 0 fails -1 (unrecognised -> stop) and never reaches -2.
    const failing = new FakeClient({
      failures: [{ chatId: -1, error: fakeRpcError("USER_NOT_PARTICIPANT") }],
    });
    const run0 = await core.runLeave(
      failing,
      planOf([chat(-1, "One"), chat(-2, "Two")]),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(run0.failed).toBe(1);

    // Run 1 is narrower and leaves -1 for real.
    const run1 = await core.runLeave(
      new FakeClient(),
      planOf([chat(-1, "One")]),
      options(recordingSleep(), { journal }),
      () => {},
    );
    expect(run1.left).toBe(1);

    // Run 2 continues run 0 (same chats). -1 was left since, so it is settled
    // -- reported left, not re-reported as the failure run 0 recorded.
    const client = new FakeClient();
    const progress: Progress[] = [];
    const run2 = await core.runLeave(
      client,
      planOf([chat(-1, "One"), chat(-2, "Two")]),
      options(recordingSleep(), { journal }),
      (p) => progress.push(p),
    );

    expect(transcript(progress)).toEqual(["left:-1", "left:-2"]);
    expect(run2.left).toBe(2);
    expect(run2.failed).toBe(0);
    expect(run2.failures).toEqual([]);
    expect(client.attempts.map((a) => a.chatId)).toEqual([-2]);
    journal.close();
  });
});

describe("sessions", () => {
  test("another session's leave does not settle this session's chat", async () => {
    const journal = openJournal();
    const plan = planOf([chat(-1001, "Shared Chat")]);

    const a = await core.runLeave(
      new FakeClient(),
      plan,
      options(recordingSleep(), { journal, session: "account-a" }),
      () => {},
    );
    expect(a.left).toBe(1);
    expect(journal.listRuns()[0]!.session).toBe("account-a");

    // Telegram chat ids are global, so the same id under another account is a
    // chat that account has not left: it must be attempted, not folded away.
    const client = new FakeClient();
    const progress: Progress[] = [];
    const b = await core.runLeave(
      client,
      plan,
      options(recordingSleep(), { journal, session: "account-b" }),
      (p) => progress.push(p),
    );
    expect(client.attempts.map((x) => x.chatId)).toEqual([-1001]);
    expect(b.left).toBe(1);
    expect(transcript(progress)).toEqual(["left:-1001"]);
    expect(journal.listRuns().map((run) => run.session)).toEqual(["account-a", "account-b"]);
    journal.close();
  });

  test("only the session that opened an unfinished run may continue it", async () => {
    const journal = openJournal();
    const flooding = new FakeClient({
      failures: [{ chatId: -1002, error: fakeRpcError("FLOOD_WAIT_90") }],
    });
    const a = await core.runLeave(
      flooding,
      planOf(),
      options(recordingSleep(), { journal, session: "account-a" }),
      () => {},
    );
    expect(a.floodWaitSeconds).toBe(90);

    // Account B must open its own run rather than write into account A's.
    const client = new FakeClient();
    const b = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal, session: "account-b" }),
      () => {},
    );
    expect(client.attempts.map((x) => x.chatId)).toEqual([-1001, -1002, -1003, -1004, -1005]);
    expect(b.left).toBe(5);
    expect(journal.listRuns().map((run) => run.session)).toEqual(["account-a", "account-b"]);
    journal.close();
  });
});

describe("a plan with a duplicate chat id", () => {
  test("is deduped before anything happens, so a chat is never left twice in one run", async () => {
    const journal = openJournal();
    const duplicated = planOf([chat(-1001, "Twice"), chat(-1001, "Twice")]);

    const client = new FakeClient();
    const progress: Progress[] = [];
    const result = await core.runLeave(
      client,
      duplicated,
      options(recordingSleep(), { journal }),
      (p) => progress.push(p),
    );

    expect(client.attempts.map((a) => a.chatId)).toEqual([-1001]);
    expect(result.planned).toBe(1);
    expect(result.left).toBe(1);
    expect(transcript(progress)).toEqual(["left:-1001"]);

    const run = journal.listRuns()[0]!;
    expect(run.planned).toBe(1);
    expect(run.left).toBe(1);
    expect(journalTranscript(journal, run.id)).toEqual(["left:-1001"]);
    expect(run.finishedAt).toBe(FIXED_ISO);

    // The dry run counts the same distinct chats, so `planned` is the number
    // of chats the run would touch, not the number of rows the manifest holds.
    const dryProgress: Progress[] = [];
    const dry = await core.runLeave(
      new FakeClient(),
      duplicated,
      options(recordingSleep(), { journal, yes: false }),
      (p) => dryProgress.push(p),
    );
    expect(dry.planned).toBe(1);
    expect(transcript(dryProgress)).toEqual(["pending:-1001"]);
    journal.close();
  });
});

describe("caps", () => {
  test("maxLeave cuts the run short after exactly that many leaves and says it was capped", async () => {
    const client = new FakeClient();
    const journal = openJournal();

    const result = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal, maxLeave: 2 }),
      () => {},
    );

    expect(result.capped).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.left).toBe(2);
    expect(client.left).toEqual([-1001, -1002]);
    // The third chat is never attempted, only refused.
    expect(client.attempts).toHaveLength(2);

    const run = journal.listRuns()[0]!;
    expect(journal.pending(run.id).map((c) => c.id)).toEqual([-1003, -1004, -1005]);
    expect(run.finishedAt).toBeNull();
    journal.close();
  });
});

describe("abort (Ctrl+C)", () => {
  test("finishes the chat in flight, journals it, and stops before the next one", async () => {
    const client = new FakeClient();
    const journal = openJournal();
    const controller = new AbortController();
    const progress: Progress[] = [];

    const result = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal, signal: controller.signal }),
      (p) => {
        progress.push(p);
        if (progress.length === 2) controller.abort();
      },
    );

    expect(result.aborted).toBe(true);
    expect(result.capped).toBe(false);
    expect(result.left).toBe(2);
    expect(result.failed).toBe(0);
    expect(client.left).toEqual([-1001, -1002]);
    expect(client.attempts).toHaveLength(2);

    const run = journal.listRuns()[0]!;
    expect(journal.actions(run.id).filter((row) => row.state === "left")).toHaveLength(2);
    expect(journal.pending(run.id).map((c) => c.id)).toEqual([-1003, -1004, -1005]);
    expect(run.finishedAt).toBeNull();
    journal.close();
  });

  test("an abort during the pause never claims a chat that was not left", async () => {
    const client = new FakeClient();
    const journal = openJournal();
    const controller = new AbortController();
    let pauses = 0;
    const sleep = (): Promise<void> => {
      pauses += 1;
      if (pauses === 2) controller.abort();
      return Promise.resolve();
    };

    const result = await core.runLeave(
      client,
      planOf(),
      { ...options(recordingSleep()), journal, signal: controller.signal, sleep },
      () => {},
    );

    expect(result.aborted).toBe(true);
    expect(result.left).toBe(1);
    expect(client.left).toEqual([-1001]);

    const run = journal.listRuns()[0]!;
    expect(journalTranscript(journal, run.id)).toEqual([
      "left:-1001",
      "pending:-1002",
      "pending:-1003",
      "pending:-1004",
      "pending:-1005",
    ]);
    journal.close();
  });

  test("a signal that was already aborted touches nothing at all", async () => {
    const client = new FakeClient();
    const journal = openJournal();
    const controller = new AbortController();
    controller.abort();

    const result = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal, signal: controller.signal }),
      () => {},
    );

    expect(result.aborted).toBe(true);
    expect(client.attempts).toEqual([]);
    expect(result.left).toBe(0);
    // Nothing was attempted, so no run row is left behind to resume.
    expect(journal.listRuns()).toEqual([]);
    journal.close();
  });
});

describe("the rest of the taxonomy", () => {
  test("a chat Telegram says cannot be left is marked skipped and the run continues", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1003, error: fakeRpcError("CHANNEL_PRIVATE") }],
    });
    const journal = openJournal();

    const result = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      () => {},
    );

    expect(result.skipped).toBe(1);
    expect(result.left).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);

    const run = journal.listRuns()[0]!;
    expect(journalTranscript(journal, run.id)).toEqual([
      "left:-1001",
      "left:-1002",
      "skipped:-1003",
      "left:-1004",
      "left:-1005",
    ]);
    journal.close();
  });

  test("a network failure retries twice with backoff, then records the failure and continues", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1001, error: fakeRpcError("ECONNRESET"), times: Infinity }],
    });
    const journal = openJournal();
    const recorder = recordingSleep();

    const result = await core.runLeave(client, planOf(), options(recorder, { journal }), () => {});

    expect(client.attempts.filter((a) => a.chatId === -1001)).toHaveLength(3);
    expect(recorder.sleeps.filter((ms) => ms === 1000 || ms === 2000)).toEqual([1000, 2000]);
    expect(result.failed).toBe(1);
    expect(result.left).toBe(4);
    expect(result.failures.map((f) => f.title)).toEqual(["Big Signals Premium"]);
    expect(result.failures[0]!.error).toContain("connection");
    journal.close();
  });

  test("an unrecognised failure is recorded and stops the run unless force", async () => {
    const client = new FakeClient({
      failures: [{ chatId: -1002, error: fakeRpcError("USER_NOT_PARTICIPANT") }],
    });
    const journal = openJournal();

    const result = await core.runLeave(
      client,
      planOf(),
      options(recordingSleep(), { journal }),
      () => {},
    );

    expect(result.left).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(client.attempts.map((a) => a.chatId)).toEqual([-1001, -1002]);

    const run = journal.listRuns()[0]!;
    expect(journal.pending(run.id).map((c) => c.id)).toEqual([-1003, -1004, -1005]);
    expect(run.finishedAt).toBeNull();
    journal.close();
  });
});
