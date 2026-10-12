/**
 * The spreadsheet renderer (`plan/cli.md`, "Output": "CSV with a header row,
 * for spreadsheets").
 *
 * Quoting follows RFC 4180: a field is quoted when it contains a comma, a
 * double quote, or a line break, and an inner quote is doubled. The header row
 * uses the human headers, because the two readers of `--csv` are a spreadsheet
 * and a person's eyes; a script that wants stable machine keys should ask for
 * `--json`.
 */
import type { Table } from "./columns";

/** Anything that forces a field to be quoted. */
const NEEDS_QUOTES = /[",\r\n]/;

/** Quote a field when RFC 4180 requires it. */
function field(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Render `table` as CSV with a header row, ending with a newline. */
export function renderCsv<Row>(table: Table<Row>): string {
  const lines = [table.columns.map((column) => field(column.header)).join(",")];
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => field(column.value(row))).join(","));
  }
  return `${lines.join("\n")}\n`;
}
