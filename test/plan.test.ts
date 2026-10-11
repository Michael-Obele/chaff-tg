/**
 * The plan builder: accepted records + filters -> the plan a user reviews
 * (plan/architecture.md, "Data flow"; plan/cli.md, "The review manifest").
 *
 * Contract under test:
 * - `Plan.chats` holds the ACCEPTED rows only, in declaration order, each
 *   carrying the engine's `why`; `summary.matched` is exactly `chats.length`.
 * - The selection order is the engine's, not the builder's: include
 *   (force-in, `why: ["include"]`) -> filters -> exclude (wins) -> limit.
 * - `summary.estimatedSeconds = round(matched * delayMs / 1000)`, `delayMs`
 *   defaulting to 1200, so the summary is pure arithmetic on the row count.
 * - `createdAt` is the injected clock in ISO 8601 UTC and `version` is always
 *   1: the builder never reads the system clock.
 * - The plan is a value snapshot of one review, so a plan built here
 *   round-trips through `serializeManifest`/`parseManifest` unchanged.
 * - `applyExclude` is the last word: it removes ids from a plan that already
 *   exists, wins over `--include`, and recomputes the estimate from the same
 *   formula for the kept rows (at the caller's pace) without re-running the
 *   filters (it has no clock to re-run them against).
 */
import { describe, expect, test } from "bun:test";
import * as core from "../src/core";
import { parseManifest, serializeManifest } from "../src/core/manifest";
import { applyExclude, buildPlan, DEFAULT_DELAY_MS, estimateSeconds } from "../src/core/plan";
import type { Account, ChatRecord, Filters } from "../src/core/types";

/** Fixed clock: every inactive-days and `createdAt` assertion is exact arithmetic. */
const NOW = new Date("2026-10-11T00:00:00Z");

const ACCOUNT: Account = { id: 1234567, username: "example" };

/** The shared dialog fixture, read the same way the sibling suites read it. */
const dialogs = (await Bun.file(
  new URL("./fixtures/dialogs.json", import.meta.url),
).json()) as ChatRecord[];

/** One fixture row, so a test names the chat it means instead of an index. */
function chat(id: number): ChatRecord {
  const row = dialogs.find((d) => d.id === id);
  if (row === undefined) throw new Error(`fixture row ${id} is missing`);
  return row;
}

/** The unset default: every filter off, no include/exclude/limit. */
function filters(overrides: Partial<Filters> = {}): Filters {
  return {
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
    ...overrides,
  };
}

/** The ids of the accepted chats, in the order the plan kept them. */
function ids(plan: { chats: { id: number }[] }): number[] {
  return plan.chats.map((c) => c.id);
}

/** The fixture rows with `muted: true`: 5 of the 15. */
const MUTED_IDS = [-1001, -1002, -1005, -1010, -1012];

describe("buildPlan", () => {
  test("keeps the accepted rows only, in declaration order, with the engine's why", () => {
    const plan = buildPlan(dialogs, filters({ muted: true }), ACCOUNT, NOW);

    expect(ids(plan)).toEqual(MUTED_IDS);
    expect(plan.chats.every((c) => c.why.includes("muted"))).toBe(true);
    // The rejected rows are not carried at all, not carried with ok: false.
    expect(plan.chats.some((c) => c.id === -1003)).toBe(false);
  });

  test("with no filters keeps every row, quietly", () => {
    const plan = buildPlan(dialogs, filters(), ACCOUNT, NOW);

    expect(ids(plan)).toEqual(dialogs.map((d) => d.id));
    expect(plan.chats.every((c) => c.why.length === 0)).toBe(true);
    expect(plan.summary.matched).toBe(15);
  });

  test("force-adds a filtered-out chat when it is included, with why ['include']", () => {
    // -1003 (Family Group) is unmuted, so the muted filter rejects it.
    const included = buildPlan(dialogs, filters({ muted: true, include: [-1003] }), ACCOUNT, NOW);

    // Declaration order, not include order: -1003 sits between -1002 and -1005.
    expect(ids(included)).toEqual([-1001, -1002, -1003, -1005, -1010, -1012]);
    const row = included.chats.find((c) => c.id === -1003);
    expect(row?.why).toEqual(["include"]);
    expect(included.summary.matched).toBe(6);
  });

  test("drops an included chat again when it is excluded: exclude is the last word", () => {
    const plan = buildPlan(
      dialogs,
      filters({ muted: true, include: [-1003], exclude: [-1003, -1001] }),
      ACCOUNT,
      NOW,
    );

    expect(ids(plan)).toEqual([-1002, -1005, -1010, -1012]);
    expect(plan.summary.matched).toBe(4);
  });

  test("caps the accepted rows at limit, before the summary is counted", () => {
    const plan = buildPlan(dialogs, filters({ limit: 2 }), ACCOUNT, NOW);

    expect(ids(plan)).toEqual([-1001, -1002]);
    expect(plan.summary.matched).toBe(2);
    expect(plan.summary.estimatedSeconds).toBe(2);
  });

  test("counts matched as the accepted rows, not the rows it looked at", () => {
    const plan = buildPlan(dialogs, filters({ muted: true, inactiveDays: 365 }), ACCOUNT, NOW);

    // Four of the five muted rows are also inactive: -1010 was muted 2025-11-01.
    expect(ids(plan)).toEqual([-1001, -1002, -1005, -1012]);
    expect(plan.summary.matched).toBe(plan.chats.length);
  });

  test("estimates one delay per accepted chat, rounded to whole seconds", () => {
    const five = filters({ muted: true });

    expect(DEFAULT_DELAY_MS).toBe(1200);
    // 5 chats at the documented 1200 ms default.
    expect(buildPlan(dialogs, five, ACCOUNT, NOW).summary.estimatedSeconds).toBe(6);
    // The same rows at other paces: the estimate is arithmetic on the count.
    expect(buildPlan(dialogs, five, ACCOUNT, NOW, 2000).summary.estimatedSeconds).toBe(10);
    expect(buildPlan(dialogs, five, ACCOUNT, NOW, 400).summary.estimatedSeconds).toBe(2);
    expect(buildPlan(dialogs, five, ACCOUNT, NOW, 0).summary.estimatedSeconds).toBe(0);
  });

  test("estimateSeconds is the one rounding rule, for any subset too", () => {
    expect(estimateSeconds(0, 1200)).toBe(0);
    expect(estimateSeconds(3, 1200)).toBe(4); // 3.6 s rounds up
    expect(estimateSeconds(5, 400)).toBe(2);
    expect(estimateSeconds(37, 1400)).toBe(52); // the plan/cli.md example
  });

  test("stamps createdAt from the injected clock and pins the version", () => {
    const plan = buildPlan(dialogs, filters(), ACCOUNT, NOW);

    expect(plan.createdAt).toBe(NOW.toISOString());
    expect(plan.createdAt).toBe("2026-10-11T00:00:00.000Z");
    expect(Date.parse(plan.createdAt)).toBe(NOW.getTime());
    expect(plan.version).toBe(1);
    expect(plan.account).toEqual(ACCOUNT);
  });

  test("is a value snapshot: the plan does not alias the caller's filters", () => {
    const f = filters({ muted: true, keyword: ["signal"] });
    const plan = buildPlan(dialogs, f, ACCOUNT, NOW);

    expect(plan.filters).toEqual(f);
    expect(plan.filters).not.toBe(f);
    expect(plan.filters.keyword).not.toBe(f.keyword);

    // Rewriting the filter object afterwards must not rewrite what was reviewed.
    f.muted = false;
    f.keyword.push("airdrop");
    expect(plan.filters.muted).toBe(true);
    expect(plan.filters.keyword).toEqual(["signal"]);
  });

  test("does not mutate the records it was given", () => {
    const before = JSON.parse(JSON.stringify(dialogs));
    buildPlan(dialogs, filters({ include: [-1003] }), ACCOUNT, NOW);

    expect(dialogs).toEqual(before);
    expect("why" in chat(-1003)).toBe(false);
  });

  test("round-trips through serializeManifest and parseManifest unchanged", () => {
    const plan = buildPlan(
      dialogs,
      filters({ types: ["channel", "supergroup"], muted: true, inactiveDays: 365 }),
      ACCOUNT,
      NOW,
    );

    expect(plan.summary.matched).toBe(4);
    expect(parseManifest(serializeManifest(plan))).toEqual(plan);
  });
});

describe("applyExclude", () => {
  /** A plan built from the muted rows at the documented default pace. */
  function mutedPlan() {
    return buildPlan(dialogs, filters({ muted: true }), ACCOUNT, NOW);
  }

  test("removes the excluded chats and keeps the rest, why and order intact", () => {
    const plan = applyExclude(mutedPlan(), [-1002, -1010]);

    expect(ids(plan)).toEqual([-1001, -1005, -1012]);
    expect(plan.chats.map((c) => c.why)).toEqual([["muted"], ["muted"], ["muted"]]);
  });

  test("wins over include: an included chat can still be excluded", () => {
    const plan = buildPlan(dialogs, filters({ muted: true, include: [-1003] }), ACCOUNT, NOW);
    const after = applyExclude(plan, [-1003]);

    expect(ids(after)).toEqual(MUTED_IDS);
  });

  test("removes nothing when exclude is empty", () => {
    const plan = mutedPlan();
    const after = applyExclude(plan, []);

    expect(ids(after)).toEqual(MUTED_IDS);
    expect(after.summary).toEqual(plan.summary);
  });

  test("re-points the estimate at the kept rows, keeping the plan's own pace", () => {
    const plan = mutedPlan();
    const after = applyExclude(plan, [-1002, -1010]);

    // 5 rows at 1200 ms -> 6 s; 3 rows -> 3.6 s -> 4 s.
    expect(plan.summary.estimatedSeconds).toBe(6);
    expect(after.summary).toEqual({ matched: 3, estimatedSeconds: 4 });
  });

  test("recomputes the estimate from the formula, not by scaling the old one", () => {
    // 3 rows at the documented 1200 ms default: round(3.6) = 4. Dropping one
    // must be round(2 x 1.2) = 2, not the scaled round(4 x 2/3) = 3.
    const plan = buildPlan(dialogs, filters({ muted: true, limit: 3 }), ACCOUNT, NOW);
    expect(plan.summary).toEqual({ matched: 3, estimatedSeconds: 4 });

    const after = applyExclude(plan, [-1001]);
    expect(after.summary).toEqual({ matched: 2, estimatedSeconds: 2 });
  });

  test("takes the pace from the caller: a custom delayMs is honored, omission means the default", () => {
    // 4 rows at 3000 ms -> 12 s; dropping one -> 9 s, not 3.6 s.
    const plan = buildPlan(dialogs, filters({ muted: true, limit: 4 }), ACCOUNT, NOW, 3000);
    expect(plan.summary).toEqual({ matched: 4, estimatedSeconds: 12 });

    const after = applyExclude(plan, [-1001], 3000);
    expect(after.summary).toEqual({ matched: 3, estimatedSeconds: 9 });

    // Without the argument the pace is the documented default, not the plan's:
    // 3 rows at 1200 ms -> round(3.6) = 4.
    const inferred = applyExclude(plan, [-1001]);
    expect(inferred.summary).toEqual({ matched: 3, estimatedSeconds: 4 });
  });

  test("never re-runs the filters: an exclusion does not re-judge the kept rows", () => {
    // The plan's filters are time-relative (`inactiveDays`), and `applyExclude`
    // has no clock. Re-running them against an epoch clock would drop every row.
    const plan = buildPlan(dialogs, filters({ inactiveDays: 365 }), ACCOUNT, NOW);
    expect(plan.summary.matched).toBe(7);

    const after = applyExclude(plan, [-1004]);
    expect(ids(after)).toEqual(ids(plan));
    expect(after.summary.matched).toBe(7);
  });

  test("moves only chats and summary: the reviewed filter set is untouched", () => {
    const plan = mutedPlan();
    const after = applyExclude(plan, [-1001]);

    expect(after.filters).toEqual(plan.filters);
    expect(after.filters.exclude).toEqual([]);
    expect(after.version).toBe(plan.version);
    expect(after.createdAt).toBe(plan.createdAt);
    expect(after.account).toEqual(plan.account);
    expect(ids(plan)).toEqual(MUTED_IDS);
  });

  test("excluding every chat leaves an empty plan with a zero estimate", () => {
    const after = applyExclude(mutedPlan(), MUTED_IDS);

    expect(after.chats).toEqual([]);
    expect(after.summary).toEqual({ matched: 0, estimatedSeconds: 0 });
  });
});

describe("core barrel", () => {
  test("re-exports the plan builder", () => {
    expect(core.buildPlan).toBe(buildPlan);
    expect(core.applyExclude).toBe(applyExclude);
    expect(core.DEFAULT_DELAY_MS).toBe(DEFAULT_DELAY_MS);
    expect(core.estimateSeconds).toBe(estimateSeconds);
  });
});
