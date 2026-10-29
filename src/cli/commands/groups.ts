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
import { words } from "../args";
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
    lines.push([key, describeFilter({ [key]: value } as GroupFilter).replace(`${key}:`, "")]);
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

export const groupsCommand: Command = {
  name: "groups",
  summary: "List, edit and reuse your saved filter groups",

  async run(ctx) {
    const [verb, ...rest] = ctx.args.positional;
    const path = resolvePaths(ctx.env).groupsPath();
    const groups = loadGroups(path);

    switch (verb ?? "list") {
      case "list":
        return render(ctx, rowsOf(groups));
      case "show": {
        const name = rest[0];
        if (name === undefined) {
          ctx.out.error("groups show needs a group name\n");
          return EXIT.USAGE;
        }
        const fragment = groups[name];
        if (fragment === undefined) {
          ctx.out.error(`no group named ${JSON.stringify(name)}. ${knownList(groups)}\n`);
          return EXIT.USAGE;
        }
        return renderOne(ctx, name, fragment);
      }
      case "add": {
        const parsed = parseWrite(ctx, "add", rest, true);
        if (parsed === null) return EXIT.USAGE;
        const list = words(parsed.list);
        if (list.length === 0) {
          ctx.out.error(`groups add ${parsed.name} needs at least one word\n`);
          return EXIT.USAGE;
        }
        return guarded(
          ctx,
          path,
          () => addWords(groups, parsed.name, list),
          `added ${parsed.name}: ${describeFilter({ keyword: list })}\n`,
        );
      }
      case "remove": {
        const parsed = parseWrite(ctx, "remove", rest, true);
        if (parsed === null) return EXIT.USAGE;
        const list = words(parsed.list);
        if (list.length === 0) {
          ctx.out.error(`groups remove ${parsed.name} needs at least one word\n`);
          return EXIT.USAGE;
        }
        return guarded(
          ctx,
          path,
          () => removeWords(groups, parsed.name, list),
          `removed from ${parsed.name}: ${list.join(", ")}\n`,
        );
      }
      case "set": {
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
            "Use show, add, remove, set, unset, drop.\n",
        );
        return EXIT.USAGE;
    }
  },
};
