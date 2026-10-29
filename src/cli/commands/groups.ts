/**
 * `chaff groups`: the saved filter fragments (`plan/groups.md`, "The command").
 *
 * The only command that reads a local file and never touches Telegram, so it
 * needs no client, no session and no `CHAFF_FAKE`: `chaff groups add` works
 * before `chaff login` does, which is the order a new user is in.
 *
 * Reads go through the sink like every other command, so `--json`, `--csv` and
 * `--md` come free from the column list. `--json` prints the fragment itself,
 * not the rendering, because the rendering is for eyes and the fragment is what
 * `--group` will actually use.
 */
import { EXIT } from "../../core/errors";
import { filterRecords } from "../../core/filters";
import {
  addWords,
  dropGroup,
  GROUP_KEYS,
  type GroupFilter,
  type Groups,
  GroupsError,
  loadGroups,
  removeWords,
  saveGroups,
  setFields,
  unsetFields,
} from "../../core/groups";
import { resolvePaths } from "../../core/session";
import type { ChatRecord } from "../../core/types";
import { emptyFilters, words } from "../args";
import { openClient } from "../client";
import { fragmentFromArgs } from "../groups";
import type { Command, CommandContext } from "../index";
import type { Column, Table } from "../render/columns";
import { factsTable } from "../render/facts";

/** One printed row: the name and the fragment it holds. */
interface GroupRow {
  name: string;
  filter: GroupFilter;
}

/**
 * The fragment as one readable cell: `keyword:amazon|voucher scam
 * inactiveDays:365`. A switch that is true prints bare, because `scam:true` is
 * a thing nobody needs to read twice. `members` is the one object field and gets
 * its range spelling.
 */
export function describeFilter(fragment: GroupFilter): string {
  const parts: string[] = [];
  for (const key of GROUP_KEYS) {
    const value = fragment[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      parts.push(`${key}:${value.join("|")}`);
    } else if (typeof value === "object") {
      const range = value as { min: number; max: number };
      parts.push(`${key}:${range.min}-${range.max}`);
    } else if (value === true) {
      parts.push(key);
    } else {
      parts.push(`${key}:${String(value)}`);
    }
  }
  return parts.join(" ") || "-";
}

const GROUP_COLUMNS: ReadonlyArray<Column<GroupRow>> = [
  { key: "name", header: "name", value: (row) => row.name },
  {
    key: "filter",
    header: "sets",
    value: (row) => describeFilter(row.filter),
    json: (row) => row.filter,
  },
];

function groupTable(rows: readonly GroupRow[]): Table<GroupRow> {
  return { columns: GROUP_COLUMNS, rows };
}

function rowsOf(groups: Groups): GroupRow[] {
  return Object.entries(groups).map(([name, filter]) => ({ name, filter }));
}

/** The names in the file, or the hint that there are none. */
function knownList(groups: Groups): string {
  const names = Object.keys(groups);
  return names.length === 0
    ? "you have none yet: create one with `chaff groups add NAME word,word`"
    : `groups you have: ${names.join(", ")}`;
}

/** One primary output: the table, or the JSON document beside it. */
function render(ctx: CommandContext, rows: GroupRow[]): number {
  if (rows.length === 0) {
    ctx.out.note("no groups yet: create one with `chaff groups add NAME word,word`\n");
  }
  ctx.out.document({ json: { groups: rows }, table: groupTable(rows) });
  return EXIT.OK;
}

/**
 * One field per line, which is the shape a person reads when they are deciding
 * whether to delete a group. `factsTable` is the same two-column renderer
 * `whoami` and `doctor` use.
 */
function renderOne(ctx: CommandContext, name: string, fragment: GroupFilter): number {
  const lines: [string, string][] = [];
  for (const key of GROUP_KEYS) {
    const value = fragment[key];
    if (value === undefined) continue;
    // A switch has no value to show, and `scam  scam` reads like a bug. The
    // table form prints it bare; here the column pair needs the word.
    const shown =
      value === true
        ? "true"
        : describeFilter({ [key]: value } as GroupFilter).replace(`${key}:`, "");
    lines.push([key, shown]);
  }
  if (lines.length === 0) lines.push(["(no fields set)", "-"]);
  ctx.out.document({
    json: { name, filter: fragment },
    table: factsTable(lines),
  });
  return EXIT.OK;
}

/**
 * Run a mutation and write the result, or refuse without writing.
 *
 * The order is the point: `loadGroups` has already run in `run` (a broken file
 * is refused before anything is written), the mutation is pure and may throw
 * (`checkGroupName` on a bad name, `dropGroup` on a missing one), and
 * `saveGroups` happens only once it has returned. Every `GroupsError` becomes
 * exit 2 here, in one place, and the file is left exactly as it was.
 */
function guarded(ctx: CommandContext, path: string, change: () => Groups, message: string): number {
  let next: Groups;
  try {
    next = change();
  } catch (error) {
    if (error instanceof GroupsError) {
      ctx.out.error(`${error.message}\n`);
      return EXIT.USAGE;
    }
    throw error;
  }
  saveGroups(path, next);
  ctx.out.note(message);
  return EXIT.OK;
}

/** The name and optional list a write verb was given, or a refusal. */
function parseWrite(
  ctx: CommandContext,
  verb: string,
  rest: string[],
  needsList: boolean,
): { name: string; list: string } | null {
  const [name, list] = rest;
  if (rest.length > (needsList ? 2 : 1)) {
    ctx.out.error(
      needsList
        ? `groups ${verb} takes exactly two arguments (the group name and the list), got ${JSON.stringify(rest[2])}\n`
        : `groups ${verb} takes exactly one argument (the group name), got ${JSON.stringify(rest[1])}\n`,
    );
    return null;
  }
  if (name === undefined) {
    ctx.out.error(
      needsList
        ? `groups ${verb} needs a group name and a comma separated list\n`
        : `groups ${verb} needs a group name\n`,
    );
    return null;
  }
  if (needsList && list === undefined) {
    ctx.out.error(`groups ${verb} ${name} needs a comma separated list\n`);
    return null;
  }
  return { name, list: list ?? "" };
}

/**
 * The shape `add` and `remove` share: a name, a word list, one mutation, one
 * confirming line.
 *
 * They differ only in which mutation runs and what the line says. Leaving that
 * as two copies is how one gets a fix and the other does not, which is exactly
 * what happened while the arity checks were being added.
 */
function wordVerb(
  ctx: CommandContext,
  path: string,
  verb: "add" | "remove",
  groups: Groups,
  rest: string[],
  change: (groups: Groups, name: string, list: string[]) => Groups,
  message: (name: string, list: string[]) => string,
): number {
  const parsed = parseWrite(ctx, verb, rest, true);
  if (parsed === null) return EXIT.USAGE;
  const list = words(parsed.list);
  if (list.length === 0) {
    ctx.out.error(`groups ${verb} ${parsed.name} needs at least one word\n`);
    return EXIT.USAGE;
  }
  return guarded(ctx, path, () => change(groups, parsed.name, list), message(parsed.name, list));
}

/**
 * `groups check NAME`: how many chats each part of a group actually selects.
 *
 * The only verb here that talks to Telegram, because a count needs the dialogs.
 * That makes it the only one that can answer "not logged in" (exit 3), and the
 * only one `CHAFF_FAKE` matters for.
 *
 * Every number comes from `filterRecords`, the same engine `--group` uses, so a
 * preview cannot disagree with the run it is previewing. Counting is one pass
 * over one listing: asking Telegram once per word would be cheaper to write and
 * would earn a flood wait, which is how this command came to be wanted.
 */
async function checkGroup(
  ctx: CommandContext,
  name: string,
  fragment: GroupFilter,
): Promise<number> {
  const { api } = await openClient(ctx);
  try {
    const records: ChatRecord[] = [];
    for await (const chat of api.dialogs({})) records.push(chat);

    /** How many chats this patch alone selects, through the real engine. */
    const countWith = (patch: GroupFilter): number =>
      filterRecords(records, { ...emptyFilters(), ...patch }, ctx.now()).filter((row) => row.ok)
        .length;

    const rows: [string, string][] = [];
    const parts: { key: string; count: number }[] = [];
    const dead: string[] = [];

    const total = countWith(fragment);
    rows.push(["group", plural(total)]);
    parts.push({ key: "group", count: total });

    for (const key of GROUP_KEYS) {
      const value = fragment[key];
      if (value === undefined) continue;

      // Word lists are reported word by word: one word that matches nothing is
      // invisible in the total, and invisible is exactly what a typo looks like.
      if ((key === "keyword" || key === "any" || key === "not") && Array.isArray(value)) {
        for (const word of value) {
          // `not` inverts, so its honest number is how many chats it would
          // exclude, which is the same test as "contains this word".
          const hit =
            key === "not"
              ? countWith({ keyword: [word] })
              : countWith({ [key]: [word] } as GroupFilter);
          const label = `${key}:${word}`;
          rows.push([label, key === "not" ? `${plural(hit)} excluded` : plural(hit)]);
          parts.push({ key: label, count: hit });
          if (hit === 0) dead.push(label);
        }
        continue;
      }

      const hit = countWith({ [key]: value } as GroupFilter);
      rows.push([key, plural(hit)]);
      parts.push({ key, count: hit });
      if (hit === 0) dead.push(key);
    }

    if (dead.length > 0) {
      ctx.out.note(`matches nothing on its own: ${dead.join(", ")}\n`);
    }
    ctx.out.document({ json: { name, total, parts }, table: factsTable(rows) });
    return EXIT.OK;
  } finally {
    await api.destroy();
  }
}

/** `1 chat`, `2 chats`. */
function plural(count: number): string {
  return `${count} chat${count === 1 ? "" : "s"}`;
}

export const groupsCommand: Command = {
  name: "groups",
  summary: "List, edit and reuse your saved filter groups",

  async run(ctx) {
    const [verb, ...rest] = ctx.args.positional;
    const path = resolvePaths(ctx.env).groupsPath();
    const groups = loadGroups(path);

    switch (verb ?? "list") {
      case "list": {
        if (rest.length > 0) {
          ctx.out.error(`groups list takes no arguments, got ${JSON.stringify(rest[0])}\n`);
          return EXIT.USAGE;
        }
        return render(ctx, rowsOf(groups));
      }
      case "check": {
        const parsed = parseWrite(ctx, "check", rest, false);
        if (parsed === null) return EXIT.USAGE;
        const fragment = groups[parsed.name];
        if (fragment === undefined) {
          ctx.out.error(`no group named ${JSON.stringify(parsed.name)}. ${knownList(groups)}\n`);
          return EXIT.USAGE;
        }
        return checkGroup(ctx, parsed.name, fragment);
      }
      case "show": {
        const name = rest[0];
        if (name === undefined) {
          ctx.out.error("groups show needs a group name\n");
          return EXIT.USAGE;
        }
        if (rest.length > 1) {
          ctx.out.error(
            `groups show takes exactly one argument (the group name), got ${JSON.stringify(rest[1])}\n`,
          );
          return EXIT.USAGE;
        }
        const fragment = groups[name];
        if (fragment === undefined) {
          ctx.out.error(`no group named ${JSON.stringify(name)}. ${knownList(groups)}\n`);
          return EXIT.USAGE;
        }
        return renderOne(ctx, name, fragment);
      }
      case "add":
        return wordVerb(
          ctx,
          path,
          "add",
          groups,
          rest,
          addWords,
          (name, list) => `added ${name}: ${describeFilter({ keyword: list })}\n`,
        );
      case "remove":
        return wordVerb(
          ctx,
          path,
          "remove",
          groups,
          rest,
          removeWords,
          (name, list) => `removed from ${name}: ${list.join(", ")}\n`,
        );
      case "set": {
        if (rest.length > 1) {
          ctx.out.error(
            `groups set takes exactly one argument (the group name), got ${JSON.stringify(rest[1])}\n`,
          );
          return EXIT.USAGE;
        }
        const built = fragmentFromArgs(ctx);
        if (typeof built === "string") {
          ctx.out.error(`${built}\n`);
          return EXIT.USAGE;
        }
        const name = rest[0];
        if (name === undefined || name === "") {
          ctx.out.error("groups set needs a group name\n");
          return EXIT.USAGE;
        }
        return guarded(
          ctx,
          path,
          () => setFields(groups, name, built.fragment),
          `set ${name}: ${describeFilter(built.fragment)}\n`,
        );
      }
      case "unset": {
        const parsed = parseWrite(ctx, "unset", rest, true);
        if (parsed === null) return EXIT.USAGE;
        const keys = words(parsed.list);
        if (keys.length === 0) {
          ctx.out.error(`groups unset ${parsed.name} needs at least one word\n`);
          return EXIT.USAGE;
        }
        return guarded(
          ctx,
          path,
          () => unsetFields(groups, parsed.name, keys),
          `unset from ${parsed.name}: ${keys.join(", ")}\n`,
        );
      }
      case "drop": {
        const parsed = parseWrite(ctx, "drop", rest, false);
        if (parsed === null) return EXIT.USAGE;
        return guarded(ctx, path, () => dropGroup(groups, parsed.name), `dropped ${parsed.name}\n`);
      }
      default:
        ctx.out.error(
          `unknown groups verb ${JSON.stringify(verb)}. ` +
            "Use show, add, remove, set, unset, drop, check.\n",
        );
        return EXIT.USAGE;
    }
  },
};
