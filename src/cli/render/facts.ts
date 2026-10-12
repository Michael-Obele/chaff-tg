/**
 * The two-column `item | value` view `chaff whoami` and `chaff doctor` print
 * (`plan/cli.md`, "Commands").
 *
 * Both commands say a handful of named facts — an account id, a path, a mode —
 * rather than a list of records, so they share one table shape instead of each
 * inventing a column layout. The machine-readable half of both commands is an
 * object (`document`, `src/cli/output.ts`), which is why a fact's value here is
 * text: the JSON a script reads never goes through this table.
 */
import type { Table } from "./columns";

/** One named fact. */
export interface FactRow {
  /** What the fact is about: `data directory`, `api hash`. */
  item: string;
  /** The fact itself, already formatted for a person. */
  value: string;
}

/** Build the `item | value` table from pairs, keeping the order given. */
export function factsTable(rows: ReadonlyArray<readonly [string, string]>): Table<FactRow> {
  return {
    columns: [
      { key: "item", header: "item", value: (row) => row.item },
      { key: "value", header: "value", value: (row) => row.value },
    ],
    rows: rows.map(([item, value]) => ({ item, value })),
  };
}
