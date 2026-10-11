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
 */
import { describe, expect, test } from "bun:test";
import {
  MANIFEST_VERSION,
  ManifestError,
  parseManifest,
  serializeManifest,
  type PlanChatShape,
  type PlanShape,
} from "../src/core/manifest";

/**
 * The chat from the canonical example (plan/cli.md, "The review manifest").
 * Two additions the draft JSON omits: `isVerified`, which `ChatRecord`
 * requires, and nothing else.
 */
const CHAT: PlanChatShape = {
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

/**
 * The canonical example as a Plan-shaped object. The draft JSON writes the
 * type filter as `type`; the serialized form uses the `Filters` field name
 * `types` (src/core/types.ts), everything else matches key for key.
 */
const EXAMPLE: PlanShape = {
  version: 1,
  createdAt: "2026-10-11T13:04:00Z",
  account: { id: 1234567, username: "example" },
  filters: { types: ["channel", "supergroup"], muted: true, inactiveDays: 365 },
  summary: { matched: 37, estimatedSeconds: 52 },
  chats: [CHAT],
};

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
    const plan: PlanShape = {
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
    const plan: PlanShape = {
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
    const json = JSON.parse(serializeManifest({ ...EXAMPLE, filters: {} }));
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
