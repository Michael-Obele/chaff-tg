/**
 * The leave loop: the one function both front ends call
 * (plan/architecture.md, "The TUI seam"; plan/cli.md, "Selection and pacing").
 *
 * `runLeave` is the seam precisely because it owns everything that must not be
 * done twice: the pace, the cap, the retry rules, the abort signal, and the
 * journal writes. The CLI prints the progress lines; the TUI turns the same
 * callback into rows that change state. Neither of them decides anything.
 *
 * Four rules shape the code:
 *
 * - **Record as you go.** A chat is marked the moment it settles, so a run that
 *   dies halfway leaves a journal a resumed run can trust. `startRun` has
 *   already seeded every planned chat `pending` (src/core/journal.ts), so this
 *   loop only ever moves rows forward, and a `pending` row means "not done".
 * - **Resume means the same run and the same plan.** When the journal holds an
 *   unfinished run that planned exactly these chats, this continues it: the
 *   chats it already settled (`left`/`failed`/`skipped`) are skipped and
 *   *reported* with their recorded state instead of being touched again, and
 *   only its `pending` chats are attempted. A run that planned something else
 *   is left alone -- absorbing a foreign plan would append a row the run never
 *   planned and strand one of its own chats, and leaving a chat twice is the
 *   one thing the journal exists to prevent.
 * - **Never leave a chat twice, in any run.** A chat the journal has as `left`
 *   or `skipped` is settled, wherever that verdict came from, so a plan rerun
 *   after a completed run attempts nothing. The rule is monotone: a `pending`
 *   seed and a `failed` row never un-settle a chat, because a seed is not a
 *   verdict and a failure is one run's opinion of one attempt. It is scoped to
 *   the run's session, because "this account left it" is the claim the journal
 *   can support -- one journal serves every session in the data directory.
 * - **One chat, one leave, one run.** The plan is deduplicated by chat id
 *   before anything is seeded, attempted or counted, so a manifest holding the
 *   same id twice cannot leave that chat twice in one run or make the reported
 *   `planned` disagree with the rows the journal holds.
 * - **A stop is not a failure.** A flood wait, a cap and an abort all leave the
 *   chats they did not reach `pending`, and never claim a chat was left when it
 *   was not. A flood and a cap are not retried, and the run is only marked
 *   finished when nothing is left pending.
 * - **Facts, not exit codes.** This returns what happened — `failed`,
 *   `floodWaitSeconds`, `aborted`, `capped` — and the CLI turns that into an
 *   exit code (plan/cli.md, "Exit codes"). Nothing here reads the clock, prints
 *   anything, or picks a code.
 *
 * The clock-free, print-free rules are the core's (AGENTS.md rules 1-2): a
 * front end that wanted to pretend a run happened differently still could not,
 * because the only outputs are the journal writes and the callback.
 */
import { classify } from "./errors";
import {
  DEFAULT_SESSION,
  type ActionRow,
  type ActionState,
  type Journal,
  type SettledRow,
} from "./journal";
import { defaultSleep, Pacer, type PacerOptions, PacerCapError } from "./pacing";
import type { TelegramClientLike } from "./telegram";
import type { Plan, PlanChat } from "./types";

/** The state of one chat, as a front end reports it (the journal's own states). */
export type ProgressState = ActionState;

/**
 * One line of progress: a chat that reached a state, or — on a dry run — the
 * announcement of the chats the run would touch.
 *
 * Both front ends read exactly this. `index` is the chat's position in
 * `plan.chats` (0-based), so a TUI can address its own row by it and the CLI
 * can print `index + 1` of `total`.
 */
export interface Progress {
  chatId: number;
  title: string;
  /** 0-based position in `plan.chats`. */
  index: number;
  /** How many chats the plan holds. */
  total: number;
  state: ProgressState;
  /** A note worth printing: the flood wait that was survived, or the failure reason. */
  error?: string;
}

/** One failed chat, with the title the CLI prints next to the journal pointer. */
export interface LeaveFailure {
  chatId: number;
  title: string;
  /** The classified message (src/core/errors.ts): a sentence, not a stack trace. */
  error: string;
}

/**
 * What a run did, in facts.
 *
 * The counters describe the run's whole outcome, not just this invocation's
 * work: a resumed run that leaves the last three chats of five reports
 * `left: 5`, because that is what the run now says about its plan. That is the
 * number an exit code has to be derived from ("some leaves failed" is about the
 * run, not about the process that happened to finish it).
 */
export interface RunResult {
  /** How many chats the run set out to touch (`plan.chats.length`). */
  planned: number;
  /** Chats now marked `left` in the run, including ones settled earlier. */
  left: number;
  /** Chats now marked `failed`, including ones recorded earlier. */
  failed: number;
  /** Chats Telegram said cannot be left, or that were already skipped. */
  skipped: number;
  /** The run stopped because the signal aborted. */
  aborted: boolean;
  /** The run stopped because `maxLeave` was reached. */
  capped: boolean;
  /** Seconds to wait when a flood stopped the run; `null` when none did. */
  floodWaitSeconds: number | null;
  /** Every recorded failure, in plan order. */
  failures: LeaveFailure[];
}

/** Everything the leave loop needs from its caller (plan/cli.md flags). */
export interface LeaveOptions {
  /** `--yes`: without it this is a dry run and nothing is touched. */
  yes: boolean;
  /** `--max-leave`: the hard cap; `0` means no cap (the pacer's own rule). */
  maxLeave: number;
  /** `--delay`: the base pause between leaves, in milliseconds. */
  delayMs: number;
  /** `--clear`: clear the history too when leaving a legacy group. */
  clear: boolean;
  /** `--force`: keep going past an unrecognised error. Never past a flood. */
  force: boolean;
  /** Where to record the run; `null` runs without a journal. */
  journal: Journal | null;
  /**
   * The session (the account) these leaves belong to.
   *
   * One journal serves every session in the data directory and Telegram chat
   * ids are global, so a chat account A left says nothing about account B. The
   * cross-run settled fold is scoped to this name, and so is the run this
   * invocation may continue; `DEFAULT_SESSION` is what a caller with a single
   * account gets by leaving it unset.
   */
  session?: string;
  /** Ctrl+C: the run stops at the next safe point. */
  signal?: AbortSignal;
  /** Injected sleep, reused for pacing, flood waits and network backoff. */
  sleep?: PacerOptions["sleep"];
  /** Injected randomness, for the pace jitter. */
  random?: () => number;
}

/**
 * The only slice of the Telegram client this loop needs.
 *
 * `leaveChat` is mtcute's own name (`TelegramClientLike` in
 * src/core/telegram.ts), so a real client satisfies this as written and the
 * fake (`src/fakes/client.ts`) records the calls.
 */
export type LeaveClient = Pick<TelegramClientLike, "leaveChat">;

/** The two backoff pauses a network failure earns (architecture, "Error taxonomy"). */
const NETWORK_BACKOFF_MS = [1000, 2000] as const;

/** A row the resumed run already settled; `pending` rows are not in the map. */
type SettledState = Exclude<ActionState, "pending">;

/**
 * Leave every chat in `plan`, reporting each state change through `onProgress`.
 *
 * See the module header for the rules. The short version of the order inside
 * one chat: stop if the signal is down, take the paced pause (the cap and the
 * abort both surface there), then attempt the leave, then record exactly what
 * happened. A flood stop records nothing for the chat it stopped on, because
 * nothing is known about it — it goes back to being a `pending` chat, which is
 * what a resume needs.
 */
export async function runLeave(
  client: LeaveClient,
  plan: Plan,
  opts: LeaveOptions,
  onProgress: (p: Progress) => void,
): Promise<RunResult> {
  const chats = distinctById(plan.chats);
  const total = chats.length;

  // A dry run is a rehearsal: it touches no chat, writes no run row and takes
  // no pause. `startRun(mode: "dry-run")` is deliberately not used here: a
  // `runs` row for a run that left nothing would show up in `chaff journal` as
  // an outcome, and while it is unfinished `latestUnfinished()` would offer to
  // resume a run that never did anything. The journal records leaves, so a
  // rehearsal records nothing.
  if (!opts.yes) {
    for (const [index, chat] of chats.entries()) {
      onProgress({ chatId: chat.id, title: chat.title, index, total, state: "pending" });
    }
    return nothingHappened(total);
  }

  // An abort that arrived before the run began is not a run at all: no row to
  // resume, nothing claimed.
  if (isAborted(opts.signal)) return { ...nothingHappened(total), aborted: true };

  const journal = opts.journal;
  const session = opts.session ?? DEFAULT_SESSION;
  const ids = chats.map((chat) => chat.id);

  // Every run's settled verdict for these chats, read *before* this invocation
  // opens a run of its own: the `pending` seeds a fresh run writes would
  // otherwise be newer rows about those chats. The fold ignores them anyway
  // (`settledStates` reads only `left`/`skipped`), but reading first keeps the
  // fold and the seeding from being able to disagree at all.
  const prior: SettledRow[] = journal === null ? [] : journal.settledStates(session, ids);

  // Which run this invocation writes to. A run may only be continued when it
  // belongs to this session and its planned chats are *exactly* this plan's
  // chats -- the same set, order aside. Continuing one that planned something
  // else would append a row it never planned (breaking `runs.planned`) and
  // leave one of its own chats `pending` forever, so the run could never
  // finish; continuing another session's run would file these leaves under the
  // wrong account.
  const candidate = journal === null ? null : journal.latestUnfinished(session);
  const resumed =
    journal !== null && candidate !== null && sameChats(chats, journal.actions(candidate.id))
      ? candidate
      : null;
  const runId: number | null =
    resumed !== null
      ? resumed.id
      : (journal?.startRun("leave", JSON.stringify(plan.filters), chats, session) ?? null);

  // The run's own ledger: one row per planned chat. `owned` is the authority for
  // every write below, so a mark for a chat this run did not plan can never
  // reach the database -- the guarantee is structural, not a convention the
  // loop above is trusted to keep.
  const runRows = journal === null || runId === null ? [] : journal.actions(runId);
  const owned = new Set(runRows.map((row) => row.id));

  // What is already settled, and so must not be attempted again.
  //
  // Two sources, because "never leave the same chat twice" spans runs. First
  // the monotone fold: any `left`/`skipped` row in this session settles the
  // chat, whatever any later run's `pending` seed or `failed` row says. Then
  // the run being continued contributes its own unsettled verdicts -- a failure
  // it recorded is *re-reported* with the message it stored instead of retried
  // -- but only for chats the fold did not settle, so a newer `left` always
  // wins over an older local `failed`.
  //
  // `recorded` says whether the run this invocation writes to already holds
  // that same verdict. When it does not, the verdict is carried forward below,
  // because a `pending` row left behind would keep the run unfinishable.
  const settled = new Map<
    number,
    { state: SettledState; error: string | null; recorded: boolean }
  >();
  if (journal !== null) {
    const inRun = new Map(runRows.map((row) => [row.id, row.state]));
    for (const row of prior) {
      settled.set(row.id, {
        state: row.state,
        error: settledNote(row.state, row.error),
        recorded: inRun.get(row.id) === row.state,
      });
    }
    for (const row of runRows) {
      if (row.state === "pending") continue;
      if (settled.has(row.id)) continue;
      settled.set(row.id, {
        state: row.state,
        error: settledNote(row.state, row.error),
        recorded: inRun.get(row.id) === row.state,
      });
    }
  }

  const pacer = new Pacer({
    baseMs: opts.delayMs,
    maxLeave: opts.maxLeave,
    signal: opts.signal,
    sleep: opts.sleep,
    random: opts.random,
  });
  const sleep = opts.sleep ?? defaultSleep;

  const counts = { left: 0, failed: 0, skipped: 0 };
  const failures: LeaveFailure[] = [];
  let aborted = false;
  let capped = false;
  let floodWaitSeconds: number | null = null;

  const record = (chat: PlanChat, state: SettledState, error?: string): void => {
    if (journal === null || runId === null) return;
    // Unreachable as the loop is written -- it only walks this plan's chats, and
    // a resumed run holds exactly those. Refusing the write keeps a run's
    // ledger describing the run that actually happened if that ever changes.
    if (!owned.has(chat.id)) return;
    journal.mark(runId, chat, state, error);
  };

  for (let index = 0; index < total; index++) {
    const chat = chats[index]!;

    // Already settled: report it and count it, but never touch it again. A
    // recorded failure is reported as a failure, with its own message.
    const before = settled.get(chat.id);
    if (before !== undefined) {
      counts[before.state] += 1;
      if (before.state === "failed") {
        failures.push({
          chatId: chat.id,
          title: chat.title,
          error: before.error ?? "failed in an earlier run",
        });
      }
      // A verdict that came from an *earlier* run has no row in this one, so it
      // is carried forward: "this chat is left" is what the ledger means, and a
      // `pending` row left behind would keep this run unfinishable.
      if (!before.recorded) record(chat, before.state, before.error ?? undefined);
      onProgress({
        chatId: chat.id,
        title: chat.title,
        index,
        total,
        state: before.state,
        ...(before.error === null ? {} : { error: before.error }),
      });
      continue;
    }

    if (isAborted(opts.signal)) {
      aborted = true;
      break;
    }

    try {
      await pacer.wait();
    } catch (error) {
      if (error instanceof PacerCapError) {
        capped = true;
        break;
      }
      if (isAbort(error)) {
        aborted = true;
        break;
      }
      throw error;
    }

    // The injected sleep may return normally on an abort (the default one
    // rejects), so the signal is asked again before the leave goes out.
    if (isAborted(opts.signal)) {
      aborted = true;
      break;
    }

    const outcome = await attempt(client, chat, opts, sleep);

    if (outcome.kind === "aborted") {
      aborted = true;
      break;
    }
    if (outcome.kind === "flood-stop") {
      floodWaitSeconds = outcome.floodWaitSeconds;
      break;
    }

    if (outcome.kind === "left") {
      counts.left += 1;
      // No note in the journal: the survived flood wait is progress, and `error`
      // means "this failed". Storing it would show an error column on a
      // successful leave and re-emit it as an error when a resume re-reports
      // the chat.
      record(chat, "left");
      onProgress({
        chatId: chat.id,
        title: chat.title,
        index,
        total,
        state: "left",
        ...(outcome.note === undefined ? {} : { error: outcome.note }),
      });
      // The abort arrived while this chat was in flight. It *was* left, so it
      // is recorded and reported, and the run stops here.
      if (isAborted(opts.signal)) {
        aborted = true;
        break;
      }
      continue;
    }

    if (outcome.kind === "skipped") {
      counts.skipped += 1;
      record(chat, "skipped", outcome.message);
      onProgress({
        chatId: chat.id,
        title: chat.title,
        index,
        total,
        state: "skipped",
        error: outcome.message,
      });
      continue;
    }

    counts.failed += 1;
    failures.push({ chatId: chat.id, title: chat.title, error: outcome.message });
    record(chat, "failed", outcome.message);
    onProgress({
      chatId: chat.id,
      title: chat.title,
      index,
      total,
      state: "failed",
      error: outcome.message,
    });
    if (outcome.stop) break;
  }

  // A run is finished when it has nothing left to resume. A flood, a cap or an
  // abort all leave `pending` rows, so all three stay resumable.
  if (journal !== null && runId !== null && journal.pending(runId).length === 0) {
    journal.finishRun(runId);
  }

  return { planned: total, ...counts, aborted, capped, floodWaitSeconds, failures };
}

/**
 * The plan's chats, with any repeated id dropped; the first occurrence wins.
 *
 * A plan is meant to hold one row per chat, but `--from` replays a
 * hand-editable manifest and `--select` takes ids straight off the command
 * line, so a repeated id is one keystroke away. Leaving a chat twice in one run
 * is the invariant this module exists to keep, so the seam enforces it itself
 * rather than trusting the plan's producer: the seeded rows, `runs.planned` and
 * every counter then agree on the same distinct set.
 */
function distinctById(chats: PlanChat[]): PlanChat[] {
  const seen = new Set<number>();
  const distinct: PlanChat[] = [];
  for (const chat of chats) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    distinct.push(chat);
  }
  return distinct;
}

/**
 * Does this plan ask for exactly the chats the run planned?
 *
 * Order may differ -- a manifest replayed in another order is the same plan --
 * but the sets must match, with neither side repeating a chat. Anything looser
 * would let a run absorb a chat it never planned, or strand one of its own
 * `pending` chats so it could never finish.
 */
function sameChats(plan: PlanChat[], rows: ActionRow[]): boolean {
  const planIds = new Set(plan.map((chat) => chat.id));
  const runIds = new Set(rows.map((row) => row.id));
  if (planIds.size !== plan.length || runIds.size !== rows.length) return false;
  if (planIds.size !== runIds.size) return false;
  for (const id of planIds) if (!runIds.has(id)) return false;
  return true;
}

/**
 * The message to keep for a settled row.
 *
 * `error` is for `failed`/`skipped` states; a `left` row has no failure to
 * explain, so a note an older journal stored there (a survived flood wait) is
 * dropped rather than re-emitted as an error on resume.
 */
function settledNote(state: SettledState, error: string | null): string | null {
  return state === "left" ? null : error;
}

/** The result of a run that touched nothing: a clean dry run, or a pre-aborted one. */
function nothingHappened(total: number): RunResult {
  return {
    planned: total,
    left: 0,
    failed: 0,
    skipped: 0,
    aborted: false,
    capped: false,
    floodWaitSeconds: null,
    failures: [],
  };
}

/**
 * The decision one chat's leave request produced.
 *
 * `flood-stop` deliberately carries no chat state: Telegram said the *account*
 * should slow down, so nothing is known about the chat itself and the journal
 * must leave it `pending`. `failed.stop` is the `--force` question: an
 * unrecognised error stops the run unless forced past.
 */
type AttemptOutcome =
  | { kind: "left"; note?: string }
  | { kind: "skipped"; message: string }
  | { kind: "failed"; message: string; stop: boolean }
  | { kind: "flood-stop"; floodWaitSeconds: number | null }
  | { kind: "aborted" };

/**
 * Leave one chat, applying the taxonomy's retry rules to its failures
 * (plan/architecture.md, "Error taxonomy").
 *
 * The loop is the taxonomy: a short flood and a network error each come back
 * around once they have been paused for, everything else returns a decision.
 * Nothing here writes to the journal or to the progress stream — it answers
 * what happened to this one chat, and the caller records it.
 */
async function attempt(
  client: LeaveClient,
  chat: PlanChat,
  opts: LeaveOptions,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<AttemptOutcome> {
  /** Backoffs left for this chat; empty means the network retries are spent. */
  const backoff: number[] = [...NETWORK_BACKOFF_MS];
  /** The note of the flood wait this chat already sat through, if any. */
  let survivedFlood: string | undefined;
  let floodRetried = false;

  for (;;) {
    try {
      await client.leaveChat(chat.id, { clear: opts.clear });
      return survivedFlood === undefined ? { kind: "left" } : { kind: "left", note: survivedFlood };
    } catch (error) {
      if (isAbort(error)) return { kind: "aborted" };

      const verdict = classify(error, { force: opts.force });

      switch (verdict.kind) {
        case "flood-short": {
          const seconds = verdict.floodWaitSeconds ?? 0;
          // A second short flood means the pause did not help: stop rather than
          // sleep a second time, and leave the chat pending like any flood stop.
          if (floodRetried) return { kind: "flood-stop", floodWaitSeconds: seconds };
          floodRetried = true;
          survivedFlood = verdict.message;
          if (!(await pause(sleep, seconds * 1000, opts.signal))) return { kind: "aborted" };
          continue;
        }
        case "flood-long":
        case "peer-flood":
          return { kind: "flood-stop", floodWaitSeconds: verdict.floodWaitSeconds ?? null };
        case "skippable":
          return { kind: "skipped", message: verdict.message };
        case "network": {
          const wait = backoff.shift();
          if (wait === undefined) return { kind: "failed", message: verdict.message, stop: false };
          if (!(await pause(sleep, wait, opts.signal))) return { kind: "aborted" };
          continue;
        }
        case "unknown":
          return { kind: "failed", message: verdict.message, stop: opts.force !== true };
      }
    }
  }
}

/**
 * One pause, with the abort signal. `false` means the signal went down before
 * or during it, so the caller must stop without recording anything.
 */
async function pause(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (isAborted(signal)) return false;
  try {
    await sleep(ms, signal);
  } catch (error) {
    if (isAbort(error)) return false;
    throw error;
  }
  return !isAborted(signal);
}

/** The abort shape the pacer's default sleep rejects with, whatever carries it. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Has the run been told to stop?
 *
 * A function rather than an inline `signal?.aborted === true` because the
 * signal changes under us: every `await` above is a moment the user can press
 * Ctrl+C. Reading the property through a call means the question is asked
 * again each time instead of being answered once from the check at the top.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
