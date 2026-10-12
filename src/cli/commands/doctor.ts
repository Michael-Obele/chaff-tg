/**
 * `chaff doctor`: what the local setup looks like (`plan/safety.md`, "Local
 * privileges and files").
 *
 * The session file is the whole account, so the two things worth checking are
 * where it lives and who else can read it. This command answers both: the
 * resolved paths, the modes it actually found, whether the directory that holds
 * the session sits inside a git repository, and which config values are
 * present.
 *
 * Three rules make it a doctor rather than a repair tool:
 *
 * - **It reports; it does not create or fix.** Nothing here writes, `chmod`s or
 *   `mkdir`s — not even the data directory it is describing. Creating the
 *   directory it is diagnosing would hide the very problem it is reporting, and
 *   a diagnostic that changes the system is worth less than the exit code.
 * - **It never prints a secret.** The api id and hash are reported as *present*
 *   or *absent* (`fileMode`'s neighbours, not their values) because what a
 *   diagnosis needs is whether the tool can authenticate, not the credential
 *   itself (`plan/safety.md`, "Logging").
 * - **A config file it cannot read is a finding, not a crash.** `loadConfig`
 *   throws a `ConfigError` with a secret-free message; this command catches it,
 *   prints that message, and carries on with the paths it can still resolve —
 *   `resolvePaths(env)` without the `sessionDir` the unreadable file would have
 *   supplied.
 *
 * A mode looser than the one `plan/safety.md` requires is the one thing that
 * earns a warning line, and it is warned about as well as tabulated, so it is
 * visible without reading the table.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, DEFAULT_CONFIG, resolveCredentials } from "../../core/config";
import { EXIT } from "../../core/errors";
import { fileMode, resolvePaths } from "../../core/session";
import type { Command } from "../index";
import { resolveLocalState } from "../client";
import { factsTable } from "../render/facts";

/** The bits that make a mode looser than "only the owner can read it". */
const LOOSE_BITS = 0o077;

/** One path, the mode it is supposed to have, and what to call it. */
interface PathCheck {
  /** The key this check has in the JSON document. */
  key: "dataDir" | "config" | "session" | "journal";
  /** How the path is named in the table. */
  label: string;
  path: string;
  /** The mode `plan/safety.md` asks for. */
  required: number;
}

/** A mode as `plan/safety.md` writes it: three octal digits, or nothing found. */
function octal(mode: number | null): string {
  return mode === null ? "" : mode.toString(8).padStart(3, "0");
}

/** A path and its mode, in the two shapes the table and JSON need. */
function describe(check: PathCheck, mode: number | null): string {
  return mode === null ? `${check.path} (missing)` : `${check.path} (mode ${octal(mode)})`;
}

/** Whether a mode is looser than required: any group or other bit set. */
function looser(mode: number): boolean {
  return (mode & LOOSE_BITS) !== 0;
}

/**
 * The git repository `dir` sits in, if it sits in one.
 *
 * Walked upwards because that is what git itself does: the directory holding
 * the session may be a plain subdirectory of a repository, and `.git` may be a
 * directory (a normal checkout) or a file (a worktree or a submodule), so this
 * asks whether the entry exists rather than what it is.
 *
 * Exported because `chaff report` asks the same question about the directory
 * `--out` points into, and one walk beats two copies of it.
 */
export function gitRepositoryOf(dir: string): { inside: boolean; root: string | null } {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return { inside: true, root: current };
    const parent = dirname(current);
    if (parent === current) return { inside: false, root: null };
    current = parent;
  }
}

/** Whether a variable carries a value; blank counts as unset, as in the core. */
function setOrUnset(value: string | undefined): "set" | "unset" {
  return typeof value === "string" && value.trim() !== "" ? "set" : "unset";
}

/** Whether a credential half is configured, as far as the config file goes. */
function presentOrAbsent(value: unknown): "present" | "absent" {
  return value === null || value === undefined ? "absent" : "present";
}

/** The plain sentence a caught value carries. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check the local setup: paths, file modes, and config",

  async run(ctx) {
    const env = ctx.env;

    // The config is the one part of this that can refuse to be read, and that
    // refusal is exactly the kind of finding doctor exists to report.
    let config: Config | null = null;
    let configError: string | null = null;
    try {
      config = resolveLocalState(env).config;
    } catch (error) {
      configError = messageOf(error);
    }

    const paths = config === null ? resolvePaths(env) : resolvePaths(env, config.sessionDir);
    const sessionName = config === null ? DEFAULT_CONFIG.session : config.session;

    // One row per path, and the modes read from exactly those rows, so the table
    // and the JSON cannot describe different files.
    const dataDir = {
      key: "dataDir",
      label: "data directory",
      path: paths.dataDir,
      required: 0o700,
    } as const satisfies PathCheck;
    const configFile = {
      key: "config",
      label: "config file",
      path: paths.configPath,
      required: 0o600,
    } as const satisfies PathCheck;
    const sessionFile = {
      key: "session",
      label: "session file",
      path: paths.sessionPath(sessionName),
      required: 0o600,
    } as const satisfies PathCheck;
    const journalFile = {
      key: "journal",
      label: "journal file",
      path: paths.journalPath(),
      required: 0o600,
    } as const satisfies PathCheck;
    const checks: readonly PathCheck[] = [dataDir, configFile, sessionFile, journalFile];

    const modes = {
      dataDir: fileMode(dataDir.path),
      config: fileMode(configFile.path),
      session: fileMode(sessionFile.path),
      journal: fileMode(journalFile.path),
    };

    const warnings = checks
      .map((check) => ({ check, mode: modes[check.key] }))
      .filter(({ check, mode }) => mode !== null && looser(mode))
      .map(
        ({ check, mode }) =>
          `${check.label} mode ${octal(mode)} is looser than the required ${octal(check.required)}`,
      );

    const git = gitRepositoryOf(paths.dataDir);
    const credentials = config === null ? null : resolveCredentials(config, env);
    const credentialsLabel =
      config === null ? "unknown" : credentials === null ? "incomplete" : "ready";

    const rows: Array<readonly [string, string]> = [
      ...checks.map((check) => [check.label, describe(check, modes[check.key])] as const),
      ["git repository", git.inside ? `yes (repository root ${git.root})` : "no"],
      ["session name", sessionName],
      ["session dir", config?.sessionDir ?? "(default)"],
      ["max leave", String(config?.maxLeave ?? DEFAULT_CONFIG.maxLeave)],
      ["delay", `${config?.delayMs ?? DEFAULT_CONFIG.delayMs} ms`],
      ["config api id", config === null ? "unknown" : presentOrAbsent(config.apiId)],
      ["config api hash", config === null ? "unknown" : presentOrAbsent(config.apiHash)],
      ["env CHAFF_API_ID", setOrUnset(env.CHAFF_API_ID)],
      ["env CHAFF_API_HASH", setOrUnset(env.CHAFF_API_HASH)],
      ["credentials", credentialsLabel],
    ];
    if (configError !== null) rows.push(["config error", configError]);

    ctx.out.document({
      json: {
        paths: {
          dataDir: paths.dataDir,
          configPath: paths.configPath,
          sessionPath: paths.sessionPath(sessionName),
          journalPath: paths.journalPath(),
        },
        modes: {
          dataDir: modes.dataDir === null ? null : octal(modes.dataDir),
          config: modes.config === null ? null : octal(modes.config),
          session: modes.session === null ? null : octal(modes.session),
          journal: modes.journal === null ? null : octal(modes.journal),
        },
        gitRepository: git,
        config: {
          file: paths.configPath,
          error: configError,
          session: sessionName,
          sessionDir: config?.sessionDir ?? null,
          maxLeave: config?.maxLeave ?? DEFAULT_CONFIG.maxLeave,
          delayMs: config?.delayMs ?? DEFAULT_CONFIG.delayMs,
          apiId: config === null ? "unknown" : presentOrAbsent(config.apiId),
          apiHash: config === null ? "unknown" : presentOrAbsent(config.apiHash),
        },
        environment: {
          CHAFF_API_ID: setOrUnset(env.CHAFF_API_ID),
          CHAFF_API_HASH: setOrUnset(env.CHAFF_API_HASH),
        },
        credentials: credentialsLabel,
        warnings,
      },
      table: factsTable(rows),
    });

    // Beside the table as well as inside it: a mode that lets another user read
    // the account is worth a line of its own, not just a cell to notice.
    for (const warning of warnings) ctx.out.note(`warning: ${warning}\n`);
    return EXIT.OK;
  },
};
