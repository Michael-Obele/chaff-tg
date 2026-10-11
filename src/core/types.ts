/**
 * Normalized domain types for chaff-tg.
 *
 * `ChatRecord` is the one shape every filter can see, built once from the
 * mtcute objects (plan/architecture.md, "The normalized record"). The core
 * never touches mtcute types outside `src/core/telegram.ts`.
 */

/** The chat types Telegram reports, normalized to stable strings. */
export type ChatType = "group" | "supergroup" | "channel" | "gigagroup" | "monoforum" | "community";

/** One dialog, normalized. This is also the shape that lands in a manifest. */
export interface ChatRecord {
  /** Marked id; negative for chats. */
  id: number;
  type: ChatType;
  title: string;
  /** `null` when the chat is private. */
  username: string | null;
  /** Can be `null` for large chats; a missing count is never treated as zero. */
  members: number | null;
  /** `null` means "use the account default". */
  muted: boolean | null;
  archived: boolean;
  pinned: boolean;
  unread: number;
  isScam: boolean;
  isFake: boolean;
  isVerified: boolean;
  /** ISO 8601 UTC; `null` for empty chats (never posted in). */
  lastMessageAt: string | null;
  /** Opt-in field: whether the account holder has ever posted here. */
  neverPosted?: boolean | null;
}

/**
 * The filter set every command accepts (plan/cli.md, "Filters").
 *
 * `null` (and, for the switch-style flags, `false`) means unset. Empty arrays
 * are also unset. Keywords, `any` and `not` combine their own members with OR;
 * the different filters combine with AND.
 */
export interface Filters {
  types: ChatType[] | null;
  /** Match title or username, case insensitive. Empty strings are ignored. */
  keyword: string[];
  /** OR of many words; same semantics as `keyword`, kept for script readability. */
  any: string[];
  /** Reject chats whose title or username contains any of these. */
  not: string[];
  /** Match title with a regular expression, case insensitive. */
  regex: string | null;
  ids: number[] | null;
  muted: boolean | null;
  archived: boolean | null;
  /** Last message at least n days before `now`; `lastMessageAt: null` counts as inactive. */
  inactiveDays: number | null;
  neverPosted: boolean;
  /** Inclusive range; chats with a missing count are excluded, not treated as zero. */
  members: { min: number; max: number } | null;
  scam: boolean;
  fake: boolean;
  unread: boolean | null;
  pinned: boolean | null;
  /** Force-include these ids even if a filter would drop them. */
  include: number[];
  /** Never touch these ids. Applied last; wins over everything. */
  exclude: number[];
  /** Maximum accepted rows; truncates in declaration order. `null` = no cap. */
  limit: number | null;
}

/** The verdict for one chat: does it match, and which filters said so. */
export interface Match {
  ok: boolean;
  /**
   * One stable, machine-readable token per active filter, in the fixed order
   * of the `Filters` fields: `type:channel`, `keyword:signal`, `any:vip`,
   * `not:airdrop`, `regex:^Rust`, `id:-1001`, `muted`/`unmuted`,
   * `archived`/`unarchived`, `inactive:365d`, `never-posted`, `members:0-50`,
   * `scam`, `fake`, `unread`/`read`, `pinned`/`unpinned` — plus `include` and
   * `exclude` from `filterRecords`. `ok` gives the direction of the verdict.
   */
  why: string[];
}
