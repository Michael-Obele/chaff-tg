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
 * stays on stdout beside the table, as it always has.
 *
 * `bindOutput` is what makes that promise structural instead of a habit. It is
 * called once per `runCli` invocation, from inside `runCli`, and the object it
 * returns is the only writer a command is handed: the format is already
 * resolved and the two writers are already chosen, so a command can say *what*
 * it emits and nothing about *where* it goes. No channel takes a format, which
 * is the point — a Task-11 command cannot re-open the routing decision, and it
 * has no raw writer to bypass it with.
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

/** The two writers a command's sink is bound to, as `CliContext` supplies them. */
export interface OutputStreams {
  stdout: OutputWriter;
  stderr: OutputWriter;
}

/** What the sink reads from the flags: the format, `--out`, and the two chatter switches. */
export interface OutputSinkFlags extends OutputFlags {
  quiet: boolean;
  verbose: boolean;
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

/**
 * The output sink a command is handed: one format, one pair of writers, all
 * decided before the command runs.
 *
 * Every channel takes exactly one argument — the text to say — and no channel
 * takes a format. That is the whole guarantee: a command cannot pick a stream,
 * because it is never offered one.
 */
export interface CommandOutput {
  /** Render `table` in the resolved format; write it to stdout and to `--out`'s file. */
  payload<Row>(table: Table<Row>): void;
  /** A human line `--quiet` silences, routed by the bound format. */
  note(text: string): void;
  /** A per-chat line, printed only under `-v/--verbose`, routed by the same rule. */
  verbose(text: string): void;
  /**
   * A line that is never the payload, so it always goes to stderr whatever the
   * format is; `--quiet` does not silence it (`plan/cli.md`: `--quiet` is
   * "errors only").
   */
  error(text: string): void;
}

/**
 * Bind the resolved format and the two writers into one sink. `runCli` calls
 * this once per invocation and hands the result to the command, so the routing
 * is decided in one place and no caller supplies a format of its own.
 */
export function bindOutput(streams: OutputStreams, flags: OutputSinkFlags): CommandOutput {
  const format = outputFormat(flags);
  const chatter = chatterChannel(format, streams);
  return {
    payload<Row>(table: Table<Row>): void {
      emitOutput(streams.stdout, flags.out, renderOutput(format, table));
    },
    note(text: string): void {
      if (!flags.quiet) chatter.write(text);
    },
    verbose(text: string): void {
      if (flags.verbose) chatter.write(text);
    },
    error(text: string): void {
      streams.stderr.write(text);
    },
  };
}
