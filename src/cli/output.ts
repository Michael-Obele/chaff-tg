/**
 * Where rendered output goes: stdout, plus the file `--out` names
 * (`plan/cli.md`, "Output").
 *
 * Every write in `src/cli` goes through the writers on `CliContext`, never the
 * real console, so a test can capture every byte a command produces and
 * `--out` is the only path that touches the filesystem. This module keeps the
 * three ways a command emits text in one place: the primary output (`--json` /
 * `--csv` / `--md` / table, and the `--out` copy), a note that `--quiet`
 * silences, and a per-chat line that `-v/--verbose` turns on.
 *
 * `--out` is written synchronously and rewritten on every call: a command has
 * one primary output, so "as well as stdout" means the file holds exactly the
 * bytes stdout received, not a growing log.
 */
import { writeFileSync } from "node:fs";
import type { Table } from "./render/columns";
import { renderCsv } from "./render/csv";
import { renderJson } from "./render/json";
import { renderMd } from "./render/md";
import { renderTable } from "./render/table";

/** The four output formats. `table` is the default. */
export type OutputFormat = "table" | "json" | "csv" | "md";

/** The output-related flags, as much of `GlobalFlags` as this module reads. */
export interface OutputFlags {
  json: boolean;
  csv: boolean;
  md: boolean;
  out: string | null;
}

/** Anything that can receive a written chunk, i.e. `CliContext["stdout"]`. */
export interface OutputWriter {
  write(s: string): unknown;
}

/** The format the flags asked for. Mutually exclusive formats are a parse error. */
export function outputFormat(flags: OutputFlags): OutputFormat {
  if (flags.json) return "json";
  if (flags.csv) return "csv";
  if (flags.md) return "md";
  return "table";
}

/** Render `table` in `format`. */
export function renderOutput<Row>(format: OutputFormat, table: Table<Row>): string {
  switch (format) {
    case "json":
      return renderJson(table);
    case "csv":
      return renderCsv(table);
    case "md":
      return renderMd(table);
    default:
      return renderTable(table);
  }
}

/** Write the primary output to stdout and, when `--out` is set, to that file too. */
export function emitOutput(stdout: OutputWriter, out: string | null, text: string): void {
  stdout.write(text);
  if (out !== null) writeFileSync(out, text);
}

/** A line a command prints but `--quiet` silences: a count, a path, a warning. */
export function noteOutput(stdout: OutputWriter, flags: { quiet: boolean }, text: string): void {
  if (!flags.quiet) stdout.write(text);
}

/** A per-chat line, printed only under `-v/--verbose`. */
export function verboseOutput(
  stdout: OutputWriter,
  flags: { verbose: boolean },
  text: string,
): void {
  if (flags.verbose) stdout.write(text);
}
