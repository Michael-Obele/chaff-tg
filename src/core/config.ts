/**
 * The optional config file, `~/.config/chaff-tg/config.json`
 * (plan/cli.md, "Config file"; plan/safety.md, "Local privileges and files").
 *
 * Values here are defaults that flags override, so a missing file is not an
 * error — it is the tool running on its documented defaults. A file that is
 * there and wrong is an error, because silently ignoring half of what the user
 * wrote is worse than saying so.
 *
 * The api hash is the reason this module is careful about text. It is the one
 * secret the config can hold, and it must never reach a message, a log line or
 * a stack trace (plan/safety.md, "Logging"). Concretely:
 *
 * - a JSON syntax error is reported *without* the parser's own message, because
 *   that message quotes the input it choked on, and the input may be the hash;
 * - a validation error's message is scrubbed against every string value found
 *   in the file before it is thrown, because valibot echoes the value it
 *   rejected ("expected number, received 0123abcd…");
 * - `resolveCredentials` returns the hash itself and nothing else, which is the
 *   one place it belongs: the argument to the login call.
 *
 * Credentials come from the environment first, each half independently:
 * `CHAFF_API_ID` / `CHAFF_API_HASH` beat the file, and nothing resolves unless
 * both halves do. A half that is set but unusable (`CHAFF_API_ID=abc`) resolves
 * to nothing rather than falling back to the file, because the user asked for
 * the environment value and quietly authenticating as a different app id is
 * worse than refusing.
 *
 * Core rules hold: no stdout, no network, no clock.
 */
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { DEFAULT_DELAY_MS } from "./plan";

/** The documented `--max-leave` default, in chats (plan/safety.md, "Telegram's side of the risk"). */
const DEFAULT_MAX_LEAVE = 50;

/** Everything a run reads out of the config file, after defaults are applied. */
export interface Config {
  /** The my.telegram.org app id, or null when it has not been supplied yet. */
  apiId: number | null;
  /** The app hash, or null. Kept out of the binary by design (plan/safety.md). */
  apiHash: string | null;
  /** The session name: which `<name>.session` this run uses. */
  session: string;
  /** Refuse a run that would leave more chats than this without a fresh yes. */
  maxLeave: number;
  /** The base delay between leaves; jitter is added on top (src/core/pacing.ts). */
  delayMs: number;
  /** Where sessions live, as written in the file. `~` is the CLI's to expand. */
  sessionDir: string;
}

/**
 * The values in plan/cli.md, "Config file", and nowhere else: every one of them
 * is documented, so a test can pin them and a reader can compare.
 *
 * `sessionDir` stays the literal `~/.local/share/chaff-tg` the spec writes,
 * rather than an XDG-resolved path: this is what the file says when a user asks
 * what the default is, while `resolvePaths` (src/core/session.ts) is the one
 * that knows about `XDG_DATA_HOME`.
 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  apiId: null,
  apiHash: null,
  session: "default",
  maxLeave: DEFAULT_MAX_LEAVE,
  delayMs: DEFAULT_DELAY_MS,
  sessionDir: "~/.local/share/chaff-tg",
});

/** Why a config file was refused. Users read the message; scripts read the code. */
export type ConfigErrorCode = "not-json" | "malformed" | "unreadable";

/** Refuses a config file that cannot be trusted, with a plain, secret-free message. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

/** Credentials, once both halves are known: what a login call needs. */
export interface Credentials {
  apiId: number;
  apiHash: string;
}

/** Ids, counts and delays are whole numbers; a fractional one is malformed. */
const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonEmpty = v.pipe(v.string(), v.minLength(1));

/**
 * A session name becomes part of a file name, so it has to stay inside the data
 * directory: it starts with a letter or digit, so `.`, `..` and anything with a
 * separator are malformed rather than a path that escapes.
 */
const sessionName = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "expected a name starting with a letter or digit"),
);

/**
 * Every key is optional, and an absent one falls back to the default. Unknown
 * keys are dropped rather than rejected, so a config written for a newer build
 * still loads here — the same forward compatibility the manifest has.
 */
const configSchema = v.object({
  apiId: v.optional(v.nullable(positiveInt)),
  apiHash: v.optional(v.nullable(nonEmpty)),
  session: v.optional(sessionName),
  maxLeave: v.optional(positiveInt),
  delayMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  sessionDir: v.optional(nonEmpty),
});

/** A string value is worth scrubbing from a message once it is this long. */
const REDACT_MIN_LENGTH = 8;

/** Every string in the parsed file that could be the api hash. */
function redactionTargets(value: unknown, depth = 0): string[] {
  if (depth > 3 || typeof value !== "object" || value === null) return [];
  const found: string[] = [];
  for (const entry of Object.values(value)) {
    if (typeof entry === "string" && entry.length >= REDACT_MIN_LENGTH) found.push(entry);
    else found.push(...redactionTargets(entry, depth + 1));
  }
  return found;
}

/** Replace every candidate secret in `message`, so no fragment of one survives. */
function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) out = out.split(secret).join("***");
  return out;
}

/** The errno code, which names the failure without quoting any file content. */
function unreadableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && code !== "" ? code : "unknown error";
}

/**
 * Read the config file. A missing file is the defaults, not an error; a file
 * that is there but unreadable, unparseable or malformed throws a `ConfigError`
 * whose message names the path and never a value from the file.
 */
export function loadConfig(configPath: string): Config {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new ConfigError(
      "unreadable",
      `config at ${configPath} could not be read (${unreadableReason(error)}).`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Deliberately no parser message: it quotes the text it failed on, and that
    // text may hold the api hash (plan/safety.md, "Logging").
    throw new ConfigError("not-json", `config at ${configPath} is not valid JSON.`);
  }

  const parsed = v.safeParse(configSchema, raw);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const where = issue === undefined ? "" : v.getDotPath(issue);
    const detail =
      issue === undefined
        ? "is malformed"
        : `is malformed${where ? ` at "${where}"` : ""}: ${issue.message}`;
    throw new ConfigError(
      "malformed",
      redact(`config at ${configPath} ${detail}`, redactionTargets(raw)),
    );
  }

  return {
    apiId: parsed.output.apiId ?? null,
    apiHash: parsed.output.apiHash ?? null,
    session: parsed.output.session ?? DEFAULT_CONFIG.session,
    maxLeave: parsed.output.maxLeave ?? DEFAULT_CONFIG.maxLeave,
    delayMs: parsed.output.delayMs ?? DEFAULT_CONFIG.delayMs,
    sessionDir: parsed.output.sessionDir ?? DEFAULT_CONFIG.sessionDir,
  };
}

/** Whether the environment actually carries a value for a credential. */
function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** A Telegram app id as the environment writes it: digits only, above zero. */
function parseEnvApiId(text: string): number | null {
  const digits = text.trim();
  if (!/^\d+$/.test(digits)) return null;
  const id = Number.parseInt(digits, 10);
  return id > 0 ? id : null;
}

/** A positive whole number, or null: the config is not the only way in. */
function usableApiId(value: number | null): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A hash is any non-blank string. It is not checked against a hex shape: the
 * format is Telegram's, not ours, and rejecting a valid one would be worse than
 * passing a wrong one on and letting Telegram say so.
 */
function usableApiHash(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const hash = value.trim();
  return hash === "" ? null : hash;
}

/**
 * The credentials for a login, or null when either half is missing.
 *
 * The environment wins over the file for each half on its own, so
 * `CHAFF_API_HASH=… chaff login` works with the id in the config. A half the
 * environment sets but cannot be used is unresolved, never the file's value.
 */
export function resolveCredentials(
  cfg: Config,
  env: Record<string, string | undefined>,
): Credentials | null {
  const envId = env.CHAFF_API_ID;
  const envHash = env.CHAFF_API_HASH;

  const apiId = isSet(envId) ? parseEnvApiId(envId) : usableApiId(cfg.apiId);
  const apiHash = isSet(envHash) ? usableApiHash(envHash) : usableApiHash(cfg.apiHash);

  if (apiId === null || apiHash === null) return null;
  return { apiId, apiHash };
}
