/**
 * The usage text: what `--help`, a missing command, an unknown command and a
 * bad flag all print (`plan/cli.md`).
 *
 * The text is rendered from the same tables the parser uses — the command list
 * from the dispatcher, the flags from `FLAG_SPECS` — so the help can never
 * drift from what the CLI actually accepts. A command appears here because it
 * has a row in the dispatch table, and a flag appears because it has a row in
 * the flag table; neither is maintained twice.
 *
 * The exit codes are read from `EXIT` (src/core/errors.ts), which is the one
 * place they are defined.
 */
import { EXIT } from "../core/errors";
import { FLAG_SPECS, GROUP_TITLES, spellingOf, type FlagGroup } from "./args";

/** The one line that says how the CLI is called. */
const SYNOPSIS = "chaff <command> [filters] [options]";

/** What each exit code means, in the order `plan/cli.md` lists them. */
const EXIT_CODES: ReadonlyArray<readonly [number, string]> = [
  [EXIT.OK, "Success, including a clean dry run"],
  [EXIT.ERROR, "Unexpected error"],
  [EXIT.USAGE, "Bad usage, unknown flag, or conflicting flags"],
  [EXIT.NOT_LOGGED_IN, "Not logged in, or the session is unreadable"],
  [EXIT.PARTIAL, "Some leaves failed; the journal has the details"],
  [EXIT.FLOOD, "Stopped because of a flood wait longer than the allowed maximum"],
];

/** The two example sessions from `plan/cli.md`, "Example sessions". */
const EXAMPLES: readonly string[] = [
  "chaff list --muted --inactive-days 365",
  "chaff report --muted --inactive-days 365 --md --out cleanup.md",
  "chaff check --from plans/cleanup-2026-10-11.json",
  "chaff leave --from plans/cleanup-2026-10-11.json --dry-run",
  "chaff leave --keyword signal,vip,airdrop --type channel --yes",
];

/** As much of a command as the help needs. */
export interface CommandBrief {
  name: string;
  summary: string;
}

/** The sections of the flag reference, in the order they are printed. */
const SECTIONS: readonly FlagGroup[] = ["general", "filters", "selection", "output"];

/** A `label  description` block, aligned on the widest label. */
function indent(items: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(0, ...items.map(([label]) => label.length));
  return items.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`).join("\n");
}

/** Render the whole usage text, ending with a newline. */
export function renderUsage(commands: readonly CommandBrief[]): string {
  const blocks: string[] = [SYNOPSIS];

  blocks.push(
    "Commands",
    indent(commands.map((command) => [command.name, command.summary] as const)),
  );

  for (const group of SECTIONS) {
    const specs = FLAG_SPECS.filter((spec) => spec.group === group);
    if (specs.length === 0) continue;
    blocks.push(
      GROUP_TITLES[group],
      indent(specs.map((spec) => [spellingOf(spec), spec.help] as const)),
    );
  }

  blocks.push(
    "Exit codes",
    indent(EXIT_CODES.map(([code, meaning]) => [String(code), meaning] as const)),
    "Examples",
    EXAMPLES.map((example) => `  ${example}`).join("\n"),
  );

  return `${blocks.join("\n\n")}\n`;
}
