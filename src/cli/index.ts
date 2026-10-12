#!/usr/bin/env bun
/**
 * The CLI front end: parse, dispatch, return an exit code (`plan/cli.md`).
 *
 * `runCli` is the whole front end, and it is a function of its context: argv,
 * the environment, the two writers, the clock and whether stdout is a TTY all
 * arrive as arguments. Nothing in here reads `process` or the real console, so
 * a test can run any command and capture every byte it produces, and the TUI
 * (v2) can reuse the same dispatch. The only place that touches the process is
 * the thin wrapper at the bottom of this file, and even that only sets
 * `process.exitCode` — `runCli` never exits, because a function that kills its
 * own caller cannot be tested.
 *
 * Dispatch is a table, not a chain: `COMMANDS` is the list of commands, and it
 * is also the command list the usage text is rendered from, so adding a command
 * is adding one row. Every row is a stub until Tasks 11-14 land the real
 * commands; a stub says so on stderr and exits 1 (`EXIT.ERROR`), because "not
 * built yet" is an unexpected error, not a usage mistake.
 *
 * A command never sees a raw writer, and that is a fact about the object, not a
 * promise the compiler keeps. `runCli` resolves the output format and binds it
 * to the two writers once per invocation (`output.ts`, `bindOutput`), then
 * builds a fresh `CommandContext` out of the parsed args, that sink, and the
 * environment, clock and TTY flag — never the `CliContext` itself. The two
 * writers stay in `runCli`'s own frame, so there is no `ctx.stdout` to write to
 * even with a cast, and no channel on the sink takes a format to override.
 *
 * Failures are mapped in one place: bad usage exits 2, a classified
 * `ChaffError` exits with the code the core's taxonomy already chose, and
 * anything else exits 1. The core returns facts and this file turns them into
 * codes — the same rule `runLeave` follows, one level up.
 */
import { ChaffError, EXIT } from "../core/errors";
import { parseArgs, UsageError, type ParsedArgs } from "./args";
import { NotLoggedInError } from "./client";
import { doctorCommand } from "./commands/doctor";
import { journalCommand } from "./commands/journal";
import { leaveCommand } from "./commands/leave";
import { listCommand } from "./commands/list";
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { reportCommand } from "./commands/report";
import { tuiCommand } from "./commands/tui";
import { whoamiCommand } from "./commands/whoami";
import { bindOutput, type CommandOutput } from "./output";
import { renderUsage, type CommandBrief } from "./usage";

/**
 * The version and commit the build stamped in (`scripts/build.ts` defines
 * `CHAFF_VERSION` and `CHAFF_COMMIT`). Both are `typeof`-guarded because
 * `bun run src/cli/index.ts` has no build step and the identifiers are simply
 * not there; `dev` is the honest answer for a from-source run.
 */
declare const CHAFF_VERSION: string | undefined;
declare const CHAFF_COMMIT: string | undefined;

/** The version this build reports. */
export const CLI_VERSION: string = typeof CHAFF_VERSION === "undefined" ? "dev" : CHAFF_VERSION;

/** The commit this build came from. */
export const CLI_COMMIT: string = typeof CHAFF_COMMIT === "undefined" ? "dev" : CHAFF_COMMIT;

/** `chaff <version> (<commit>)`, which is what `--version` prints. */
export function versionLine(): string {
  return `chaff ${CLI_VERSION} (${CLI_COMMIT})\n`;
}

/** Anything that can receive a written chunk: `process.stdout`, or a test's sink. */
export interface Writer {
  write(s: string): unknown;
}

/** Everything `runCli` is allowed to touch, all of it injected. */
export interface CliContext {
  /** The command line without the runtime and the script path. */
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: Writer;
  stderr: Writer;
  /** The clock, so a command never reads the system time itself. */
  now(): Date;
  /** Whether stdout is a terminal, which decides prompts and the checklist. */
  isTTY: boolean;
}

/**
 * What a command is handed: a new object, built per invocation, holding only
 * what a command needs. It is deliberately not `Omit<CliContext, …>`, because
 * an `Omit` is a promise about a *type* while the value is still whatever was
 * passed: the front end used to hand over the whole `CliContext`, so the two
 * writers sat on the object and one `as CliContext` reached them. This object
 * is built without them, so there is nothing for a cast to find.
 */
export interface CommandContext {
  /** The parsed command line; `args.command` names the command being run. */
  readonly args: ParsedArgs;
  /** The sink `runCli` bound for this invocation: the only writer a command may use. */
  readonly out: CommandOutput;
  /** The environment, so a command never reads `process.env` itself. */
  readonly env: Record<string, string | undefined>;
  /** The clock, so a command never reads the system time itself. */
  now(): Date;
  /** Whether stdout is a terminal, which decides prompts and the checklist. */
  readonly isTTY: boolean;
}

/** One command: how it is listed in the help, and what it does. */
export interface Command extends CommandBrief {
  /**
   * Returns the process exit code; never calls `process.exit`. `ctx` carries the
   * parsed arguments and the sink bound for this invocation, and nothing else.
   */
  run(ctx: CommandContext): Promise<number>;
}

/** A command that has not been built yet. Tasks 11-14 replace these rows. */
function stub(name: string, summary: string): Command {
  return {
    name,
    summary,
    async run(ctx) {
      ctx.out.error(`${name} is not implemented yet.\n`);
      return EXIT.ERROR;
    },
  };
}

/** Every command, in the order `plan/cli.md`, "Commands" lists them. */
export const COMMANDS: readonly Command[] = [
  loginCommand,
  whoamiCommand,
  listCommand,
  reportCommand,
  leaveCommand,
  journalCommand,
  doctorCommand,
  logoutCommand,
  tuiCommand,
];

/** A thrown value as a sentence: no stack trace, no `[object Object]`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The exit code a thrown value earns. A usage error is 2; a local precondition
 * a command can explain (`NotLoggedInError`) carries the code the plan gives
 * it, 3; a classified Telegram failure carries the code the taxonomy already
 * chose (`src/core/errors.ts`); anything else is an unexpected error, 1.
 */
function exitCodeOf(error: unknown): number {
  if (error instanceof UsageError) return error.exitCode;
  if (error instanceof NotLoggedInError) return error.exitCode;
  if (error instanceof ChaffError) return error.exitCode;
  return EXIT.ERROR;
}

/**
 * Run one command line and return its exit code.
 *
 * `commands` is the dispatch table and defaults to the real one; a test passes
 * a probe command to drive this path without adding a row to `COMMANDS`.
 *
 * `--version` wins over everything: it has to work even when the rest of the
 * line is nonsense, which is what a bug report needs. `--help` is a request for
 * information rather than a failure, so it prints the usage text to stdout and
 * exits 0 (`plan/cli.md`, "Exit codes": 0 is "Success"). The lines the tool
 * cannot act on — no command, an unknown command, a flag that is unknown or
 * conflicting — are the ones that print the usage text to stderr and exit 2.
 */
export async function runCli(
  ctx: CliContext,
  commands: readonly Command[] = COMMANDS,
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(ctx.argv);
  } catch (error) {
    ctx.stderr.write(`${messageOf(error)}\n\n${renderUsage(commands)}`);
    return exitCodeOf(error);
  }

  if (args.flags.version) {
    ctx.stdout.write(versionLine());
    return EXIT.OK;
  }

  if (args.flags.help) {
    ctx.stdout.write(renderUsage(commands));
    return EXIT.OK;
  }

  if (args.command === null) {
    ctx.stderr.write(renderUsage(commands));
    return EXIT.USAGE;
  }

  const command = commands.find((candidate) => candidate.name === args.command);
  if (command === undefined) {
    ctx.stderr.write(`unknown command ${JSON.stringify(args.command)}\n\n${renderUsage(commands)}`);
    return EXIT.USAGE;
  }

  // One sink per invocation, bound here: every command this run dispatches gets
  // the same routing rule, and the format is not a command's to choose.
  const out = bindOutput(ctx, args.flags);

  // And one context per invocation, built here rather than passed along: the
  // writers are not copied into it, so a command has no stream to reach, cast or
  // no cast. `argv` stays out for the same reason — a command has `args`.
  const commandContext: CommandContext = {
    args,
    out,
    env: ctx.env,
    now: ctx.now,
    isTTY: ctx.isTTY,
  };

  try {
    return await command.run(commandContext);
  } catch (error) {
    ctx.stderr.write(`${messageOf(error)}\n`);
    return exitCodeOf(error);
  }
}

/** The real process, wired into the injected context. Used by the wrapper only. */
function processContext(): CliContext {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => new Date(),
    isTTY: process.stdout.isTTY === true,
  };
}

// The thin wrapper: the only code that knows a process exists. `import.meta.main`
// is false when a test imports this file, so nothing here runs under `bun test`.
if (import.meta.main) {
  process.exitCode = await runCli(processContext());
}
