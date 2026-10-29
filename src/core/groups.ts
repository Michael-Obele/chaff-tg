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
