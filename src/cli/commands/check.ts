/**
 * `chaff check`: ask Telegram about chat ids the account already has
 * (`plan/cli.md`, "Commands"; `plan/notes.md`, "Banned channels").
 *
 * The command exists because a chat you are banned from cannot be *listed*.
 * Telegram removes the dialog, so `chaff list --banned` would be a flag that
 * matches nothing, and a banned chat has no member count either, so the
 * `--members 0-0` idea cannot work. What does work is asking about an id you
 * already hold: a manifest from an earlier run, the journal, or an id pasted
 * from anywhere. That is all this command does.
 *
 * It is read-only on purpose, and therefore has no `--yes`: nothing is left,
 * nothing is written, and the answer is a table (or the same rows as JSON).
 * The three answers a user can act on are `ok`, `banned` and `gone`:
 * `unavailable` is the wider Telegram judgement and includes chats that are
 * merely private or left, so it is reported but never dressed up as banned.
 *
 * A `ManifestError` from `--from` exits 2 with its own message rather than 1,
 * exactly as `report` treats one: the file is the user's to fix, and the
 * message is the whole diagnosis.
 */
import { EXIT } from "../../core/errors";
import { ManifestError, parseManifest } from "../../core/manifest";
import type { ChatCheck, ChatStatus } from "../../core/telegram";
import type { Command } from "../index";
import { openClient } from "../client";
import type { Column, Table } from "../render/columns";
import { rowObject } from "../render/json";

/** A thrown value as a sentence; the same shape `runCli` prints. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The five columns: the id asked about, the verdict, the title Telegram still
 * reports for it, and the two restriction fields.
 *
 * `title` carries a `json` reader because a gone chat prints as `-` in a table
 * but must stay `null` in JSON: "there is no title" and "the title is a dash"
 * are different answers, the same rule the `members` column follows.
 *
 * `restricted` and `restriction` are both printed because they answer different
 * questions and can disagree: the flag is Telegram's, the reason list is only
 * populated when the account is allowed to see it. A row can honestly read
 * `true` with `-`, which is why the flag is not inferred from the reasons.
 */
const CHECK_COLUMNS: ReadonlyArray<Column<ChatCheck>> = [
  { key: "id", header: "id", align: "right", value: (row) => String(row.id) },
  { key: "status", header: "status", value: (row) => row.status },
  { key: "title", header: "title", value: (row) => row.title ?? "-", json: (row) => row.title },
  {
    key: "restricted",
    header: "restricted",
    value: (row) => String(row.restricted),
    json: (row) => row.restricted,
  },
  {
    key: "restriction",
    header: "restriction",
    value: (row) => row.restriction ?? "-",
    json: (row) => row.restriction,
  },
];

/** The four statuses, in the order they are counted in the summary line. */
const STATUSES: readonly ChatStatus[] = ["ok", "banned", "unavailable", "gone"];

/** One summary line: how many of each verdict, and what the answer means. */
function summaryOf(rows: readonly ChatCheck[]): string {
  const counts = STATUSES.map(
    (status) => `${rows.filter((row) => row.status === status).length} ${status}`,
  );
  const restricted = rows.filter((row) => row.restricted).length;
  return (
    `Checked ${rows.length} chat${rows.length === 1 ? "" : "s"}: ${counts.join(", ")}` +
    (restricted > 0 ? `, ${restricted} restricted` : "") +
    "\n"
  );
}

export const checkCommand: Command = {
  name: "check",
  summary: "Ask Telegram about ids you already have: ok, banned or gone",

  async run(ctx) {
    // Ids can come from the command line (`--id`, already parsed and validated
    // by the flag table) or from a manifest, which is the path a user actually
    // has: the ids worth asking about are the ones an earlier run recorded.
    const ids = new Set<number>(ctx.args.filters.ids ?? []);
    const from = ctx.args.selection.from;

    if (from !== null) {
      let text: string;
      try {
        text = await Bun.file(from).text();
      } catch (error) {
        throw new Error(`cannot read manifest ${from}: ${messageOf(error)}`);
      }
      try {
        for (const chat of parseManifest(text).chats) ids.add(chat.id);
      } catch (error) {
        if (error instanceof ManifestError) {
          ctx.out.error(`${error.message}\n`);
          return EXIT.USAGE;
        }
        throw error;
      }
    }

    if (ids.size === 0) {
      ctx.out.error("chaff check needs ids: pass --id <list> or --from <manifest>\n");
      return EXIT.USAGE;
    }

    const { api } = await openClient(ctx);
    try {
      const rows = await api.checkChats([...ids]);
      for (const row of rows) {
        ctx.out.verbose(`${row.status} ${row.id} ${row.title ?? ""}\n`);
      }
      ctx.out.note(summaryOf(rows));

      const table: Table<ChatCheck> = { columns: CHECK_COLUMNS, rows };
      ctx.out.document({
        json: { chats: table.rows.map((row) => rowObject(table, row)) },
        table,
      });
      return EXIT.OK;
    } finally {
      // A read-only command still hands the session file back rather than
      // leaving it open (plan/safety.md, "The session file").
      await api.destroy();
    }
  },
};
