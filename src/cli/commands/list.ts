/**
 * `chaff list`: the dialogs, filtered, as a table (`plan/cli.md`, "Commands").
 *
 * The read-only half of the tool, and the one a user runs first, so the shape
 * here is the shape everywhere: the same filter flags as `report` and `leave`
 * (`filterRecords`, the core engine — this command does not filter anything
 * itself), the same columns in every format, and a JSON document a script can
 * read back.
 *
 * Two details are load-bearing:
 *
 * - **`--limit` caps the gathering, not the printing.** It is handed to the
 *   client's iterator, so a large account is not fetched whole and then thrown
 *   away (`plan/cli.md`: "a pagination guard for large accounts"). The filter
 *   engine's own `limit` then has nothing left to cut, because the gather is
 *   already the tighter of the two.
 * - **The JSON document is `{ "chats": [ … ] }`.** `plan/cli.md`'s scripting
 *   example reads `.chats[]`, so the document is an object; its rows come from
 *   the column list (`rowObject`), so the keys and their order are the same
 *   seven the table shows, and the two can never drift apart.
 */
import { EXIT } from "../../core/errors";
import { filterRecords } from "../../core/filters";
import type { ChatRecord } from "../../core/types";
import type { Command } from "../index";
import { openClient } from "../client";
import { applyGroups } from "../groups";
import type { Column, Table } from "../render/columns";
import { rowObject } from "../render/json";

/**
 * The flags a chat carries, as the stable tokens the manifest's `why` uses:
 * `muted`, `archived`, `pinned`, `unread:<n>`, `unread-marked`, `scam`, `fake`,
 * `verified`, `banned`, `unavailable`.
 *
 * `muted: null` is Telegram's "the account default", which is not a flag this
 * account chose, so it is left out rather than guessed at either way.
 *
 * `unread-marked` is separate from `unread:<n>` because Telegram treats them
 * separately: the count badges a dialog above one unread message, and the mark
 * badges it with none at all (`Dialog.isUnread`).
 */
function flagsOf(chat: ChatRecord): string[] {
  const flags: string[] = [];
  if (chat.muted === true) flags.push("muted");
  if (chat.archived) flags.push("archived");
  if (chat.pinned) flags.push("pinned");
  if (chat.unread > 0) flags.push(`unread:${chat.unread}`);
  if (chat.manuallyUnread) flags.push("unread-marked");
  if (chat.isScam) flags.push("scam");
  if (chat.isFake) flags.push("fake");
  if (chat.isVerified) flags.push("verified");
  if (chat.banned) flags.push("banned");
  if (chat.unavailable) flags.push("unavailable");
  return flags;
}

/** The date part of an ISO timestamp: what fits in a table cell. */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The columns the brief and `plan/cli.md` name, in order: id, type, title,
 * username, members, last, flags.
 *
 * `last` and `flags` are the two columns whose JSON value is not their text —
 * a scan of a `ChatRecord` has no `last` or `flags` field — so they carry a
 * `json` reader; the other five fall back to the record's own field of the same
 * name. A missing member count prints as `-` but stays `null` in JSON, because
 * "no count" and "count 0" are different answers (`columns.ts`).
 */
export const CHAT_COLUMNS: ReadonlyArray<Column<ChatRecord>> = [
  { key: "id", header: "id", align: "right", value: (chat) => String(chat.id) },
  { key: "type", header: "type", value: (chat) => chat.type },
  { key: "title", header: "title", value: (chat) => chat.title },
  { key: "username", header: "username", value: (chat) => chat.username ?? "-" },
  {
    key: "members",
    header: "members",
    align: "right",
    value: (chat) => (chat.members === null ? "-" : String(chat.members)),
  },
  {
    key: "last",
    header: "last",
    value: (chat) => (chat.lastMessageAt === null ? "-" : dateOnly(chat.lastMessageAt)),
    json: (chat) => chat.lastMessageAt,
  },
  {
    key: "flags",
    header: "flags",
    value: (chat) => flagsOf(chat).join(" ") || "-",
    json: (chat) => flagsOf(chat),
  },
];

/** The table `list` prints in the three human formats. */
export function chatTable(chats: readonly ChatRecord[]): Table<ChatRecord> {
  return { columns: CHAT_COLUMNS, rows: chats };
}

export const listCommand: Command = {
  name: "list",
  summary: "List dialogs as a table, with filters applied",

  async run(ctx) {
    // Refuse a bad group name or a broken groups file before a client opens: a
    // run that cannot work should not connect to Telegram first and fail
    // afterwards. `leave` already resolves its filters this way.
    const filters = applyGroups(ctx);
    const { api } = await openClient(ctx);
    try {
      const limit = filters.limit === null ? {} : { limit: filters.limit };

      // The cap applies here, at the source: the client stops asking Telegram
      // once it has `--limit` dialogs, so a large account is never fetched whole
      // and then discarded.
      const records: ChatRecord[] = [];
      for await (const chat of api.dialogs(limit)) records.push(chat);

      const rows = filterRecords(records, filters, ctx.now());

      // One line per chat, kept or dropped, as it is processed.
      for (const row of rows) {
        ctx.out.verbose(`${row.ok ? "keep" : "drop"} ${row.chat.id} ${row.chat.title}\n`);
      }

      const chats = rows.filter((row) => row.ok).map((row) => row.chat);
      ctx.out.note(`Found ${chats.length} chats\n`);

      const table = chatTable(chats);
      ctx.out.document({
        json: { chats: table.rows.map((row) => rowObject(table, row)) },
        table,
      });
      return EXIT.OK;
    } finally {
      // The session is the account: a read-only command still hands the file
      // back rather than leaving it open (`plan/safety.md`, "The session file").
      await api.destroy();
    }
  },
};
