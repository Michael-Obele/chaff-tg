/**
 * Named filter groups: saved fragments of the filter set, the thing behind
 * `--group` (`plan/groups.md`).
 *
 * A group is a name and any subset of `Filters`. The file is the user's, so it
 * is hand-editable: JSON, two space indent, mode 644, no secret in it. Not
 * inside `config.json` (that file carries the api hash and `chaff login` is its
 * only writer, at mode 600) and not inside `journal.db` (SQLite cannot be
 * edited with an editor, and `chaff logout` deletes it).
 *
 * The keys are the `Filters` field names, the same spellings the manifest uses,
 * so a group fragment and a manifest's `filters` block look alike. Values are
 * validated by `filtersSchema` from src/core/manifest.ts: one definition of
 * what a filter field holds, shared by both files.
 *
 * Four keys are refused rather than ignored: `ids`, `include`, `exclude` and
 * `limit` do not describe a kind of chat. `exclude` in particular beats
 * everything including the checklist (src/core/filters.ts, `filterRecords`), so
 * a group that could hold one could quietly change what a run refuses to touch,
 * from a file nobody is looking at.
 *
 * Core rules hold (plan/architecture.md, "Repo layout"): no import from
 * `src/cli` or `src/tui`, no stdout or stderr, no network, no clock.
 *
 * `node:fs` sync APIs, the same choice `loadConfig` makes and for the same
 * reason: the front end resolves its paths synchronously, and `Bun.write` takes
 * no mode, so a file that must be born 644 cannot be created with it
 * (AGENTS.md rule 5).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";
import { EXIT } from "./errors";
import { filtersSchema, setFilters } from "./manifest";
import type { Filters } from "./types";

/** The schema version this build writes, and the highest it will read. */
export const GROUPS_VERSION = 1;

/** One saved fragment: any subset of the filter fields. */
export type GroupFilter = Partial<Filters>;

/** A group name to its fragment. Key order is the order `chaff groups` prints. */
export type Groups = Record<string, GroupFilter>;

/**
 * What a group may hold: the fields that describe a *kind* of chat. Everything
 * here is a `Filters` key, so `--group` can only ever produce a filter set the
 * engine already understands.
 */
export const GROUP_KEYS = [
  "types",
  "keyword",
  "any",
  "not",
  "regex",
  "muted",
  "archived",
  "inactiveDays",
  "members",
  "scam",
  "fake",
  "banned",
  "unavailable",
  "unread",
  "pinned",
] as const;

export type GroupKey = (typeof GROUP_KEYS)[number];

/**
 * Refused by name, not dropped: a file that holds one is a user who meant
 * something, and the answer is to say so. See the header.
 */
const FORBIDDEN_KEYS = ["ids", "include", "exclude", "limit"] as const;

/** The fields whose lists widen the net when two sources both set them. */
export const UNION_KEYS: readonly GroupKey[] = ["types", "keyword", "any", "not"];

/** Why a groups file, a name, or a combination was refused. */
export type GroupsErrorCode =
  | "not-json"
  | "malformed"
  | "unreadable"
  | "unknown-group"
  | "bad-name"
  | "forbidden-key"
  | "conflict";

/**
 * A groups file the user has to fix, or a group that cannot be used.
 *
 * Carries exit 2 (`plan/cli.md`: bad usage). A plain class rather than a
 * `ChaffError` for the reason `NotLoggedInError` gives (src/cli/client.ts): that
 * type means "a Telegram failure, already classified", and none of this came
 * from Telegram. `exitCodeOf` in src/cli/index.ts maps it.
 */
export class GroupsError extends Error {
  readonly code: GroupsErrorCode;
  readonly exitCode: number = EXIT.USAGE;

  constructor(code: GroupsErrorCode, message: string) {
    super(message);
    this.name = "GroupsError";
    this.code = code;
  }
}

/**
 * A group name: letters, digits, `.`, `_`, `-`, starting with a letter or
 * digit, at most 64. The same shape `config.ts` requires of a session name,
 * for the same reason: it is typed on a command line and printed in a list.
 */
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A fragment: only the documented keys, each validated by the manifest's own
 * schema so the two files can never disagree about what `inactiveDays` means.
 */
const fragmentSchema = v.pick(filtersSchema, [...GROUP_KEYS]);

/** A JSON object root, or nothing else. An array is not a group map. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The errno code, which names a failure without quoting file content. */
function unreadableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && code !== "" ? code : "unknown error";
}

/** Refuse a name that cannot be typed back. */
export function checkGroupName(name: string): string {
  if (!GROUP_NAME.test(name)) {
    throw new GroupsError(
      "bad-name",
      `group name ${JSON.stringify(name)} is not usable: expected letters, digits, . _ -, starting with a letter or digit`,
    );
  }
  return name;
}

/** The message for a key a group may not hold, with what is allowed. */
function forbiddenMessage(path: string, name: string, key: string): string {
  return (
    `groups file at ${path}: "${key}" is not allowed in a group "${name}". ` +
    `A group holds ${GROUP_KEYS.join(", ")}. It cannot hold ${FORBIDDEN_KEYS.join(", ")}: ` +
    "those name particular chats or cap one run, and `exclude` beats the checklist."
  );
}

/**
 * One fragment: refuse a forbidden key, drop an unknown one, type-check the
 * rest.
 *
 * Unknown keys are dropped, not rejected, so a file written by a newer build
 * still loads here, the same forward compatibility `config.ts` and the manifest
 * give. A forbidden key is refused because it is a documented key of `Filters`
 * that this format deliberately excludes: dropping it silently would leave a
 * group that looks like it excludes chats and does not.
 */
function parseFragment(name: string, raw: unknown, path: string): GroupFilter {
  if (!isRecord(raw)) {
    throw new GroupsError(
      "malformed",
      `groups file at ${path} is malformed: group "${name}" must be an object of filter fields.`,
    );
  }
  for (const key of FORBIDDEN_KEYS) {
    if (key in raw) throw new GroupsError("forbidden-key", forbiddenMessage(path, name, key));
  }
  const kept: Record<string, unknown> = {};
  for (const key of GROUP_KEYS) {
    if (key in raw) kept[key] = raw[key];
  }
  const parsed = v.safeParse(fragmentSchema, kept);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    // Installed valibot v1 returns a dotted string (or null), not a path
    // array; guard the undefined issue first because getDotPath dereferences.
    const dotPath = issue === undefined ? null : v.getDotPath(issue);
    const where = dotPath === null || dotPath === "" ? "" : ` at "${dotPath}"`;
    throw new GroupsError(
      "malformed",
      `groups file at ${path} is malformed${where}: ${
        issue?.message ?? "expected the documented filter fields"
      }`,
    );
  }
  return parsed.output as GroupFilter;
}

/**
 * Read the file's text into a group map, or refuse it.
 *
 * Messages name the path and never echo the content, the rule `config.ts` keeps
 * for the api hash. There is no secret here, but quoting back a line the user
 * did not mean to write is still the wrong diagnosis.
 */
export function parseGroups(text: string, path: string): Groups {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GroupsError("not-json", `groups file at ${path} is not valid JSON.`);
  }
  if (!isRecord(raw)) {
    throw new GroupsError(
      "malformed",
      `groups file at ${path} is malformed: expected a JSON object with a "groups" key.`,
    );
  }

  const version = raw.version ?? GROUPS_VERSION;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new GroupsError("malformed", `groups file at ${path} is malformed at "version".`);
  }
  if (version > GROUPS_VERSION) {
    throw new GroupsError(
      "malformed",
      `groups file at ${path} was written by a newer version of chaff (version ${version}).`,
    );
  }

  const map = raw.groups ?? {};
  if (!isRecord(map)) {
    throw new GroupsError(
      "malformed",
      `groups file at ${path} is malformed at "groups": expected an object of name to fields.`,
    );
  }

  const groups: Groups = {};
  for (const [name, fragment] of Object.entries(map)) {
    groups[checkGroupName(name)] = parseFragment(name, fragment, path);
  }
  return groups;
}

/**
 * Read the file. A missing file is no groups, not an error: the run before
 * anyone has created one is the common case, and it is the rule `loadConfig`
 * applies to its own absent file.
 */
export function loadGroups(path: string): Groups {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new GroupsError(
      "unreadable",
      `groups file at ${path} could not be read (${unreadableReason(error)}).`,
    );
  }
  return parseGroups(text, path);
}

/**
 * Drop every field the engine treats as unset, so a saved group holds only
 * what the user chose. `setFilters` is the manifest's own rule, reused rather
 * than re-implemented.
 */
export function thinGroup(fragment: GroupFilter): GroupFilter {
  const thin = setFilters(fragment);
  const kept: Record<string, unknown> = {};
  for (const key of GROUP_KEYS) {
    if (key in thin) kept[key] = thin[key];
  }
  return kept as GroupFilter;
}

/**
 * Write the file, mode 644, creating its directory if it is missing.
 *
 * The directory is 700 because it is the config directory, the one that also
 * holds `config.json` (plan/safety.md, "Local privileges and files"). Modes are
 * applied on creation and never repaired: an existing file keeps the mode the
 * user gave it, the rule `ensureSecureDir` and `ensureSession` both follow.
 */
export function saveGroups(path: string, groups: Groups): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ version: GROUPS_VERSION, groups }, null, 2);
  writeFileSync(path, `${body}\n`, { mode: 0o644 });
}

/**
 * How each field is spelled on the command line, including the negated forms.
 *
 * `provided` holds the flag the user actually typed (`src/cli/args.ts`), so
 * `--not-muted` must count as the command line speaking for `muted`. Without
 * this table a group's `muted: true` would beat a typed `--not-muted`, which is
 * the opposite of the precedence rule.
 */
export const FLAG_NAMES: Record<GroupKey, readonly string[]> = {
  types: ["type"],
  keyword: ["keyword"],
  any: ["any"],
  not: ["not"],
  regex: ["regex"],
  muted: ["muted", "not-muted"],
  archived: ["archived", "no-archived"],
  inactiveDays: ["inactive-days"],
  members: ["members"],
  scam: ["scam"],
  fake: ["fake"],
  banned: ["banned"],
  unavailable: ["unavailable"],
  unread: ["unread", "read"],
  pinned: ["pinned", "no-pinned"],
};

/** The four booleans whose `false` is the unset value (`emptyFilters`). */
const SWITCH_KEYS: readonly GroupKey[] = ["scam", "fake", "banned", "unavailable"];

/** A field a fragment does not actually choose. */
function isUnset(key: GroupKey, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return SWITCH_KEYS.includes(key) && value === false;
}

/** The same two values, for scalars that may be objects (`members`). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keep the first spelling of each entry, in order. */
function dedupe(items: readonly string[], foldCase: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = foldCase ? item.toLowerCase() : item;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** The flag names a field answers to. */
function flagNamesOf(key: GroupKey): readonly string[] {
  return FLAG_NAMES[key];
}

/** The message for two groups that chose different values for one field. */
function conflictMessage(
  first: string,
  second: string,
  key: GroupKey,
  aValue: unknown,
  bValue: unknown,
): string {
  const flag = flagNamesOf(key)[0];
  return (
    `groups "${first}" and "${second}" both set --${flag}, to ${JSON.stringify(aValue)} and ` +
    `${JSON.stringify(bValue)}; pick one group, or pass --${flag} yourself to decide`
  );
}

/** A view of `Filters` that a merge loop can write through. */
type FilterBag = Record<string, unknown>;

/**
 * The filters this run should use: what was typed, with every named group
 * folded in (`plan/groups.md`, "Merge rules").
 *
 * Two rules and nothing else. The OR lists (`keyword`, `any`, `not`, `types`)
 * union, groups first then the command line, because more entries in those
 * lists means a wider net and that is what `--keyword a,b` already does. Every
 * other field is chosen by precedence: a typed flag beats a group, a group
 * beats the unset default. Two groups disagreeing is an error rather than a
 * tie-break, because "last one wins" is a rule nobody can read off the command
 * line, and a wrong `inactiveDays` silently changes how much gets left.
 *
 * `typed` is the complete `Filters` the parser built and `provided` the flags
 * the user actually named, so the function can tell "typed 50" from "50 is the
 * default". With no names it returns `typed` unchanged, without a copy: the
 * common case costs nothing.
 */
export function mergeGroups(
  groups: Groups,
  names: readonly string[],
  typed: Filters,
  provided: ReadonlySet<string>,
): Filters {
  if (names.length === 0) return typed;

  const fromGroups: FilterBag = {};
  const owner: Partial<Record<GroupKey, string>> = {};

  for (const name of names) {
    const fragment = groups[name];
    if (fragment === undefined) {
      throw new GroupsError("unknown-group", unknownName(groups, name));
    }
    for (const key of GROUP_KEYS) {
      const value = (fragment as unknown as FilterBag)[key];
      if (isUnset(key, value)) continue;

      if (UNION_KEYS.includes(key)) {
        const prev = (fromGroups[key] as string[] | undefined) ?? [];
        fromGroups[key] = dedupe([...prev, ...(value as string[])], key !== "types");
      } else if (owner[key] === undefined) {
        owner[key] = name;
        fromGroups[key] = value;
      } else if (!sameValue(fromGroups[key], value)) {
        throw new GroupsError(
          "conflict",
          conflictMessage(owner[key] as string, name, key, fromGroups[key], value),
        );
      }
    }
  }

  const merged = { ...typed } as unknown as FilterBag;
  for (const key of GROUP_KEYS) {
    const value = fromGroups[key];
    if (value === undefined) continue;

    if (UNION_KEYS.includes(key)) {
      const typedWords = (typed as unknown as FilterBag)[key] as string[] | undefined;
      merged[key] = dedupe([...(value as string[]), ...(typedWords ?? [])], key !== "types");
    } else if (!flagNamesOf(key).some((flag) => provided.has(flag))) {
      merged[key] = value;
    }
  }
  return merged as unknown as Filters;
}

/** The message for a name that is not in the file, with the names that are. */
function unknownName(groups: Groups, name: string): string {
  const known = Object.keys(groups);
  const list =
    known.length === 0
      ? "you have none yet: create one with `chaff groups add NAME word,word`"
      : `groups you have: ${known.join(", ")}`;
  return `no group named ${JSON.stringify(name)}. ${list}`;
}

/** The fragment of one group, or an empty one when the name is new. */
function fragmentOf(groups: Groups, name: string): GroupFilter {
  return groups[name] ?? {};
}

/**
 * Union words into a group's `keyword`, creating the group when the name is
 * new. Idempotent, and case-insensitive in both directions: the engine
 * lowercases both sides (`hit()`, src/core/filters.ts), so `Amazon` and
 * `amazon` are one word here too.
 */
export function addWords(groups: Groups, name: string, words: readonly string[]): Groups {
  checkGroupName(name);
  const keyword = dedupe([...(fragmentOf(groups, name).keyword ?? []), ...words], true);
  return { ...groups, [name]: { ...fragmentOf(groups, name), keyword } };
}

/**
 * Drop words from a group. Words that are not there are ignored, so a remove is
 * idempotent the way an add is. A group left with no words keeps the empty list:
 * it matches nothing, which is what an empty list means, and deleting the name
 * is `dropGroup`'s job.
 */
export function removeWords(groups: Groups, name: string, words: readonly string[]): Groups {
  checkGroupName(name);
  const drop = new Set(words.map((word) => word.toLowerCase()));
  const keyword = (fragmentOf(groups, name).keyword ?? []).filter(
    (word) => !drop.has(word.toLowerCase()),
  );
  return { ...groups, [name]: { ...fragmentOf(groups, name), keyword } };
}

/**
 * Write the given fields as this group's values, replacing those fields and
 * leaving the rest alone. The fragment is thinned first, so a caller can hand
 * over a whole `Filters` and only what it actually chose is stored.
 */
export function setFields(groups: Groups, name: string, fragment: GroupFilter): Groups {
  checkGroupName(name);
  const thin = thinGroup(fragment);
  for (const key of Object.keys(fragment)) {
    if (!(GROUP_KEYS as readonly string[]).includes(key)) {
      throw new GroupsError("forbidden-key", forbiddenKeyMessage(key));
    }
  }
  if (Object.keys(thin).length === 0) {
    throw new GroupsError("forbidden-key", "groups set needs at least one filter flag");
  }
  return { ...groups, [name]: { ...fragmentOf(groups, name), ...thin } };
}

/** Remove named fields from a group. */
export function unsetFields(groups: Groups, name: string, keys: readonly string[]): Groups {
  checkGroupName(name);
  const next = { ...fragmentOf(groups, name) } as FilterBag;
  for (const key of keys) {
    if (!(GROUP_KEYS as readonly string[]).includes(key)) {
      throw new GroupsError("forbidden-key", `unknown field ${JSON.stringify(key)}`);
    }
    delete next[key];
  }
  return { ...groups, [name]: next as GroupFilter };
}

/** Delete a group. A name that is not there is an error: a typo in a delete should say so. */
export function dropGroup(groups: Groups, name: string): Groups {
  checkGroupName(name);
  if (!(name in groups)) throw new GroupsError("unknown-group", unknownName(groups, name));
  const next: Groups = {};
  for (const [key, fragment] of Object.entries(groups)) {
    if (key !== name) next[key] = fragment;
  }
  return next;
}

/** The message for a key handed to `set` that a group may not hold. */
function forbiddenKeyMessage(key: string): string {
  return (
    `"${key}" is not allowed in a group. A group holds ${GROUP_KEYS.join(", ")}. ` +
    `It cannot hold ${FORBIDDEN_KEYS.join(", ")}: those name particular chats or cap one run, ` +
    "and `exclude` beats the checklist."
  );
}
