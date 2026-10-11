/**
 * The one row model every renderer reads (`plan/cli.md`, "Output").
 *
 * A command declares its columns once and gets all four formats for free, so
 * `--json`, `--csv`, `--md` and the default table can never disagree about
 * which fields exist or in what order they come. That order is the column
 * order, which is what makes the JSON key order stable.
 *
 * A column is a value formatter (`value`) plus, optionally, the raw value the
 * JSON format should emit (`json`). The raw value matters: a table prints a
 * missing member count as `-`, but `--json` has to emit `null`, because a
 * consumer must be able to tell "no count" from "count 0".
 */

/** One field of a rendered row. */
export interface Column<Row> {
  /** Stable machine key: the JSON object key, and the identity of the column. */
  key: string;
  /** Human header, used by the table and markdown formats. */
  header: string;
  /** How the value is written in the text formats (table, csv, markdown). */
  value(row: Row): string;
  /**
   * The raw value `--json` emits. Left out, the row's own field of the same
   * name is used when it has one, so a command that keeps the real numbers in
   * its rows gets typed JSON without writing this by hand.
   */
  json?(row: Row): unknown;
  /** Right-align a numeric column in the table format. */
  align?: "left" | "right";
}

/** A table: the columns, in the order a reader sees them, and the rows. */
export interface Table<Row> {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
}
