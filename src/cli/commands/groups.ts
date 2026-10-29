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
import { GROUP_KEYS, type GroupFilter, type Groups, loadGroups } from "../../core/groups";
import { resolvePaths } from "../../core/session";
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
function describeFilter(fragment: GroupFilter): string {
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

export const groupsCommand: Command = {
  name: "groups",
  summary: "List, edit and reuse your saved filter groups",

  async run(ctx) {
    const [verb, ...rest] = ctx.args.positional;
    const groups = loadGroups(resolvePaths(ctx.env).groupsPath());

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
      default:
        ctx.out.error(
          `unknown groups verb ${JSON.stringify(verb)}. ` +
            "Use show, add, remove, set, unset, drop.\n",
        );
        return EXIT.USAGE;
    }
  },
};
