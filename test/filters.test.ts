/**
 * Table-driven tests for the pure filter engine (plan/architecture.md,
 * "Filters as a pure function"; plan/cli.md, "Filters").
 *
 * Contract under test:
 * - `match` is pure and synchronous; the clock is an argument (`NOW` below).
 * - Filters combine with AND; `keyword`/`any`/`not` combine their own members
 *   with OR. Empty-string keywords are ignored, not treated as match-everything.
 * - `why` carries one stable, machine-readable token per active filter, in the
 *   fixed order of the `Filters` fields. `ok` gives the direction of the verdict.
 * - `filterRecords` applies the whole set in the mandated order:
 *   include first (force-in) -> filters (via match) -> exclude last (wins) ->
 *   limit (truncates the accepted list in declaration order).
 */
import { describe, expect, test } from "bun:test";
import { filterRecords, match, type FilterRow } from "../src/core/filters";
import type { ChatRecord, ChatType, Filters } from "../src/core/types";

/** Fixed clock: every inactive-days assertion is exact arithmetic against this. */
const NOW = new Date("2026-10-11T00:00:00Z");

const dialogs = (await Bun.file(
  new URL("./fixtures/dialogs.json", import.meta.url),
).json()) as ChatRecord[];

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
    ...overrides,
  };
}

interface Row {
  name: string;
  id: number;
  filters: Partial<Filters>;
  ok: boolean;
  why: string[];
}

/** One row per filter, plus the combinations the brief calls out. */
const table: Row[] = [
  // No filters: everything passes, nothing to say.
  { name: "no filters: chat passes with no reasons", id: -1001, filters: {}, ok: true, why: [] },

  // types
  {
    name: "types: matching type passes",
    id: -1001,
    filters: { types: ["channel"] },
    ok: true,
    why: ["type:channel"],
  },
  {
    name: "types: other type fails",
    id: -1003,
    filters: { types: ["channel"] },
    ok: false,
    why: ["type:group"],
  },
  {
    name: "types: comma list is an OR group",
    id: -1007,
    filters: { types: ["group", "gigagroup"] },
    ok: true,
    why: ["type:gigagroup"],
  },

  // keyword (title or username, OR within the list, case insensitive)
  {
    name: "keyword: matches title",
    id: -1001,
    filters: { keyword: ["signal"] },
    ok: true,
    why: ["keyword:signal"],
  },
  {
    // "Mixed Case Group" has a space, so this can only have matched the username.
    name: "keyword: matches username",
    id: -1014,
    filters: { keyword: ["mixedcase"] },
    ok: true,
    why: ["keyword:mixedcase"],
  },
  {
    name: "keyword: non-match fails",
    id: -1003,
    filters: { keyword: ["signal"] },
    ok: false,
    why: ["keyword:signal"],
  },
  {
    name: "keyword: matching is case-insensitive, token keeps the argument",
    id: -1001,
    filters: { keyword: ["SIGNAL"] },
    ok: true,
    why: ["keyword:SIGNAL"],
  },
  {
    name: "keyword: OR group reports the entry that matched",
    id: -1001,
    filters: { keyword: ["zzz", "signal"] },
    ok: true,
    why: ["keyword:signal"],
  },
  {
    name: "empty keyword string is ignored, not match-everything",
    id: -1003,
    filters: { keyword: [""] },
    ok: true,
    why: [],
  },
  {
    name: "empty keyword entries are skipped, the rest still apply",
    id: -1003,
    filters: { keyword: ["", "signal"] },
    ok: false,
    why: ["keyword:signal"],
  },

  // any (same OR semantics, its own token)
  { name: "any: OR group match", id: -1012, filters: { any: ["vip"] }, ok: true, why: ["any:vip"] },
  {
    name: "any: OR group miss fails",
    id: -1003,
    filters: { any: ["vip", "elite"] },
    ok: false,
    why: ["any:vip"],
  },

  // not (any hit excludes the chat)
  {
    name: "not: a listed word rejects",
    id: -1010,
    filters: { not: ["airdrop"] },
    ok: false,
    why: ["not:airdrop"],
  },
  {
    name: "not: absent word passes",
    id: -1003,
    filters: { not: ["airdrop"] },
    ok: true,
    why: ["not:airdrop"],
  },
  {
    name: "not: matching is case-insensitive",
    id: -1010,
    filters: { not: ["AIRDROP"] },
    ok: false,
    why: ["not:AIRDROP"],
  },

  // regex (title only, case insensitive)
  {
    name: "regex: pattern matches title",
    id: -1011,
    filters: { regex: "^Rust" },
    ok: true,
    why: ["regex:^Rust"],
  },
  {
    name: "regex: case-insensitive",
    id: -1011,
    filters: { regex: "^rust" },
    ok: true,
    why: ["regex:^rust"],
  },
  {
    name: "regex: non-match fails",
    id: -1003,
    filters: { regex: "^Rust" },
    ok: false,
    why: ["regex:^Rust"],
  },

  // ids
  {
    name: "ids: listed chat passes",
    id: -1001,
    filters: { ids: [-1001, -1002] },
    ok: true,
    why: ["id:-1001"],
  },
  {
    name: "ids: unlisted chat fails",
    id: -1003,
    filters: { ids: [-1001] },
    ok: false,
    why: ["id:-1003"],
  },

  // muted (null means account default: unknown, so it fails both directions)
  {
    name: "muted: true passes for a muted chat",
    id: -1002,
    filters: { muted: true },
    ok: true,
    why: ["muted"],
  },
  {
    name: "muted: false fails for a muted chat",
    id: -1002,
    filters: { muted: false },
    ok: false,
    why: ["unmuted"],
  },
  {
    name: "muted: false passes for an unmuted chat",
    id: -1003,
    filters: { muted: false },
    ok: true,
    why: ["unmuted"],
  },
  {
    name: "muted: unknown state fails --muted",
    id: -1008,
    filters: { muted: true },
    ok: false,
    why: ["muted"],
  },
  {
    name: "muted: unknown state fails --not-muted too",
    id: -1008,
    filters: { muted: false },
    ok: false,
    why: ["unmuted"],
  },

  // archived
  {
    name: "archived: true passes",
    id: -1002,
    filters: { archived: true },
    ok: true,
    why: ["archived"],
  },
  {
    name: "archived: false fails for archived chat",
    id: -1002,
    filters: { archived: false },
    ok: false,
    why: ["unarchived"],
  },
  {
    name: "archived: false passes for unarchived chat",
    id: -1003,
    filters: { archived: false },
    ok: true,
    why: ["unarchived"],
  },

  // inactiveDays (against the fixed NOW; lastMessageAt null counts as inactive)
  {
    name: "inactiveDays: old message counts as inactive",
    id: -1002,
    filters: { inactiveDays: 365 },
    ok: true,
    why: ["inactive:365d"],
  },
  {
    name: "inactiveDays: recent message fails",
    id: -1003,
    filters: { inactiveDays: 365 },
    ok: false,
    why: ["inactive:365d"],
  },
  {
    name: "inactiveDays: null lastMessageAt is inactive",
    id: -1006,
    filters: { inactiveDays: 365 },
    ok: true,
    why: ["inactive:365d"],
  },
  {
    name: "inactiveDays: 344 days old passes a 300 day threshold",
    id: -1010,
    filters: { inactiveDays: 300 },
    ok: true,
    why: ["inactive:300d"],
  },
  {
    name: "inactiveDays: 344 days old fails a 400 day threshold",
    id: -1010,
    filters: { inactiveDays: 400 },
    ok: false,
    why: ["inactive:400d"],
  },
  {
    name: "inactiveDays: exactly n days old counts as inactive",
    id: -1015,
    filters: { inactiveDays: 365 },
    ok: true,
    why: ["inactive:365d"],
  },
  {
    name: "inactiveDays: exactly n days old is not n+1 days inactive",
    id: -1015,
    filters: { inactiveDays: 366 },
    ok: false,
    why: ["inactive:366d"],
  },

  // members (missing counts are excluded, never treated as zero)
  {
    name: "members: inside the range passes",
    id: -1012,
    filters: { members: { min: 0, max: 100 } },
    ok: true,
    why: ["members:0-100"],
  },
  {
    name: "members: above the range fails",
    id: -1001,
    filters: { members: { min: 0, max: 50 } },
    ok: false,
    why: ["members:0-50"],
  },
  {
    name: "members: below the range fails",
    id: -1006,
    filters: { members: { min: 10, max: 100 } },
    ok: false,
    why: ["members:10-100"],
  },
  {
    name: "members: null count is excluded, not treated as zero",
    id: -1004,
    filters: { members: { min: 0, max: 50 } },
    ok: false,
    why: ["members:0-50"],
  },

  // scam / fake (Telegram's own flags)
  {
    name: "scam: flagged chat passes",
    id: -1001,
    filters: { scam: true },
    ok: true,
    why: ["scam"],
  },
  { name: "scam: clean chat fails", id: -1003, filters: { scam: true }, ok: false, why: ["scam"] },
  {
    name: "fake: flagged chat passes",
    id: -1009,
    filters: { fake: true },
    ok: true,
    why: ["fake"],
  },
  { name: "fake: clean chat fails", id: -1003, filters: { fake: true }, ok: false, why: ["fake"] },

  // unread (Telegram's own rule: marked unread, or more than one unread
  // message — a single unread message never badges a dialog)
  {
    name: "unread: three unread messages pass",
    id: -1003,
    filters: { unread: true },
    ok: true,
    why: ["unread"],
  },
  {
    name: "unread: a marked chat with no unread messages passes",
    id: -1006,
    filters: { unread: true },
    ok: true,
    why: ["unread"],
  },
  {
    name: "unread: exactly one unread message does not pass, as in Telegram",
    id: -1014,
    filters: { unread: true },
    ok: false,
    why: ["unread"],
  },
  {
    name: "read: a chat with no unread messages and no mark passes",
    id: -1013,
    filters: { unread: false },
    ok: true,
    why: ["read"],
  },
  {
    name: "read: a marked chat fails even with no unread messages",
    id: -1006,
    filters: { unread: false },
    ok: false,
    why: ["read"],
  },
  {
    name: "read: a chat with three unread messages fails",
    id: -1003,
    filters: { unread: false },
    ok: false,
    why: ["read"],
  },

  // pinned
  {
    name: "pinned: pinned chat passes",
    id: -1003,
    filters: { pinned: true },
    ok: true,
    why: ["pinned"],
  },
  {
    name: "pinned: unpinned chat fails",
    id: -1001,
    filters: { pinned: true },
    ok: false,
    why: ["pinned"],
  },
  {
    name: "unpinned: unpinned chat passes",
    id: -1001,
    filters: { pinned: false },
    ok: true,
    why: ["unpinned"],
  },
  {
    name: "unpinned: pinned chat fails",
    id: -1003,
    filters: { pinned: false },
    ok: false,
    why: ["unpinned"],
  },

  // unicode
  {
    name: "unicode: keyword matches a non-ASCII title",
    id: -1005,
    filters: { keyword: ["крипта"] },
    ok: true,
    why: ["keyword:крипта"],
  },
  {
    name: "unicode: the whole decorated title matches",
    id: -1005,
    filters: { keyword: ["«Крипта 🚀»"] },
    ok: true,
    why: ["keyword:«Крипта 🚀»"],
  },

  // combinations: filters AND together, tokens keep field order
  {
    name: "combination: keyword AND inactiveDays",
    id: -1001,
    filters: { keyword: ["signal"], inactiveDays: 365 },
    ok: true,
    why: ["keyword:signal", "inactive:365d"],
  },
  {
    name: "combination: keyword AND inactiveDays, recent chat fails both directions recorded",
    id: -1013,
    filters: { keyword: ["fresh"], inactiveDays: 365 },
    ok: false,
    why: ["keyword:fresh", "inactive:365d"],
  },
  {
    name: "combination: type AND muted AND read",
    id: -1002,
    filters: { types: ["supergroup"], muted: true, unread: false },
    ok: true,
    why: ["type:supergroup", "muted", "read"],
  },
  {
    name: "combination: muted inactive supergroup",
    id: -1002,
    filters: { muted: true, inactiveDays: 365 },
    ok: true,
    why: ["muted", "inactive:365d"],
  },
];

describe("fixture", () => {
  test("has 12+ shaped rows covering every chat type and edge", () => {
    expect(dialogs.length).toBeGreaterThanOrEqual(12);
    const types = new Set<ChatType>();
    for (const row of dialogs) {
      expect(typeof row.id).toBe("number");
      expect(row.id).toBeLessThan(0); // marked ids: negative for chats
      expect(typeof row.title).toBe("string");
      expect(row.username === null || typeof row.username === "string").toBe(true);
      expect(row.members === null || typeof row.members === "number").toBe(true);
      expect(row.muted === null || typeof row.muted === "boolean").toBe(true);
      expect(typeof row.archived).toBe("boolean");
      expect(typeof row.pinned).toBe("boolean");
      expect(typeof row.unread).toBe("number");
      expect(row.lastMessageAt === null || typeof row.lastMessageAt === "string").toBe(true);
      types.add(row.type);
    }
    for (const t of [
      "group",
      "supergroup",
      "channel",
      "gigagroup",
      "monoforum",
      "community",
    ] as const) {
      expect(types.has(t)).toBe(true);
    }
    expect(dialogs.some((d) => d.isScam)).toBe(true);
    expect(dialogs.some((d) => d.isFake)).toBe(true);
    expect(dialogs.some((d) => d.pinned)).toBe(true);
    expect(dialogs.some((d) => d.muted === null)).toBe(true);
    expect(dialogs.some((d) => d.members === null)).toBe(true);
    expect(dialogs.some((d) => d.lastMessageAt === null)).toBe(true);
    expect(dialogs.some((d) => d.title.includes("🚀"))).toBe(true);
    // The mark and a single unread message are the two cases the old
    // `unread > 0` rule got wrong, so both are in the fixture.
    expect(dialogs.some((d) => d.manuallyUnread)).toBe(true);
    expect(dialogs.some((d) => d.unread === 1 && !d.manuallyUnread)).toBe(true);
  });
});

describe("banned and unavailable", () => {
  /** A forbidden channel, exactly as the seam normalizes one: no member count. */
  const forbidden: ChatRecord = {
    id: -1016,
    type: "supergroup",
    title: "Forbidden Vault",
    username: "forbiddenvault",
    members: null,
    muted: true,
    archived: false,
    pinned: false,
    unread: 0,
    manuallyUnread: false,
    isScam: false,
    isFake: false,
    isVerified: false,
    banned: true,
    unavailable: true,
    lastMessageAt: null,
  };

  test("--banned matches the forbidden chat and rejects an available one", () => {
    const m = match(forbidden, filters({ banned: true }), NOW);
    expect(m.ok).toBe(true);
    expect(m.why).toEqual(["banned"]);
    expect(match(chat(-1003), filters({ banned: true }), NOW).ok).toBe(false);
  });

  test("--unavailable is the wider flag", () => {
    const m = match(forbidden, filters({ unavailable: true }), NOW);
    expect(m.ok).toBe(true);
    expect(m.why).toEqual(["unavailable"]);
    expect(match(chat(-1003), filters({ unavailable: true }), NOW).ok).toBe(false);
  });

  test("a missing member count is not zero, so --members cannot find a banned chat", () => {
    // The old idea was `--members 0-0`. It cannot work: the count is absent
    // (not 0) and this filter excludes absent counts by design.
    expect(match(forbidden, filters({ members: { min: 0, max: 0 } }), NOW).ok).toBe(false);
  });
});

describe("match", () => {
  for (const row of table) {
    test(row.name, () => {
      const m = match(chat(row.id), filters(row.filters), NOW);
      expect(m.ok).toBe(row.ok);
      expect(m.why).toEqual(row.why);
    });
  }

  test("every chat matches its own type filter", () => {
    for (const row of dialogs) {
      const m = match(row, filters({ types: [row.type] }), NOW);
      expect(m.ok).toBe(true);
      expect(m.why).toEqual([`type:${row.type}`]);
    }
  });

  test("is pure: no mutation, deterministic for the same arguments", () => {
    const frozen = Object.freeze({ ...chat(-1001) });
    const f = filters({ keyword: ["signal"], inactiveDays: 365 });
    const a = match(frozen, f, NOW);
    const b = match(frozen, f, NOW);
    expect(a).toEqual(b);
    expect(frozen).toEqual(chat(-1001));
  });
});

describe("filterRecords", () => {
  const idsOf = (rows: FilterRow[]): number[] => rows.map((r) => r.chat.id);

  test("keeps ok rows in declaration order with per-row why", () => {
    const rows = filterRecords(dialogs, filters({ types: ["channel"] }), NOW);
    const okRows = rows.filter((r) => r.ok);
    expect(idsOf(okRows)).toEqual([-1001, -1004, -1005, -1010, -1013]);
    for (const r of okRows) expect(r.why).toEqual(["type:channel"]);
    for (const r of rows.filter((r) => !r.ok)) expect(r.why).toEqual([`type:${r.chat.type}`]);
  });

  test("rejected rows carry their rejection reasons", () => {
    const rows = filterRecords(dialogs, filters({ keyword: ["signal"] }), NOW);
    const accepted = rows.find((r) => r.chat.id === -1001);
    const rejected = rows.find((r) => r.chat.id === -1002);
    expect(accepted?.ok).toBe(true);
    expect(accepted?.why).toEqual(["keyword:signal"]);
    expect(rejected?.ok).toBe(false);
    expect(rejected?.why).toEqual(["keyword:signal"]);
  });

  test("include forces a filtered-out chat back in", () => {
    const rows = filterRecords(
      dialogs,
      filters({ keyword: ["nosuchword"], include: [-1001] }),
      NOW,
    );
    const forced = rows.find((r) => r.chat.id === -1001);
    expect(forced?.ok).toBe(true);
    expect(forced?.why).toEqual(["include"]);
    expect(rows.filter((r) => r.ok && r.chat.id !== -1001)).toEqual([]);
  });

  test("include of a chat that would match anyway still tags it", () => {
    const rows = filterRecords(dialogs, filters({ types: ["channel"], include: [-1001] }), NOW);
    const row = rows.find((r) => r.chat.id === -1001);
    expect(row?.ok).toBe(true);
    expect(row?.why).toEqual(["include"]);
  });

  test("exclude beats include", () => {
    const rows = filterRecords(
      dialogs,
      filters({ include: [-1001, -1002], exclude: [-1001] }),
      NOW,
    );
    const excluded = rows.find((r) => r.chat.id === -1001);
    const included = rows.find((r) => r.chat.id === -1002);
    expect(excluded?.ok).toBe(false);
    expect(excluded?.why).toEqual(["exclude"]);
    expect(included?.ok).toBe(true);
    expect(included?.why).toEqual(["include"]);
  });

  test("exclude beats matching filters", () => {
    const rows = filterRecords(dialogs, filters({ types: ["supergroup"], exclude: [-1002] }), NOW);
    const row = rows.find((r) => r.chat.id === -1002);
    expect(row?.ok).toBe(false);
    expect(row?.why).toEqual(["exclude"]);
  });

  test("limit truncates the accepted list in declaration order", () => {
    const rows = filterRecords(dialogs, filters({ limit: 3 }), NOW);
    expect(idsOf(rows)).toEqual([-1001, -1002, -1003]);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  test("limit counts accepted rows; excluded rows before the cut still report", () => {
    const rows = filterRecords(dialogs, filters({ exclude: [-1001], limit: 2 }), NOW);
    expect(idsOf(rows)).toEqual([-1001, -1002, -1003]);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.why).toEqual(["exclude"]);
    expect(rows[1]?.ok).toBe(true);
    expect(rows[2]?.ok).toBe(true);
  });

  test("limit of zero accepts nothing", () => {
    expect(filterRecords(dialogs, filters({ limit: 0 }), NOW)).toEqual([]);
  });

  test("is pure: does not mutate the records", () => {
    const snapshot = structuredClone(dialogs);
    filterRecords(
      dialogs,
      filters({ keyword: ["signal"], include: [-1003], exclude: [-1004], limit: 5 }),
      NOW,
    );
    expect(dialogs).toEqual(snapshot);
  });
});
