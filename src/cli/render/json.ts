/**
 * The machine-readable renderer (`plan/cli.md`, "Output": "JSON to stdout, one
 * object per row or one array, stable key order").
 *
 * The array is built by walking the columns in order and assigning keys one at
 * a time, because that is what pins the key order: `JSON.stringify` follows
 * insertion order for string keys, so a row object assembled from the row's own
 * fields would be whatever order the row happened to have. Two renders of the
 * same table are byte-identical, which is what a `diff` or a snapshot test
 * needs.
 *
 * Values are the columns' raw values, not their text: numbers stay numbers and
 * a missing count stays `null`.
 */
import { type Column, type Table } from "./columns";

/** Pretty-printed JSON, two-space indent, trailing newline. */
const INDENT = 2;

/** The value `--json` emits for a cell: the column's raw value, or the text. */
function rawValue<Row>(column: Column<Row>, row: Row): unknown {
  if (column.json !== undefined) return column.json(row);
  const fields = row as Record<string, unknown>;
  return Object.hasOwn(fields, column.key) ? fields[column.key] : column.value(row);
}

/** Render `table` as a JSON array of objects, ending with a newline. */
export function renderJson<Row>(table: Table<Row>): string {
  const rows = table.rows.map((row) => {
    const object: Record<string, unknown> = {};
    for (const column of table.columns) {
      object[column.key] = rawValue(column, row);
    }
    return object;
  });

  return `${JSON.stringify(rows, null, INDENT)}\n`;
}
