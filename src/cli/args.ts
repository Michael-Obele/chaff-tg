/**
 * Argument parsing: argv in, a typed structure out (`plan/cli.md`).
 *
 * Everything here is a table. Each flag is one row describing its long name,
 * its documented short alias, which section it lands in, and how its value is
 * read; the conflict rules are one more table; and the parser itself is a loop
 * over those two. Adding a flag is adding a row, not adding a branch — which is
 * the difference between a CLI that stays honest as it grows and one where
 * every new flag is another chance to disagree with the help text.
 *
 * Two rules shape the parser:
 *
 * - **A value may start with a dash.** Chat ids are negative (`--select
 *   -1001234567890`), so a flag that expects a value takes the next token
 *   unless that token is itself a known flag spelling. That single rule covers
 *   both `--select -1001` (an id, not a flag) and `--out --json` (a missing
 *   value, not a filename).
 * - **Conflicts are usage errors, and usage errors exit 2.** `--muted
 *   --not-muted` cannot both hold, and neither can `--select` without `--yes`
 *   (`plan/cli.md`: "Requires `--yes`"). Failing at parse time means nothing
 *   downstream has to remember the rule.
 *
 * `--yes` and `--dry-run` are the two sides of the one decision this CLI exists
 * to get right, so they are a conflict rule rather than a fold: `--yes`
 * authorises the real thing, `--dry-run` rehearses it, and asking for both is a
 * line the tool cannot act on. Refusing it keeps `provided` honest — every name
 * in that set is a flag the user actually typed, so `provided.has("yes")` and
 * `selection.yes` can never disagree about whether a run may act.
 *
 * Values are validated here (a whole number, a range, a known chat type) so a
 * command receives data it can trust, and the message names the flag the user
 * actually typed.
 */
import { EXIT } from "../core/errors";
import { DEFAULT_CONFIG } from "../core/index";
import type { ChatType, Filters } from "../core/types";

/**
 * A usage error: an unknown flag, a missing value, or a conflicting pair.
 * Carries exit code 2 (`plan/cli.md`, "Exit codes") so a front end never has to
 * look the number up.
 */
export class UsageError extends Error {
  readonly exitCode: number = EXIT.USAGE;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The output and general switches that apply to every command. */
export interface GlobalFlags {
  json: boolean;
  csv: boolean;
  md: boolean;
  /** `--out <file>`: where to write a second copy of the primary output. */
  out: string | null;
  /** Errors only. */
  quiet: boolean;
  /** `-v/--verbose`: show each chat as it is processed. */
  verbose: boolean;
  /** `-h/--help`: show the usage text. */
  help: boolean;
  /** `-V/--version`: show the version and commit. */
  version: boolean;
  /**
   * `--dry-run` was given: a rehearsal. The conflict table refuses it beside
   * `--yes`, so whenever this is `true`, `selection.yes` is `false`.
   */
  dryRun: boolean;
}

/** The pacing, cap and selection flags (`plan/cli.md`, "Selection and pacing"). */
export interface Selection {
  /** `--select <ids>`: skip the checklist and act on exactly these. */
  select: number[] | null;
  /** `--from <file>`: replay a manifest written by `chaff report`. */
  from: string | null;
  /**
   * `--yes`: actually perform the leaves. `true` means "this run may act", and
   * it agrees with `provided.has("yes")` because `--dry-run` cannot be present
   * beside it.
   */
  yes: boolean;
  /** `--force`: continue past the first failure instead of stopping. */
  force: boolean;
  /** `--clear`: also clear history when leaving. */
  clear: boolean;
  /** `--max-leave`: hard cap per run; `0` means no cap. */
  maxLeave: number;
  /** `--delay`: base pause between leaves, in milliseconds. */
  delayMs: number;
}

/** One parsed command line. */
export interface ParsedArgs {
  /** The command word, or `null` when none was given. */
  command: string | null;
  flags: GlobalFlags;
  filters: Filters;
  /**
   * The group names `--group` was given, in the order typed, deduped. Deliberately
   * not in `Filters`: a group is folded in at the CLI edge (src/cli/groups.ts,
   * plan/groups.md) so the engine, the `Filters` type and the manifest schema
   * stay exactly as they are.
   */
  groupNames: string[];
  /**
   * Bare tokens after the command word. Only the commands named in
   * `POSITIONAL_COMMANDS` accept them, so every other command still refuses a
   * second bare token with the original message. How many a command accepts, and
   * what it does with them, is that command's own check.
   */
  positional: string[];
  selection: Selection;
  /**
   * The canonical long names of the flags that were actually given, so a
   * caller can tell "the user asked for 50" from "50 is the default" — which
   * is exactly what config-file precedence needs (`plan/cli.md`, "Config
   * file": values there are defaults that flags override).
   *
   * Only flags the user typed appear here, and it is handed back as a fresh
   * copy, so this set is always safe to read as "what the command line said".
   */
  provided: ReadonlySet<string>;
  /** `--run <id>` for `journal --run <id>`; only that command reads it. */
  runId?: number;
}

/** Which section of the usage text a flag is documented under. */
export type FlagGroup = "general" | "filters" | "selection" | "output";

/** One flag: its spellings, where it is documented, and how its value is read. */
export interface FlagSpec {
  /** Canonical long name, without the leading dashes. */
  name: string;
  /** The short alias `plan/cli.md` documents, without the leading dash. */
  short?: string;
  group: FlagGroup;
  /** How the value is written in the usage text; absent means a switch. */
  argument?: string;
  help: string;
  /**
   * Read the flag into the parse in progress. `value` is `""` for a switch and
   * the next token (or the `=` part) for a flag that takes one.
   */
  set(builder: Builder, value: string): void;
}

/** The mutable parse in progress; the parser builds one and then freezes it. */
export interface Builder {
  flags: GlobalFlags;
  filters: Filters;
  groupNames: string[];
  positional: string[];
  selection: Selection;
  provided: Set<string>;
  /** `--run <id>` for `journal --run <id>`; only that command reads it. */
  runId?: number;
}

/** Every filter at the value the engine treats as unset (src/core/filters.ts). */
export function emptyFilters(): Filters {
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
  };
}

/** The chat types `--type` accepts (the `ChatType` union, as a runtime set). */
const CHAT_TYPES: ReadonlySet<string> = new Set([
  "group",
  "supergroup",
  "channel",
  "gigagroup",
  "monoforum",
  "community",
]);

/**
 * Which commands accept bare tokens after their own name. `groups` does: it has
 * verbs, a name, and for some verbs a list.
 *
 * How many is the command's business, not the parser's. The parser cannot know
 * that `show` wants one token and `add` wants two, so a cap here would refuse a
 * stray word with a message that counts words instead of one that names the
 * verb and says what that verb wanted.
 *
 * Every other command takes none, which keeps `chaff list foo` a usage error
 * rather than a silently ignored word.
 */
const POSITIONAL_COMMANDS: ReadonlySet<string> = new Set(["groups"]);

/**
 * What `--type group` means: the whole group family, not the legacy spelling.
 *
 * Telegram represents a "group" three ways (`Chat.chatType`): a legacy basic
 * group (`group`), a supergroup (`supergroup`) and a broadcast group
 * (`gigagroup`). Official clients call all three "Groups" and silently migrate
 * the legacy kind into a supergroup the moment a feature needs one (mtcute
 * guide, "Peers"), so `group` alone matches almost nothing on a live account:
 * measured against Michael's, 0 of 60 dialogs are `group` while 13 are
 * `supergroup`. A user typing `--type group` means the family, so the family is
 * what it resolves to; the narrower spellings stay available for precision.
 */
const GROUP_FAMILY: readonly ChatType[] = ["group", "supergroup", "gigagroup"];

/** A whole, non-negative number: `--limit 25`, `--max-leave 0`. */
const WHOLE_NUMBER = /^\d+$/;

/** A chat id: a whole number, negative for chats. */
const CHAT_ID = /^-?\d+$/;

/** `--members 0-50`: an inclusive range, both ends whole numbers. */
const MEMBERS_RANGE = /^(\d+)-(\d+)$/;

/**
 * A comma separated list, trimmed, with the empty entries a trailing comma
 * leaves. The groups command splits its word and field lists with the same
 * rule, so the two cannot drift apart.
 */
export function words(value: string): string[] {
  return value
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
}

/** Read a whole number, at or above `min`, or refuse with the flag's own name. */
function wholeNumber(value: string, flag: string, min: number): number {
  const text = value.trim();
  if (!WHOLE_NUMBER.test(text)) {
    throw new UsageError(`${flag} needs a whole number, got ${JSON.stringify(value)}`);
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < min) {
    throw new UsageError(`${flag} needs a number of at least ${min}, got ${text}`);
  }
  return parsed;
}

/** Read a comma separated id list, each a whole number. */
function idList(value: string, flag: string): number[] {
  return words(value).map((word) => {
    if (!CHAT_ID.test(word)) {
      throw new UsageError(
        `${flag} needs a comma separated list of chat ids, got ${JSON.stringify(word)}`,
      );
    }
    const parsed = Number.parseInt(word, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new UsageError(`${flag} got an id that is out of range: ${word}`);
    }
    return parsed;
  });
}

/** Read `--members`' inclusive range. */
function memberRange(value: string, flag: string): { min: number; max: number } {
  const match = MEMBERS_RANGE.exec(value.trim());
  if (match === null) {
    throw new UsageError(`${flag} needs a range like 0-50, got ${JSON.stringify(value)}`);
  }
  const min = Number.parseInt(match[1] ?? "", 10);
  const max = Number.parseInt(match[2] ?? "", 10);
  if (min > max) {
    throw new UsageError(
      `${flag} needs a range whose minimum is not above its maximum, got ${value}`,
    );
  }
  return { min, max };
}

/** Read `--type`'s comma separated chat types, refusing anything Telegram has no name for. */
function chatTypes(value: string, flag: string): ChatType[] {
  const out: ChatType[] = [];
  for (const word of words(value)) {
    if (!CHAT_TYPES.has(word)) {
      throw new UsageError(
        `${flag} accepts ${[...CHAT_TYPES].join(", ")}, got ${JSON.stringify(word)}`,
      );
    }
    // `group` is the family (see GROUP_FAMILY); everything else is itself.
    for (const type of word === "group" ? GROUP_FAMILY : [word as ChatType]) {
      if (!out.includes(type)) out.push(type);
    }
  }
  return out;
}

/** A switch row: records the flag and nothing else. */
function switchFlag(
  spec: Omit<FlagSpec, "set" | "argument"> & { apply(builder: Builder): void },
): FlagSpec {
  const { apply, ...rest } = spec;
  return { ...rest, set: (builder) => apply(builder) };
}

/**
 * The filter flags, in the order `plan/cli.md`, "Filters" lists them.
 *
 * Short aliases are the ones that table documents (`-k`, `-K`, `-r`); a flag
 * with no documented short form has only its long form, so the parser never
 * accepts a spelling the spec does not name.
 */
const FILTER_FLAGS: readonly FlagSpec[] = [
  {
    name: "type",
    group: "filters",
    argument: "<list>",
    help: "Chat types: group (the whole group family), supergroup, channel, gigagroup, monoforum, community. Default: all",
    set: (b, value) => {
      b.filters.types = chatTypes(value, "--type");
    },
  },
  {
    name: "keyword",
    short: "k",
    group: "filters",
    argument: "<list>",
    help: "Match title or username, case insensitive. Comma separated",
    set: (b, value) => {
      b.filters.keyword = words(value);
    },
  },
  {
    name: "any",
    short: "K",
    group: "filters",
    argument: "<list>",
    help: "OR of many words; `--keyword a,b` is also OR",
    set: (b, value) => {
      b.filters.any = words(value);
    },
  },
  {
    name: "not",
    group: "filters",
    argument: "<list>",
    help: "Exclude chats whose title or username matches any of these",
    set: (b, value) => {
      b.filters.not = words(value);
    },
  },
  {
    name: "group",
    group: "filters",
    argument: "<list>",
    help: "Fold in saved filter groups, by name (see `chaff groups`)",
    set: (b, value) => {
      for (const name of words(value)) {
        if (!b.groupNames.includes(name)) b.groupNames.push(name);
      }
    },
  },
  {
    name: "regex",
    short: "r",
    group: "filters",
    argument: "<pattern>",
    help: "Match title with a regular expression, applied after the keyword filters",
    set: (b, value) => {
      b.filters.regex = value;
    },
  },
  {
    name: "id",
    group: "filters",
    argument: "<list>",
    help: "Specific chat ids; use the ids from `chaff list --json`",
    set: (b, value) => {
      b.filters.ids = idList(value, "--id");
    },
  },
  switchFlag({
    name: "muted",
    group: "filters",
    help: "Only muted chats",
    apply: (b) => {
      b.filters.muted = true;
    },
  }),
  switchFlag({
    name: "not-muted",
    group: "filters",
    help: "Only unmuted chats",
    apply: (b) => {
      b.filters.muted = false;
    },
  }),
  switchFlag({
    name: "archived",
    group: "filters",
    help: "Only archived chats",
    apply: (b) => {
      b.filters.archived = true;
    },
  }),
  switchFlag({
    name: "no-archived",
    group: "filters",
    help: "Exclude archived chats",
    apply: (b) => {
      b.filters.archived = false;
    },
  }),
  {
    name: "inactive-days",
    group: "filters",
    argument: "<n>",
    help: "Last message older than n days; an empty chat counts as inactive",
    set: (b, value) => {
      b.filters.inactiveDays = wholeNumber(value, "--inactive-days", 0);
    },
  },
  {
    name: "members",
    group: "filters",
    argument: "<range>",
    help: "Member count range, for example 0-50; a missing count is excluded, not zero",
    set: (b, value) => {
      b.filters.members = memberRange(value, "--members");
    },
  },
  switchFlag({
    name: "scam",
    group: "filters",
    help: "Chats Telegram itself flags as scam",
    apply: (b) => {
      b.filters.scam = true;
    },
  }),
  switchFlag({
    name: "fake",
    group: "filters",
    help: "Chats Telegram itself flags as fake",
    apply: (b) => {
      b.filters.fake = true;
    },
  }),
  switchFlag({
    name: "banned",
    group: "filters",
    help: "Chats Telegram returned as forbidden; a chat you are banned from",
    apply: (b) => {
      b.filters.banned = true;
    },
  }),
  switchFlag({
    name: "unavailable",
    group: "filters",
    help: "Chats Telegram no longer lists as available; wider than --banned",
    apply: (b) => {
      b.filters.unavailable = true;
    },
  }),
  switchFlag({
    name: "unread",
    group: "filters",
    help: "Chats with unread messages",
    apply: (b) => {
      b.filters.unread = true;
    },
  }),
  switchFlag({
    name: "read",
    group: "filters",
    help: "Chats with nothing unread",
    apply: (b) => {
      b.filters.unread = false;
    },
  }),
  switchFlag({
    name: "pinned",
    group: "filters",
    help: "Only pinned chats; pinned chats are skipped by default in the checklist",
    apply: (b) => {
      b.filters.pinned = true;
    },
  }),
  switchFlag({
    name: "no-pinned",
    group: "filters",
    help: "Skip pinned chats; the default for the checklist",
    apply: (b) => {
      b.filters.pinned = false;
    },
  }),
  {
    name: "include",
    group: "filters",
    argument: "<list>",
    help: "Force include these ids even if a filter would drop them",
    set: (b, value) => {
      b.filters.include = idList(value, "--include");
    },
  },
  {
    name: "exclude",
    group: "filters",
    argument: "<list>",
    help: "Never touch these ids; takes priority over everything, including the checklist",
    set: (b, value) => {
      b.filters.exclude = idList(value, "--exclude");
    },
  },
  {
    name: "limit",
    group: "filters",
    argument: "<n>",
    help: "Maximum rows to gather; a pagination guard for large accounts",
    set: (b, value) => {
      b.filters.limit = wholeNumber(value, "--limit", 1);
    },
  },
];

/** The selection, cap and pacing flags, in the order `plan/cli.md` lists them. */
const SELECTION_FLAGS: readonly FlagSpec[] = [
  {
    name: "max-leave",
    group: "selection",
    argument: "<n>",
    help: `Hard cap per run. 0 means no cap, and asks once for confirmation (default ${DEFAULT_CONFIG.maxLeave})`,
    set: (b, value) => {
      b.selection.maxLeave = wholeNumber(value, "--max-leave", 0);
    },
  },
  {
    name: "delay",
    group: "selection",
    argument: "<ms>",
    help: `Base delay between leaves, with jitter of plus or minus 400 ms (default ${DEFAULT_CONFIG.delayMs})`,
    set: (b, value) => {
      b.selection.delayMs = wholeNumber(value, "--delay", 0);
    },
  },
  switchFlag({
    name: "clear",
    group: "selection",
    help: "Also clear history when leaving",
    apply: (b) => {
      b.selection.clear = true;
    },
  }),
  {
    name: "select",
    group: "selection",
    argument: "<ids>",
    help: "Skip the checklist and act on exactly these ids. Requires --yes",
    set: (b, value) => {
      b.selection.select = idList(value, "--select");
    },
  },
  {
    name: "from",
    group: "selection",
    argument: "<file>",
    help: "Replay a manifest written by `chaff report`; `check` reads its ids",
    set: (b, value) => {
      b.selection.from = value;
    },
  },
  switchFlag({
    name: "yes",
    group: "selection",
    help: "Actually perform the leaves",
    apply: (b) => {
      b.selection.yes = true;
    },
  }),
  switchFlag({
    name: "force",
    group: "selection",
    help: "Continue past the first failure instead of stopping",
    apply: (b) => {
      b.selection.force = true;
    },
  }),
  {
    name: "run",
    group: "general",
    argument: "<id>",
    help: "Show per-chat states for a journal run",
    set: (b, value) => {
      const n = Number.parseInt(value.trim(), 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new UsageError(`--run needs a positive whole number, got ${JSON.stringify(value)}`);
      }
      b.runId = n;
      b.provided.add("run");
    },
  },
];

/** The output flags, in the order `plan/cli.md`, "Output" lists them. */
const OUTPUT_FLAGS: readonly FlagSpec[] = [
  switchFlag({
    name: "json",
    group: "output",
    help: "JSON to stdout, stable key order",
    apply: (b) => {
      b.flags.json = true;
    },
  }),
  switchFlag({
    name: "csv",
    group: "output",
    help: "CSV with a header row, for spreadsheets",
    apply: (b) => {
      b.flags.csv = true;
    },
  }),
  switchFlag({
    name: "md",
    group: "output",
    help: "Markdown table, for pasting into a note or an issue",
    apply: (b) => {
      b.flags.md = true;
    },
  }),
  {
    name: "out",
    group: "output",
    argument: "<file>",
    help: "Write the output to a file as well as stdout",
    set: (b, value) => {
      b.flags.out = value;
    },
  },
  switchFlag({
    name: "quiet",
    group: "output",
    help: "Errors only",
    apply: (b) => {
      b.flags.quiet = true;
    },
  }),
  switchFlag({
    name: "verbose",
    short: "v",
    group: "output",
    help: "Show each chat as it is processed",
    apply: (b) => {
      b.flags.verbose = true;
    },
  }),
];

/** The general flags: the ones that are not about a run at all. */
const GENERAL_FLAGS: readonly FlagSpec[] = [
  switchFlag({
    name: "help",
    short: "h",
    group: "general",
    help: "Show this help",
    apply: (b) => {
      b.flags.help = true;
    },
  }),
  switchFlag({
    name: "version",
    short: "V",
    group: "general",
    help: "Show the version and the commit this build came from",
    apply: (b) => {
      b.flags.version = true;
    },
  }),
  switchFlag({
    name: "dry-run",
    group: "general",
    help: "Rehearse without leaving anything; the default unless --yes",
    apply: (b) => {
      b.flags.dryRun = true;
    },
  }),
];

/** Every flag the parser knows, and the single source the usage text is built from. */
export const FLAG_SPECS: readonly FlagSpec[] = [
  ...GENERAL_FLAGS,
  ...FILTER_FLAGS,
  ...SELECTION_FLAGS,
  ...OUTPUT_FLAGS,
];

/** The section headings of the usage text, keyed by group. */
export const GROUP_TITLES: Record<FlagGroup, string> = {
  general: "Options",
  filters: "Filters",
  selection: "Selection and pacing",
  output: "Output",
};

/** How a flag is spelled in the usage text: both forms, and its value placeholder. */
export function spellingOf(spec: FlagSpec): string {
  const names = spec.short === undefined ? `--${spec.name}` : `-${spec.short}, --${spec.name}`;
  return spec.argument === undefined ? names : `${names} ${spec.argument}`;
}

/** A spelling (`--out`, `-v`) to the flag it names. */
const FLAG_BY_SPELLING: ReadonlyMap<string, FlagSpec> = buildSpellingIndex();

function buildSpellingIndex(): Map<string, FlagSpec> {
  const index = new Map<string, FlagSpec>();
  for (const spec of FLAG_SPECS) {
    for (const spelling of [
      `--${spec.name}`,
      ...(spec.short === undefined ? [] : [`-${spec.short}`]),
    ]) {
      if (index.has(spelling)) throw new Error(`duplicate flag spelling ${spelling}`);
      index.set(spelling, spec);
    }
  }
  return index;
}

/**
 * One rule about flags that cannot be combined, all in one table.
 *
 * `mutual`: neither may appear with the other (they contradict). `at-most-one`:
 * a group where only one member may appear. `requires`: this flag is
 * meaningless without another (`plan/cli.md`: `--select` "Requires `--yes`").
 */
export type ConflictRule =
  | { kind: "mutual"; flags: readonly [string, string]; message: string }
  | { kind: "at-most-one"; flags: readonly string[]; message: string }
  | { kind: "requires"; flag: string; requires: string; message: string };

/** The conflict table; every pair the spec calls impossible, in one place. */
export const CONFLICT_RULES: readonly ConflictRule[] = [
  {
    kind: "mutual",
    flags: ["muted", "not-muted"],
    message: "--muted and --not-muted contradict each other; pick one",
  },
  {
    kind: "mutual",
    flags: ["archived", "no-archived"],
    message: "--archived and --no-archived contradict each other; pick one",
  },
  {
    kind: "mutual",
    flags: ["unread", "read"],
    message: "--unread and --read contradict each other; pick one",
  },
  {
    kind: "mutual",
    flags: ["pinned", "no-pinned"],
    message: "--pinned and --no-pinned contradict each other; pick one",
  },
  {
    kind: "mutual",
    flags: ["quiet", "verbose"],
    message: "--quiet and --verbose contradict each other; pick one",
  },
  {
    kind: "mutual",
    flags: ["yes", "dry-run"],
    message: "--yes and --dry-run contradict each other: --dry-run rehearses, --yes authorises",
  },
  {
    kind: "at-most-one",
    flags: ["json", "csv", "md"],
    message: "--json, --csv and --md are separate output formats; pick one",
  },
  {
    kind: "requires",
    flag: "select",
    requires: "yes",
    message: "--select requires --yes: skipping the checklist is only for a run that may act",
  },
];

/** Refuse the parse when a conflict rule is broken. */
function checkConflicts(provided: ReadonlySet<string>): void {
  for (const rule of CONFLICT_RULES) {
    if (rule.kind === "mutual") {
      const [left, right] = rule.flags;
      if (provided.has(left) && provided.has(right)) throw new UsageError(rule.message);
    } else if (rule.kind === "at-most-one") {
      const given = rule.flags.filter((flag) => provided.has(flag));
      if (given.length > 1) throw new UsageError(rule.message);
    } else if (provided.has(rule.flag) && !provided.has(rule.requires)) {
      throw new UsageError(rule.message);
    }
  }
}

/**
 * Parse a command line (argv without the runtime and the script path).
 *
 * Throws a {@link UsageError} (exit 2) on anything the spec does not allow.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const builder: Builder = {
    flags: {
      json: false,
      csv: false,
      md: false,
      out: null,
      quiet: false,
      verbose: false,
      help: false,
      version: false,
      dryRun: false,
    },
    filters: emptyFilters(),
    groupNames: [],
    positional: [],
    selection: {
      select: null,
      from: null,
      yes: false,
      force: false,
      clear: false,
      maxLeave: DEFAULT_CONFIG.maxLeave,
      delayMs: DEFAULT_CONFIG.delayMs,
    },
    provided: new Set<string>(),
  };

  let command: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";

    if (!token.startsWith("-") || token === "-") {
      if (command === null) {
        command = token;
        continue;
      }
      if (POSITIONAL_COMMANDS.has(command)) {
        builder.positional.push(token);
        continue;
      }
      throw new UsageError(`unexpected argument ${JSON.stringify(token)}; chaff takes one command`);
    }

    const equals = token.indexOf("=");
    const spelling = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const spec = FLAG_BY_SPELLING.get(spelling);
    if (spec === undefined) throw new UsageError(`unknown flag ${spelling}`);

    builder.provided.add(spec.name);

    if (spec.argument === undefined) {
      if (inline !== undefined) throw new UsageError(`${spelling} is a switch; it takes no value`);
      spec.set(builder, "");
      continue;
    }

    if (inline !== undefined) {
      spec.set(builder, inline);
      continue;
    }

    const next = argv[index + 1];
    // A value that looks like a flag is still a value when it is not one this
    // CLI defines: `--select -1001234567890` is an id, `--out --json` is a
    // missing value.
    if (next === undefined || FLAG_BY_SPELLING.has(next)) {
      throw new UsageError(`${spelling} needs a value`);
    }
    spec.set(builder, next);
    index++;
  }

  checkConflicts(builder.provided);

  // `--yes` is the only thing that makes a run act, and the conflict table has
  // already refused it beside `--dry-run`, so no fold is needed here: the flag
  // the user typed is the flag `provided` holds and the value `selection` holds.
  builder.selection.yes = builder.provided.has("yes");

  return {
    command,
    flags: builder.flags,
    filters: builder.filters,
    groupNames: builder.groupNames,
    positional: builder.positional,
    selection: builder.selection,
    provided: new Set(builder.provided),
    runId: builder.runId,
  } as ParsedArgs;
}
