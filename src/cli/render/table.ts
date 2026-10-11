/**
 * The default renderer: a plain, aligned text table (`plan/cli.md`, "Output").
 *
 * Column widths are computed once from the header and every cell, so the
 * output is stable for a given table rather than shifting as rows stream in.
 * The last cell of a line is right-trimmed, which keeps the output free of
 * trailing whitespace without moving the columns.
 */
import type { Table } from "./columns";

/** Two spaces `plan/cli.md`'s tables use between columns. */
const GAP = "  ";

/** Render `table` as an aligned text table, ending with a newline. */
export function renderTable<Row>(table: Table<Row>): string {
  const lines = [table.columns.map((column) => column.header)];
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => column.value(row)));
  }

  const widths = table.columns.map((_, index) =>
    Math.max(...lines.map((line) => (line[index] ?? "").length)),
  );

  const rendered = lines.map((line) =>
    line
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        return table.columns[index]?.align === "right" ? cell.padStart(width) : cell.padEnd(width);
      })
      .join(GAP)
      .trimEnd(),
  );

  return `${rendered.join("\n")}\n`;
}
