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
 *
 * `plan/cli.md` allows two spellings — "one object per row or one array" — so
 * the module has two halves that share one formatting rule: {@link renderJson}
 * for a table (the rows, as an array) and {@link renderJsonValue} for a
 * document that is an object, such as `chaff list`'s `{ "chats": [ … ] }`. A
 * command that wants the second builds its rows with {@link rowObject}, so the
 * keys and their order still come from the column list rather than a second,
 * hand-written shape that could drift from it.
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

/**
 * One row as the object `--json` emits: the columns, in order, with their raw
 * values.
 *
 * A command whose JSON document is not the bare array of rows — `list` prints
 * `{ "chats": [ … ] }` — builds its document from this, so the keys and their
 * order stay the column list's business in every format (`columns.ts`).
 */
export function rowObject<Row>(table: Table<Row>, row: Row): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const column of table.columns) {
    object[column.key] = rawValue(column, row);
  }
  return object;
}

/**
 * Pretty-print any JSON document: two-space indent, trailing newline.
 *
 * The rows-of-a-table case is {@link renderJson}; this is for a document that
 * is an object rather than an array, so both spellings of "JSON to stdout"
 * share one set of formatting rules.
 */
export function renderJsonValue(value: unknown): string {
  return `${JSON.stringify(value, null, INDENT)}\n`;
}

/** Render `table` as a JSON array of objects, ending with a newline. */
export function renderJson<Row>(table: Table<Row>): string {
  return renderJsonValue(table.rows.map((row) => rowObject(table, row)));
}
