/**
 * The review manifest: valibot schemas, read and write, version pinned
 * (plan/cli.md, "The review manifest"; plan/distribution.md, "Versioning").
 *
 * The manifest is the contract between "what I reviewed" and "what I left":
 * `chaff report` writes it, `chaff leave --from` reads it back. Reads are
 * strict about the format version and the types of known keys, lenient about
 * unknown keys so a newer file still loads where it can. Writes are
 * byte-stable: fixed key order, 2-space indent, trailing newline.
 *
 * Core rules hold: no stdout, no network, no clock. `ManifestError.code` is
 * the machine-readable reason; the message is a plain sentence users read.
 */
import * as v from "valibot";
import type { ChatRecord, ChatType, Filters } from "./types";

/** The one manifest format this build writes and the only one it reads. */
export const MANIFEST_VERSION = 1;

/** Why a manifest was refused. Users read the message; scripts read the code. */
export type ManifestErrorCode = "unknown-version" | "malformed" | "not-json";

/** Refuses a manifest that cannot be trusted, with a plain message. */
export class ManifestError extends Error {
  readonly code: ManifestErrorCode;

  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

/** The account the manifest was written for (Task 4 moves this to types.ts). */
export interface AccountShape {
  id: number;
  username: string | null;
}

/** One reviewed chat: the normalized record plus why it was selected. */
export type PlanChatShape = ChatRecord & { why: string[] };

/**
 * The manifest as a typed object, structurally what Task 4 will call `Plan`.
 * `filters` is partial: serialization drops the fields that are unset, so a
 * parsed manifest carries only the filters that were actually set.
 */
export interface PlanShape {
  version: typeof MANIFEST_VERSION;
  createdAt: string;
  account: AccountShape;
  filters: Partial<Filters>;
  summary: { matched: number; estimatedSeconds: number };
  chats: PlanChatShape[];
}

/** Every chat type Telegram reports; kept in sync with `ChatType`. */
const CHAT_TYPES: readonly ChatType[] = [
  "group",
  "supergroup",
  "channel",
  "gigagroup",
  "monoforum",
  "community",
];

/** Ids, counts and limits are integers; a fractional one is malformed. */
const int = v.pipe(v.number(), v.integer());
const chatType = v.picklist(CHAT_TYPES);

/**
 * The normalized record as it lands in a manifest (types.ts, `ChatRecord`).
 * `neverPosted` is opt-in, so it is the only optional field.
 */
export const chatRecordSchema = v.object({
  id: int,
  type: chatType,
  title: v.string(),
  username: v.nullable(v.string()),
  members: v.nullable(int),
  muted: v.nullable(v.boolean()),
  archived: v.boolean(),
  pinned: v.boolean(),
  unread: int,
  isScam: v.boolean(),
  isFake: v.boolean(),
  isVerified: v.boolean(),
  lastMessageAt: v.nullable(v.string()),
  neverPosted: v.optional(v.nullable(v.boolean())),
});

/**
 * The serialized filter set: every field optional, so only the fields that
 * were set when the report was written appear. Known fields are type-checked
 * strictly; unknown fields are ignored (forward compatibility).
 */
export const filtersSchema = v.object({
  types: v.optional(v.nullable(v.array(chatType))),
  keyword: v.optional(v.array(v.string())),
  any: v.optional(v.array(v.string())),
  not: v.optional(v.array(v.string())),
  regex: v.optional(v.nullable(v.string())),
  ids: v.optional(v.nullable(v.array(int))),
  muted: v.optional(v.nullable(v.boolean())),
  archived: v.optional(v.nullable(v.boolean())),
  inactiveDays: v.optional(v.nullable(int)),
  neverPosted: v.optional(v.boolean()),
  members: v.optional(
    v.nullable(
      v.object({
        min: int,
        max: int,
      }),
    ),
  ),
  scam: v.optional(v.boolean()),
  fake: v.optional(v.boolean()),
  unread: v.optional(v.nullable(v.boolean())),
  pinned: v.optional(v.nullable(v.boolean())),
  include: v.optional(v.array(int)),
  exclude: v.optional(v.array(int)),
  limit: v.optional(v.nullable(int)),
});

/** One manifest chat: the record plus the `why` tokens that selected it. */
const planChatSchema = v.object({
  ...chatRecordSchema.entries,
  why: v.array(v.string()),
});

/** The whole manifest, pinned to `MANIFEST_VERSION`. */
export const planSchema = v.object({
  version: v.literal(MANIFEST_VERSION),
  createdAt: v.string(),
  account: v.object({
    id: int,
    username: v.nullable(v.string()),
  }),
  filters: filtersSchema,
  summary: v.object({
    matched: int,
    estimatedSeconds: int,
  }),
  chats: v.array(planChatSchema),
});

/** Keep only the fields that are set, in `Filters` declaration order. */
function setFilters(f: Partial<Filters>): Partial<Filters> {
  const out: Partial<Filters> = {};
  if (f.types != null) out.types = f.types;
  if (f.keyword != null && f.keyword.length > 0) out.keyword = f.keyword;
  if (f.any != null && f.any.length > 0) out.any = f.any;
  if (f.not != null && f.not.length > 0) out.not = f.not;
  if (f.regex != null) out.regex = f.regex;
  if (f.ids != null) out.ids = f.ids;
  if (f.muted != null) out.muted = f.muted;
  if (f.archived != null) out.archived = f.archived;
  if (f.inactiveDays != null) out.inactiveDays = f.inactiveDays;
  if (f.neverPosted) out.neverPosted = f.neverPosted;
  if (f.members != null) out.members = f.members;
  if (f.scam) out.scam = f.scam;
  if (f.fake) out.fake = f.fake;
  if (f.unread != null) out.unread = f.unread;
  if (f.pinned != null) out.pinned = f.pinned;
  if (f.include != null && f.include.length > 0) out.include = f.include;
  if (f.exclude != null && f.exclude.length > 0) out.exclude = f.exclude;
  if (f.limit != null) out.limit = f.limit;
  return out;
}

/**
 * Write a manifest: fixed key order, 2-space indent, one trailing newline.
 *
 * The six top-level keys are always present. `filters` carries only the
 * fields that are set: nulls, empty term lists and plain-boolean switches at
 * `false` drop out, while a nullable boolean at `false` is a direction
 * (`--not-muted`, `--read`) and stays.
 */
export function serializeManifest(p: PlanShape): string {
  const out = {
    version: p.version,
    createdAt: p.createdAt,
    account: {
      id: p.account.id,
      username: p.account.username,
    },
    filters: setFilters(p.filters),
    summary: {
      matched: p.summary.matched,
      estimatedSeconds: p.summary.estimatedSeconds,
    },
    chats: p.chats.map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      username: c.username,
      members: c.members,
      muted: c.muted,
      archived: c.archived,
      pinned: c.pinned,
      unread: c.unread,
      isScam: c.isScam,
      isFake: c.isFake,
      isVerified: c.isVerified,
      lastMessageAt: c.lastMessageAt,
      // `undefined` (never searched) vanishes in JSON; `null` stays.
      neverPosted: c.neverPosted,
      why: c.why,
    })),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Read a manifest, or throw a `ManifestError` a user can act on:
 *
 * - `not-json` — the text is not JSON at all.
 * - `unknown-version` — a version this build does not know; the message
 *   names the file's version and the supported one.
 * - `malformed` — a known key has the wrong type, or a required key is
 *   missing. Unknown keys are ignored, not rejected.
 */
export function parseManifest(text: string): PlanShape {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError("not-json", `manifest is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestError("malformed", "manifest must be a JSON object");
  }

  const record = raw as Record<string, unknown>;
  if (!("version" in record)) {
    throw new ManifestError("malformed", 'manifest is missing its "version"');
  }
  if (typeof record.version !== "number") {
    throw new ManifestError(
      "malformed",
      `manifest "version" must be a number, got ${JSON.stringify(record.version)}`,
    );
  }
  if (record.version !== MANIFEST_VERSION) {
    throw new ManifestError(
      "unknown-version",
      `manifest version ${record.version} is not supported; ` +
        `this version of chaff reads manifest version ${MANIFEST_VERSION}.`,
    );
  }

  const parsed = v.safeParse(planSchema, raw);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    if (issue === undefined) {
      throw new ManifestError("malformed", "manifest is malformed");
    }
    const where = v.getDotPath(issue);
    throw new ManifestError(
      "malformed",
      `manifest is malformed${where ? ` at "${where}"` : ""}: ${issue.message}`,
    );
  }
  return parsed.output;
}
