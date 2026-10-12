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
 *
 * A manifest is a `Plan` (src/core/types.ts) and has no type of its own: it is
 * the object `buildPlan` hands back. `filters` is the one field the file is
 * allowed to thin out, so `parseManifest` re-hydrates it (see `hydrateFilters`)
 * and the declared type stays honest.
 */
import * as v from "valibot";
import type { ChatType, Filters, Plan, PlanChat } from "./types";

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
 *
 * `manuallyUnread` arrived after version 1 and is therefore the one optional
 * field: a manifest written before it parses, and a missing value is read as
 * `false` (Telegram's default) by `parseManifest`.
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
  manuallyUnread: v.optional(v.boolean()),
  isScam: v.boolean(),
  isFake: v.boolean(),
  isVerified: v.boolean(),
  lastMessageAt: v.nullable(v.string()),
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

/**
 * Compile-time tie: the schema's pinned version and `Plan["version"]`
 * (src/core/types.ts) are the same number. Changing one without the other is a
 * type error here, rather than a manifest that writes one version and claims
 * another.
 */
const planVersion: Plan["version"] = MANIFEST_VERSION;

/** The whole manifest, pinned to `MANIFEST_VERSION`. */
export const planSchema = v.object({
  version: v.literal(planVersion),
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

/** Every field at the value the engine treats as "not set". Fresh each call. */
function defaultFilters(): Filters {
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
    unread: null,
    pinned: null,
    include: [],
    exclude: [],
    limit: null,
  };
}

/**
 * Complete a serialized filter set, the inverse of `setFilters`.
 *
 * `??` restores only what is absent (`undefined`), so a serialized value is
 * never flattened into its default: an empty array stays an empty array (it
 * rejects everything, unlike `null`, which matches everything), and a
 * nullable boolean at `false` stays a direction (`--not-muted`, `--read`).
 * Keys whose unset state is `null` come back as `null` either way.
 */
function hydrateFilters(serialized: Partial<Filters>): Filters {
  const d = defaultFilters();
  return {
    types: serialized.types ?? d.types,
    keyword: serialized.keyword ?? d.keyword,
    any: serialized.any ?? d.any,
    not: serialized.not ?? d.not,
    regex: serialized.regex ?? d.regex,
    ids: serialized.ids ?? d.ids,
    muted: serialized.muted ?? d.muted,
    archived: serialized.archived ?? d.archived,
    inactiveDays: serialized.inactiveDays ?? d.inactiveDays,
    members: serialized.members ?? d.members,
    scam: serialized.scam ?? d.scam,
    fake: serialized.fake ?? d.fake,
    unread: serialized.unread ?? d.unread,
    pinned: serialized.pinned ?? d.pinned,
    include: serialized.include ?? d.include,
    exclude: serialized.exclude ?? d.exclude,
    limit: serialized.limit ?? d.limit,
  };
}

/**
 * Write a manifest: fixed key order, 2-space indent, one trailing newline.
 *
 * The six top-level keys are always present. `filters` carries only the
 * fields that are set: nulls, empty term lists and plain-boolean switches at
 * `false` drop out, while a nullable boolean at `false` is a direction
 * (`--not-muted`, `--read`) and stays.
 */
export function serializeManifest(p: Plan): string {
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
      manuallyUnread: c.manuallyUnread,
      isScam: c.isScam,
      isFake: c.isFake,
      isVerified: c.isVerified,
      lastMessageAt: c.lastMessageAt,
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
 *
 * The returned plan carries a complete `Filters`: the fields serialization
 * dropped are re-hydrated to their engine-safe defaults, so the declared type
 * is true and the filters can go straight back into the engine.
 */
export function parseManifest(text: string): Plan {
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
  const plan = parsed.output;
  // `manuallyUnread` is optional in the schema so a manifest written before the
  // field existed still parses. Its default is `false` (Telegram's) and
  // `PlanChat` declares it present, so it is filled in here rather than left
  // `undefined` behind a type that promises otherwise.
  return {
    ...plan,
    filters: hydrateFilters(plan.filters),
    chats: plan.chats.map((chat) => ({ ...chat, manuallyUnread: chat.manuallyUnread ?? false })),
  };
}
