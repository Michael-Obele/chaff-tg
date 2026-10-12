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
 * - a validation error's message is scrubbed against every candidate secret in
 *   the raw *text* — every quoted run, plus every number — before it is thrown,
 *   because valibot echoes the value it rejected ("expected number, received
 *   0123abcd…"). Using the text rather than the parsed value is what covers
 *   the shapes where the parsed value is unusable;
 * - a config whose JSON root is not an object gets a fixed sentence with no
 *   validator message at all, because there the echoed value is the whole file:
 *   it is what a user writes when they paste the hash in and delete the braces;
 * - `resolveCredentials` returns the hash itself and nothing else, which is the
 *   one place it belongs: the argument to the login call.
 *
 * Where the sessions *live* is not decided here. `sessionDir` is carried as
 * written (`null` meaning "no preference") and `resolvePaths`
 * (src/core/session.ts) is the single place that expands `~` and applies XDG.
 *
 * Credentials come from the environment first, each half independently:
 * `CHAFF_API_ID` / `CHAFF_API_HASH` beat the file, and nothing resolves unless
 * both halves do. A half that is set but unusable (`CHAFF_API_ID=abc`) resolves
 * to nothing rather than falling back to the file, because the user asked for
 * the environment value and quietly authenticating as a different app id is
 * worse than refusing.
 *
 * Core rules hold: no stdout, no network, no clock.
 *
 * This module is also the only writer of the file, through
 * `writeConfigCredentials`: the credentials a login collected are recorded there
 * so the next command finds them, and nothing else ever touches the file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
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
  /**
   * Where sessions live, as written in the file, or `null` for "no
   * preference". A leading `~` is kept as written: `resolvePaths`
   * (src/core/session.ts) is the one place that expands it and applies XDG.
   */
  sessionDir: string | null;
}

/**
 * The values in plan/cli.md, "Config file", and nowhere else: every one of them
 * is documented, so a test can pin them and a reader can compare.
 *
 * `sessionDir` is `null` rather than the literal `~/.local/share/chaff-tg`:
 * "no preference" is the honest default, and `resolvePaths` is the single place
 * that turns it into a path (XDG-aware, `~` expanded). plan/cli.md shows the
 * literal because that is the directory a user sees on a default `HOME`, not
 * because this module has a second opinion about where sessions go.
 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  apiId: null,
  apiHash: null,
  session: "default",
  maxLeave: DEFAULT_MAX_LEAVE,
  delayMs: DEFAULT_DELAY_MS,
  sessionDir: null,
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
 * A directory for the sessions: an absolute path, or one starting with `~` for
 * the home directory. A relative one is malformed, because it would drop the
 * session file — the whole account — into whatever directory the command ran
 * in.
 */
const sessionDirPath = v.pipe(
  v.string(),
  v.check(
    (value) => isAbsolute(value) || value === "~" || value.startsWith("~/"),
    "expected an absolute path or one starting with ~",
  ),
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
  sessionDir: v.optional(v.nullable(sessionDirPath)),
});

/** A candidate secret is worth scrubbing out of a message once it is this long. */
const REDACT_MIN_LENGTH = 8;

/** A config should be a JSON object; an array root is not one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every `"…"`-delimited run in the raw text, as written, escapes and all.
 *
 * The text is the one place a candidate secret still exists when the parsed
 * value cannot be used: a root that is a single bare scalar, or a file whose
 * JSON syntax is there but whose object is not.
 */
function quotedRuns(text: string): string[] {
  const runs: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const run = match[1];
    if (run !== undefined) runs.push(run);
  }
  return runs;
}

/** Every number in the parsed value, as valibot would echo it back. */
function numbersIn(value: unknown, depth = 0): string[] {
  if (typeof value === "number") return [String(value)];
  if (depth > 3 || !isRecord(value)) return [];
  return Object.values(value).flatMap((entry) => numbersIn(entry, depth + 1));
}

/**
 * Every property name in the parsed value. A name is not a secret; it is the
 * actionable half of the message ("malformed at \"maxLeave\""), so it must
 * survive even when it is long enough to look like one.
 */
function propertyNames(value: unknown, depth = 0): string[] {
  if (depth > 3 || !isRecord(value)) return [];
  const names = Object.keys(value);
  for (const entry of Object.values(value)) names.push(...propertyNames(entry, depth + 1));
  return names;
}

/**
 * Every candidate secret in the file, as fragments to scrub from a message.
 *
 * Harvested from the raw text and the parsed value together, because neither
 * holds all of them: the text has what the parser refused, the value has the
 * numbers valibot echoes. A run is kept in both spellings — the source text and
 * its decoded form — since a message can carry either. Property names are
 * excluded: they are keys, and a key is never the echo.
 */
function redactionTargets(text: string, raw: unknown): string[] {
  const spelled = quotedRuns(text);
  const candidates = [...spelled, ...numbersIn(raw)];
  for (const run of spelled) {
    try {
      const decoded: unknown = JSON.parse(`"${run}"`);
      if (typeof decoded === "string") candidates.push(decoded);
    } catch {
      // An unterminated run: the source spelling is all there is to scrub.
    }
  }
  const names = new Set(propertyNames(raw));
  return candidates.filter(
    (candidate) => candidate.length >= REDACT_MIN_LENGTH && !names.has(candidate),
  );
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
 * The message for a file that parsed as JSON but did not validate.
 *
 * A non-object root gets a fixed sentence: valibot's message for one quotes the
 * received value, and for a scalar root that value is the entire file — which
 * is exactly what is left behind when someone pastes the api hash between the
 * braces and then deletes the braces. An object root keeps the issue message,
 * because naming the offending key is what makes the error actionable, but
 * every candidate secret from the file is scrubbed out of it first.
 */
function malformedMessage(
  configPath: string,
  text: string,
  raw: unknown,
  issue: v.BaseIssue<unknown> | undefined,
): string {
  if (!isRecord(raw)) {
    return `config at ${configPath} is malformed: expected a JSON object of the documented keys.`;
  }
  const where = issue === undefined ? "" : v.getDotPath(issue);
  const detail =
    issue === undefined
      ? "is malformed"
      : `is malformed${where ? ` at "${where}"` : ""}: ${issue.message}`;
  return redact(`config at ${configPath} ${detail}`, redactionTargets(text, raw));
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
    throw new ConfigError("malformed", malformedMessage(configPath, text, raw, parsed.issues[0]));
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

/**
 * Record the credentials a login collected, so the next command finds them.
 *
 * `chaff login` is the only writer. The credentials arrive from a prompt, and a
 * later `chaff list` run from another directory has nowhere else to read them
 * from: the environment was set in the shell that ran the login and is not there
 * anymore. The api hash is a secret, so the file is created mode 600 inside the
 * 700 config directory (the caller creates that directory), the same rule as the
 * session file. An existing file keeps the mode it already has, on purpose.
 *
 * Keys already in the file are kept: a user who hand-wrote `session` or
 * `maxLeave` should not lose them to a login. A file that cannot be read or
 * parsed is replaced, because the next command would refuse it anyway and
 * deleting it by hand is the only other way out of that state.
 */
export function writeConfigCredentials(
  configPath: string,
  credentials: { apiId: number; apiHash: string },
): void {
  const merged: Record<string, unknown> = {};
  try {
    const existing: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      Object.assign(merged, existing);
    }
  } catch {
    // Missing, unreadable, or not JSON: there is nothing to keep.
  }
  merged.apiId = credentials.apiId;
  merged.apiHash = credentials.apiHash;
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}
