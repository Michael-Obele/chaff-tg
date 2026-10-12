/**
 * The pure filter engine (plan/architecture.md, "Filters as a pure function").
 *
 * `match` answers for one chat; `filterRecords` applies the whole filter set
 * in the mandated order: `include` first (force-in), then the filters via
 * `match`, then `exclude` last (wins over everything), then `limit`
 * (truncates the accepted list in declaration order).
 *
 * Both functions are pure and synchronous: no client, no clock, no
 * randomness, no output. The clock is an argument so `--inactive-days` is
 * testable without freezing time.
 */
import type { ChatRecord, Filters, Match } from "./types";

/** One evaluated record: the chat, the verdict, and the filter tokens. */
export interface FilterRow {
  chat: ChatRecord;
  ok: boolean;
  why: string[];
}

const DAY_MS = 86_400_000;

/** Empty-string entries are ignored, never treated as match-everything. */
function activeTerms(terms: string[]): string[] {
  return terms.filter((t) => t.trim() !== "");
}

/**
 * The verdict for one chat against every active filter.
 *
 * Filters combine with AND. Every active filter contributes at most one `why`
 * token, in the fixed order of the `Filters` fields; `ok` says whether all of
 * them held. Keywords, `any` and `not` combine their own members with OR and
 * match title or username, case insensitively.
 */
export function match(chat: ChatRecord, f: Filters, now: Date): Match {
  const why: string[] = [];
  let ok = true;

  const title = chat.title.toLowerCase();
  const username = chat.username === null ? null : chat.username.toLowerCase();
  /** First term contained in the title or username, or undefined. */
  const hit = (terms: string[]): string | undefined =>
    terms.find(
      (t) => title.includes(t.toLowerCase()) || (username?.includes(t.toLowerCase()) ?? false),
    );

  if (f.types !== null) {
    why.push(`type:${chat.type}`);
    if (!f.types.includes(chat.type)) ok = false;
  }

  const keyword = activeTerms(f.keyword);
  if (keyword.length > 0) {
    const matched = hit(keyword);
    // On a miss the token names the filter's first argument, per the stable format.
    why.push(`keyword:${matched ?? keyword[0]}`);
    if (matched === undefined) ok = false;
  }

  const any = activeTerms(f.any);
  if (any.length > 0) {
    const matched = hit(any);
    why.push(`any:${matched ?? any[0]}`);
    if (matched === undefined) ok = false;
  }

  const not = activeTerms(f.not);
  if (not.length > 0) {
    const matched = hit(not);
    why.push(`not:${matched ?? not[0]}`);
    // `not` inverts: a listed word rejects the chat.
    if (matched !== undefined) ok = false;
  }

  if (f.regex !== null) {
    why.push(`regex:${f.regex}`);
    // Case insensitive via the `i` flag rather than lowercasing the pattern:
    // lowercasing would silently corrupt escapes (\S -> \s, \D -> \d).
    try {
      if (!new RegExp(f.regex, "i").test(chat.title)) ok = false;
    } catch {
      // An invalid pattern never matches: a broken filter must not select
      // chats for leaving.
      ok = false;
    }
  }

  if (f.ids !== null) {
    why.push(`id:${chat.id}`);
    if (!f.ids.includes(chat.id)) ok = false;
  }

  if (f.muted !== null) {
    why.push(f.muted ? "muted" : "unmuted");
    // `null` is the account default, an unknown: it fails both directions.
    if (chat.muted !== f.muted) ok = false;
  }

  if (f.archived !== null) {
    why.push(f.archived ? "archived" : "unarchived");
    if (chat.archived !== f.archived) ok = false;
  }

  if (f.inactiveDays !== null) {
    why.push(`inactive:${f.inactiveDays}d`);
    // An empty chat (no last message) counts as inactive.
    const inactive =
      chat.lastMessageAt === null ||
      now.getTime() - Date.parse(chat.lastMessageAt) >= f.inactiveDays * DAY_MS;
    if (!inactive) ok = false;
  }

  if (f.neverPosted) {
    why.push("never-posted");
    // Unknown (field absent or null) fails: the filter is opt-in and affirmative.
    if (chat.neverPosted !== true) ok = false;
  }

  if (f.members !== null) {
    why.push(`members:${f.members.min}-${f.members.max}`);
    // Missing counts are excluded, never treated as zero.
    if (chat.members === null || chat.members < f.members.min || chat.members > f.members.max)
      ok = false;
  }

  if (f.scam) {
    why.push("scam");
    if (!chat.isScam) ok = false;
  }

  if (f.fake) {
    why.push("fake");
    if (!chat.isFake) ok = false;
  }

  if (f.unread !== null) {
    why.push(f.unread ? "unread" : "read");
    if (f.unread ? chat.unread === 0 : chat.unread > 0) ok = false;
  }

  if (f.pinned !== null) {
    why.push(f.pinned ? "pinned" : "unpinned");
    if (chat.pinned !== f.pinned) ok = false;
  }

  return { ok, why };
}

/**
 * Apply the whole filter set to a list of records, in the mandated order:
 * `include` first (force-in with why `["include"]`), then the filters via
 * `match`, then `exclude` last (why `["exclude"]`, wins over include and the
 * filters), then `limit` (stops once `limit` rows are accepted; rows after
 * the cut are not evaluated).
 *
 * Rows keep declaration order. Every record appears unless `limit` truncates
 * it; callers pick the accepted ones with `row.ok`.
 */
export function filterRecords(records: ChatRecord[], f: Filters, now: Date): FilterRow[] {
  const rows: FilterRow[] = [];
  const included = new Set(f.include);
  const excluded = new Set(f.exclude);
  let accepted = 0;

  for (const chat of records) {
    if (f.limit !== null && accepted >= f.limit) break;

    if (excluded.has(chat.id)) {
      rows.push({ chat, ok: false, why: ["exclude"] });
      continue;
    }
    if (included.has(chat.id)) {
      rows.push({ chat, ok: true, why: ["include"] });
      accepted++;
      continue;
    }

    const m = match(chat, f, now);
    rows.push({ chat, ok: m.ok, why: m.why });
    if (m.ok) accepted++;
  }

  return rows;
}
