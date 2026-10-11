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
 *
 * A machine format is a promise about stdout: `plan/cli.md` says `--json` makes
 * every command print machine readable output, so under `--json`, `--csv` or
 * `--md` stdout carries the payload and nothing else, and the human chatter — a
 * note, a per-chat line — moves to stderr. Without a machine format the chatter
 * stays on stdout beside the table, as it always has. The routing lives inside
 * the chatter functions rather than in the caller, because a caller that forgets
 * is a caller that corrupts the document.
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

/** Anything that can receive a written chunk, i.e. a `CliContext` writer. */
export interface OutputWriter {
  write(s: string): unknown;
}

/** The two writers a command may write to, as `CliContext` supplies them. */
export interface OutputStreams {
  stdout: OutputWriter;
  stderr: OutputWriter;
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

/**
 * The channel human chatter goes to: stderr under a machine format, stdout
 * otherwise. Under a machine format nothing but the payload reaches stdout, so
 * the document stays parseable no matter what the command says along the way.
 */
function chatterChannel(format: OutputFormat, streams: OutputStreams): OutputWriter {
  return format === "table" ? streams.stdout : streams.stderr;
}

/** A line a command prints but `--quiet` silences: a count, a path, a warning. */
export function noteOutput(
  format: OutputFormat,
  streams: OutputStreams,
  flags: { quiet: boolean },
  text: string,
): void {
  if (!flags.quiet) chatterChannel(format, streams).write(text);
}

/** A per-chat line, printed only under `-v/--verbose`. */
export function verboseOutput(
  format: OutputFormat,
  streams: OutputStreams,
  flags: { verbose: boolean },
  text: string,
): void {
  if (flags.verbose) chatterChannel(format, streams).write(text);
}
