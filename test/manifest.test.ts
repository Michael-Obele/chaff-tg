/**
 * The review manifest: schema, round trip, and the refusal paths
 * (plan/cli.md, "The review manifest"; plan/architecture.md, "Testing").
 *
 * Contract under test:
 * - `serializeManifest` writes a stable key order, 2-space indent and a
 *   trailing newline; `filters` carries only the fields that are set.
 * - `parseManifest` round-trips the canonical plan/cli.md example deep-equal.
 * - Refusals carry the right `ManifestError` code: unknown `version` ->
 *   `unknown-version`, a wrong type on a known key or a missing required key
 *   -> `malformed`, broken JSON -> `not-json`. The unknown-version message
 *   names both the file's version and the supported one.
 * - Unknown extra keys are ignored, never errors (forward compatibility).
 * - `parseManifest` re-hydrates every unset filter to its engine-safe default,
 *   so the parsed `filters` is a complete `Filters` the engine can consume.
 */
import { describe, expect, test } from "bun:test";
import { filterRecords } from "../src/core/filters";
import {
  MANIFEST_VERSION,
  ManifestError,
  parseManifest,
  serializeManifest,
} from "../src/core/manifest";
import type { ChatRecord, Filters, Plan, PlanChat } from "../src/core/types";

/**
 * The chat from the canonical example (plan/cli.md, "The review manifest").
 * Two additions the draft JSON omits: `isVerified`, which `ChatRecord`
 * requires, and nothing else.
 */
const CHAT: PlanChat = {
  id: -1001234567890,
  type: "channel",
  title: "Big Signals Premium",
  username: "bigsignals",
  members: 4821,
  muted: true,
  archived: false,
  pinned: false,
  unread: 412,
  isScam: true,
  isFake: false,
  isVerified: false,
  lastMessageAt: "2024-08-02T09:12:00Z",
  why: ["keyword:signal", "muted", "inactive:365d"],
};

/** The state the engine treats as "no filter": every key at its unset default. */
const UNSET_FILTERS: Filters = {
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
 * The canonical example as a Plan-shaped object. The draft JSON writes the
 * type filter as `type`; the serialized form uses the `Filters` field name
 * `types` (src/core/types.ts), everything else matches key for key. The
 * filter set is a full `Filters` carrying the same three fields, since the
 * unset ones serialize away and come back from `parseManifest`.
 */
const EXAMPLE: Plan = {
  version: 1,
  createdAt: "2026-10-11T13:04:00Z",
  account: { id: 1234567, username: "example" },
  filters: { ...UNSET_FILTERS, types: ["channel", "supergroup"], muted: true, inactiveDays: 365 },
  summary: { matched: 37, estimatedSeconds: 52 },
  chats: [CHAT],
};

/**
 * A full filter set with three keys set and fifteen unset, so a parsed
 * manifest exercises both halves of the re-hydration contract.
 */
const SET_FILTERS: Filters = {
  ...UNSET_FILTERS,
  types: ["channel", "supergroup"],
  muted: true,
  not: ["airdrop"],
};

/** The shared dialog fixture, read the same way `filters.test.ts` reads it. */
const DIALOGS = (await Bun.file(
  new URL("./fixtures/dialogs.json", import.meta.url),
).json()) as ChatRecord[];

/** Fixed clock for the engine call; none of the assertions depend on drift. */
const PARSE_NOW = new Date("2026-10-11T00:00:00Z");

/** Run `fn`, require a `ManifestError`, and hand it back for further asserts. */
function caughtManifestError(fn: () => unknown): ManifestError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestError);
    expect(error).toBeInstanceOf(Error);
    expect((error as ManifestError).name).toBe("ManifestError");
    return error as ManifestError;
  }
  throw new Error("expected a ManifestError, but nothing was thrown");
}

/** Serialize the example, let `edit` rewrite the raw JSON, re-serialize. */
function edited(edit: (raw: Record<string, any>) => void): string {
  const raw = JSON.parse(serializeManifest(EXAMPLE)) as Record<string, any>;
  edit(raw);
  return JSON.stringify(raw);
}

describe("MANIFEST_VERSION", () => {
  test("is pinned to 1", () => {
    expect(MANIFEST_VERSION).toBe(1);
  });
});

describe("serializeManifest", () => {
  test("round-trips the plan/cli.md example through parseManifest", () => {
    expect(parseManifest(serializeManifest(EXAMPLE))).toEqual(EXAMPLE);
  });

  test("round-trips nullable and optional chat fields", () => {
    const plan: Plan = {
      ...EXAMPLE,
      chats: [{ ...CHAT, username: null, members: null, lastMessageAt: null, neverPosted: true }],
    };
    expect(parseManifest(serializeManifest(plan))).toEqual(plan);
  });

  test("writes 2-space indent and exactly one trailing newline", () => {
    const out = serializeManifest(EXAMPLE);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out).toContain('\n  "version": 1,\n');
    expect(out).toContain('\n    "matched": 37,\n');
    expect(out).toContain('\n      "why": [\n');
  });

  test("keeps a stable key order across serializations", () => {
    const first = serializeManifest(EXAMPLE);
    const second = serializeManifest(EXAMPLE);
    expect(first).toBe(second);

    const json = JSON.parse(first);
    expect(Object.keys(json)).toEqual([
      "version",
      "createdAt",
      "account",
      "filters",
      "summary",
      "chats",
    ]);
    expect(Object.keys(json.account)).toEqual(["id", "username"]);
    expect(Object.keys(json.filters)).toEqual(["types", "muted", "inactiveDays"]);
    expect(Object.keys(json.summary)).toEqual(["matched", "estimatedSeconds"]);
    expect(Object.keys(json.chats[0])).toEqual([
      "id",
      "type",
      "title",
      "username",
      "members",
      "muted",
      "archived",
      "pinned",
      "unread",
      "isScam",
      "isFake",
      "isVerified",
      "lastMessageAt",
      "why",
    ]);
  });

  test("drops unset filters, keeps a nullable false as a direction", () => {
    const plan: Plan = {
      ...EXAMPLE,
      filters: {
        types: null,
        keyword: [],
        any: [],
        not: [],
        regex: null,
        ids: null,
        muted: false,
        archived: null,
        inactiveDays: null,
        neverPosted: false,
        members: null,
        scam: false,
        fake: false,
        unread: false,
        pinned: null,
        include: [],
        exclude: [],
        limit: null,
      },
    };
    const json = JSON.parse(serializeManifest(plan));
    // Kept: `muted: false` (--not-muted) and `unread: false` (--read) are
    // directions. Dropped: nulls, empty term lists, and the plain-boolean
    // switches (`neverPosted`/`scam`/`fake`) where false means unset.
    expect(Object.keys(json.filters)).toEqual(["muted", "unread"]);
  });

  test("always writes every top-level key, even with no filters set", () => {
    const json = JSON.parse(serializeManifest({ ...EXAMPLE, filters: UNSET_FILTERS }));
    expect(Object.keys(json)).toEqual([
      "version",
      "createdAt",
      "account",
      "filters",
      "summary",
      "chats",
    ]);
    expect(json.filters).toEqual({});
  });
});

describe("parseManifest", () => {
  test("refuses an unknown version, naming it and the supported one", () => {
    const err = caughtManifestError(() =>
      parseManifest(JSON.stringify({ ...EXAMPLE, version: 2 })),
    );
    expect(err.code).toBe("unknown-version");
    expect(err.message).toContain("version 2");
    expect(err.message).toContain("version 1");
  });

  test("refuses a version of the wrong type as malformed", () => {
    const err = caughtManifestError(() =>
      parseManifest(JSON.stringify({ ...EXAMPLE, version: "2" })),
    );
    expect(err.code).toBe("malformed");
  });

  test("refuses a manifest with no version", () => {
    const { version, ...rest } = EXAMPLE;
    const err = caughtManifestError(() => parseManifest(JSON.stringify(rest)));
    expect(err.code).toBe("malformed");
  });

  test("refuses a manifest with no chats", () => {
    const { chats, ...rest } = EXAMPLE;
    const err = caughtManifestError(() => parseManifest(JSON.stringify(rest)));
    expect(err.code).toBe("malformed");
  });

  test("refuses a chat whose id is a string", () => {
    const err = caughtManifestError(() =>
      parseManifest(edited((raw) => (raw.chats[0].id = "-1001234567890"))),
    );
    expect(err.code).toBe("malformed");
  });

  test("refuses a chat with any wrong-typed field", () => {
    const err = caughtManifestError(() =>
      parseManifest(edited((raw) => (raw.chats[0].title = 42))),
    );
    expect(err.code).toBe("malformed");
  });

  test("refuses a chat whose type is not a known chat type", () => {
    const err = caughtManifestError(() =>
      parseManifest(edited((raw) => (raw.chats[0].type = "dm"))),
    );
    expect(err.code).toBe("malformed");
  });

  test("refuses invalid JSON", () => {
    const err = caughtManifestError(() => parseManifest('{ "version": 1,'));
    expect(err.code).toBe("not-json");
  });

  test("refuses JSON that is not an object", () => {
    const err = caughtManifestError(() => parseManifest('"hello"'));
    expect(err.code).toBe("malformed");
  });

  test("ignores unknown extra top-level keys", () => {
    const text = edited((raw) => (raw.futureField = { anything: true }));
    const parsed = parseManifest(text);
    expect(parsed).toEqual(EXAMPLE);
    expect(serializeManifest(parsed)).toBe(serializeManifest(EXAMPLE));
  });

  test("ignores unknown extra keys inside a chat", () => {
    const text = edited((raw) => (raw.chats[0].futureField = 1));
    expect(parseManifest(text)).toEqual(EXAMPLE);
  });
});

describe("parseManifest, filter re-hydration", () => {
  test("re-hydrates every unset filter to its engine-safe default", () => {
    const parsed = parseManifest(serializeManifest({ ...EXAMPLE, filters: SET_FILTERS }));
    // The parsed filters are a complete `Filters`, in declaration order.
    const complete: Filters = parsed.filters;
    expect(Object.keys(complete)).toEqual([
      "types",
      "keyword",
      "any",
      "not",
      "regex",
      "ids",
      "muted",
      "archived",
      "inactiveDays",
      "neverPosted",
      "members",
      "scam",
      "fake",
      "unread",
      "pinned",
      "include",
      "exclude",
      "limit",
    ]);
    expect(Object.keys(complete)).toHaveLength(18);
    // Set keys keep their values; unset keys get their defaults.
    expect(complete.types).toEqual(["channel", "supergroup"]);
    expect(complete.not).toEqual(["airdrop"]);
    expect(complete.muted).toBe(true);
    expect(complete.keyword).toEqual([]);
    expect(complete.any).toEqual([]);
    expect(complete.include).toEqual([]);
    expect(complete.exclude).toEqual([]);
    expect(complete.neverPosted).toBe(false);
    expect(complete.scam).toBe(false);
    expect(complete.fake).toBe(false);
    expect(complete.regex).toBeNull();
    expect(complete.ids).toBeNull();
    expect(complete.archived).toBeNull();
    expect(complete.inactiveDays).toBeNull();
    expect(complete.members).toBeNull();
    expect(complete.unread).toBeNull();
    expect(complete.pinned).toBeNull();
    expect(complete.limit).toBeNull();
  });

  test("feeds the parsed filters straight into filterRecords", () => {
    const parsed = parseManifest(serializeManifest({ ...EXAMPLE, filters: SET_FILTERS }));
    // This is the crash the finding describes: before re-hydration, the parsed
    // filter set lacked `keyword`/`include`/`exclude` and the engine threw on
    // the first array access.
    const rows = filterRecords(DIALOGS, parsed.filters, PARSE_NOW);
    expect(rows).toHaveLength(DIALOGS.length);
    expect(rows.filter((r) => r.ok).map((r) => r.chat.id)).toEqual([
      -1001, // channel, muted, not an airdrop
      -1002, // supergroup, muted
      -1005, // channel, muted
      -1012, // supergroup, muted; -1010 is rejected by `not: ["airdrop"]`
    ]);
  });

  test("round-trips byte-for-byte and still drops unset filters on re-serialize", () => {
    const text = serializeManifest({ ...EXAMPLE, filters: SET_FILTERS });
    const parsed = parseManifest(text);
    // `setFilters` is untouched: re-serializing a re-hydrated plan writes the
    // same bytes as the input, so the drop-unset behavior is unchanged.
    expect(serializeManifest(parsed)).toBe(text);
    expect(Object.keys(JSON.parse(serializeManifest(parsed)).filters)).toEqual([
      "types",
      "not",
      "muted",
    ]);
  });

  test("keeps a serialized `types: []` rejecting everything and `muted: false`", () => {
    const text = edited((raw) => {
      raw.filters = { types: [], muted: false };
    });
    const parsed = parseManifest(text);
    // An empty array rejects every chat; it must not be re-hydrated to `null`
    // (which would match everything).
    expect(parsed.filters.types).toEqual([]);
    // A serialized `false` is a direction (--not-muted); it must stay `false`,
    // not become `null` (which would mean "use the account default").
    expect(parsed.filters.muted).toBe(false);
    const rows = filterRecords(DIALOGS, parsed.filters, PARSE_NOW);
    expect(rows).toHaveLength(DIALOGS.length);
    expect(rows.every((r) => !r.ok)).toBe(true);
  });
});
