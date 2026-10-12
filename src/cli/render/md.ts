/**
 * The markdown renderer (`plan/cli.md`, "Output": "Markdown table, for pasting
 * into a note or an issue").
 *
 * A chat title is arbitrary text a stranger chose, and a `|` in it would split
 * the cell it sits in and shear the table; a newline would end the row
 * entirely. Both are neutralised here rather than left to the caller, because
 * this is the only format where the value can break the structure around it.
 */
import type { Table } from "./columns";

/** Make `text` safe inside a markdown table cell. */
function cell(text: string): string {
  return text.replaceAll(/\r?\n/g, " ").replaceAll("|", "\\|");
}

/** Render `table` as a markdown table, ending with a newline. */
export function renderMd<Row>(table: Table<Row>): string {
  const header = table.columns.map((column) => cell(column.header)).join(" | ");
  const divider = table.columns.map(() => "---").join(" | ");

  const lines = [`| ${header} |`, `| ${divider} |`];
  for (const row of table.rows) {
    lines.push(`| ${table.columns.map((column) => cell(column.value(row))).join(" | ")} |`);
  }

  return `${lines.join("\n")}\n`;
}
