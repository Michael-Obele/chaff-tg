/**
 * The plan builder: accepted records + filters -> the plan a user reviews
 * (plan/architecture.md, "Data flow"; plan/cli.md, "The review manifest").
 *
 * `buildPlan` is the seam between the filter engine and the manifest format.
 * It owns no selection logic of its own: it hands the whole filter set to
 * `filterRecords` and keeps the rows that came back accepted, which is what
 * pins the order (include -> filters -> exclude -> limit) for every caller.
 *
 * Pure and synchronous, like the engine: the clock and the pace are arguments,
 * and nothing here prints or reads the system time.
 */
import { filterRecords } from "./filters";
import type { Account, ChatRecord, Filters, Plan, PlanChat } from "./types";

/** The documented `--delay` default, in milliseconds (plan/cli.md, "Selection and pacing"). */
export const DEFAULT_DELAY_MS = 1200;

/**
 * The clock `applyExclude` hands the engine. Every filter in `NO_FILTERS` is
 * unset, so `filterRecords` never reads it; a frozen epoch says that plainly
 * instead of leaving a `Date.now()` in the core.
 */
const NO_CLOCK = new Date(0);

/** Every filter at the value the engine treats as "unset" (src/core/filters.ts). */
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
  neverPosted: false,
  members: null,
  scam: false,
  fake: false,
  unread: null,
  pinned: null,
  include: [],
  exclude: [],
  limit: null,
};

/**
 * One delay pause per accepted chat, in whole seconds.
 *
 * Exported because the estimate is needed for subsets too, not just for the
 * summary: the CLI confirm screen and the TUI footer estimate the selected
 * rows at the same pace, and the rounding must be defined once.
 */
export function estimateSeconds(matched: number, delayMs: number): number {
  return Math.round(matched * (delayMs / 1000));
}

/**
 * Build the plan for one run: the accepted rows, in declaration order, plus
 * the summary and the account that produced them.
 *
 * `chats` holds accepted rows only (rows the limit cut off, or that a filter
 * rejected, are not carried at all), so `summary.matched` is just
 * `chats.length`. `--include` and `--exclude` are not handled here: they ride
 * along inside `f` and `filterRecords` gives them their mandated order.
 *
 * The returned plan is a value snapshot, not a view: the filter set and the
 * account are copied, so a caller mutating its own objects afterwards cannot
 * rewrite what the manifest says was reviewed.
 */
export function buildPlan(
  records: ChatRecord[],
  f: Filters,
  account: Account,
  now: Date,
  delayMs: number = DEFAULT_DELAY_MS,
): Plan {
  const chats: PlanChat[] = filterRecords(records, f, now)
    .filter((row) => row.ok)
    .map((row) => ({ ...row.chat, why: [...row.why] }));

  return {
    version: 1,
    createdAt: now.toISOString(),
    account: { ...account },
    filters: structuredClone(f),
    summary: {
      matched: chats.length,
      estimatedSeconds: estimateSeconds(chats.length, delayMs),
    },
    chats,
  };
}

/**
 * Apply `--exclude` to a plan that already exists, the replay path
 * (`chaff leave --from plan.json --exclude ...`). Exclude wins over
 * `--include`: a chat that was forced in is dropped here like any other.
 *
 * This is the only other place exclusion is applied, and it does not
 * re-implement the rule: it hands the plan's own chats back through
 * `filterRecords` with nothing active but `exclude`, so "exclude wins" lives
 * in exactly one function (src/core/filters.ts). No filter is active in that
 * call, so the filters are never re-judged, which matters because a replayed
 * plan's filters are relative to the moment it was built and this function
 * has no clock.
 *
 * Only `chats` and `summary` move: `filters` still describes the review that
 * produced the plan, and an act-time exclusion is not a new review.
 *
 * The plan does not record the `delayMs` it was built with, so the estimate is
 * re-derived from the plan's own numbers (a share of the estimate it already
 * carried) rather than recomputed at the default pace: excluding nothing
 * leaves the number exactly as it was, and a plan built with a custom
 * `--delay` keeps its pace.
 */
export function applyExclude(plan: Plan, exclude: number[]): Plan {
  const chats = filterRecords(plan.chats, { ...NO_FILTERS, exclude }, NO_CLOCK)
    .filter((row) => row.ok)
    // `filterRecords` hands back the very objects it was given, so these are
    // the plan's own `PlanChat` rows, `why` and all.
    .map((row) => row.chat as PlanChat);

  return {
    ...plan,
    summary: {
      matched: chats.length,
      estimatedSeconds:
        plan.summary.matched === 0
          ? 0
          : Math.round((plan.summary.estimatedSeconds * chats.length) / plan.summary.matched),
    },
    chats,
  };
}
