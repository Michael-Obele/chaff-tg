/**
 * Where the session file lives, and the modes it has to be born with
 * (plan/safety.md, "The session file", "Local privileges and files").
 *
 * The session file is the whole account: anyone who has it can act as the user
 * without a password, a code or two factor. So this module owns the two rules
 * that keep it private, and owns them in one place so no front end has to
 * remember them:
 *
 * - the session directory is created mode 700 and the session file mode 600,
 *   *with* those modes rather than chmod-ed afterwards — an existing file is
 *   left exactly as the user made it, because re-moding is how a deliberate
 *   choice gets silently overwritten;
 * - `removeSession` deletes the SQLite side files (`-wal`, `-shm`, `-journal`)
 *   too, because a stray write-ahead log next to a deleted session is still a
 *   copy of the session.
 *
 * Paths follow the XDG base directory spec: `XDG_DATA_HOME` / `XDG_CONFIG_HOME`
 * when they are set to an absolute path, `~/.local/share` and `~/.config`
 * otherwise. Both are read from the injected env, never from the ambient
 * `process.env` inside the functions, so a test can point the whole module at a
 * temporary root and never touch the real `~/.local/share/chaff-tg`.
 *
 * Core rules hold (plan/architecture.md, "Repo layout"): nothing here imports
 * from `src/cli` or `src/tui`, and nothing here writes to stdout or stderr.
 *
 * `ensureSession` is not in the task's interface list. It is the one place that
 * can make the "created 600, never fixed up" rule true for a file this package
 * does not write itself: the SQLite store inherits the mode of an existing
 * file, so pre-creating it is what gives the session its mode. `src/core/journal.ts`
 * already does exactly this for the journal database.
 */
import { statSync } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The directory name under the data and config roots, as plan/cli.md spells it. */
const APP_DIR = "chaff-tg";

/** The session file: `<name>.session`, the name mtcute is handed. */
const SESSION_SUFFIX = ".session";

/** The journal database, beside the session file (plan/safety.md, the table). */
const JOURNAL_SUFFIX = ".journal.db";

/** The files SQLite leaves beside a database, which a logout has to take too. */
const SQLITE_SIBLINGS = ["-wal", "-shm", "-journal"] as const;

/** A session name is a file name, so it may not walk out of the directory. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The resolved local state. Every path is absolute; none of them is a secret. */
export interface Paths {
  /** The session directory: mode 700, holds the sessions and the journal. */
  dataDir: string;
  /** The optional config file (`loadConfig`, src/core/config.ts). */
  configPath: string;
  /** The session file for `name`, which the Telegram client opens. */
  sessionPath(name: string): string;
  /** The resume journal for `name`, a separate SQLite database. */
  journalPath(name: string): string;
}

/** The home directory to fall back to, ignoring a relative or blank `HOME`. */
function homeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim();
  if (home !== undefined && home !== "" && isAbsolute(home)) return home;
  return homedir();
}

/**
 * An XDG base directory: the env value when it is absolute, the fallback
 * otherwise. XDG requires an absolute path, and a relative one would scatter
 * session files through whatever directory the command ran in.
 */
function xdgRoot(value: string | undefined, fallback: string): string {
  const root = value?.trim();
  if (root !== undefined && root !== "" && isAbsolute(root)) return root;
  return fallback;
}

/** A name that is safe to append to the data directory, or a throw if it is not. */
function safeName(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `invalid session name ${JSON.stringify(name)}: expected letters, digits, . _ -`,
    );
  }
  return name;
}

/**
 * Resolve every local path from the environment, defaulting to the ambient one.
 * Nothing here reads the filesystem: a path that does not exist yet is still a
 * path, and `ensureSecureDir` is what makes the directory real.
 */
export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = homeDir(env);
  const dataDir = join(xdgRoot(env.XDG_DATA_HOME, join(home, ".local", "share")), APP_DIR);
  const configDir = join(xdgRoot(env.XDG_CONFIG_HOME, join(home, ".config")), APP_DIR);
  return {
    dataDir,
    configPath: join(configDir, "config.json"),
    sessionPath: (name) => join(dataDir, `${safeName(name)}${SESSION_SUFFIX}`),
    journalPath: (name) => join(dataDir, `${safeName(name)}${JOURNAL_SUFFIX}`),
  };
}

/**
 * Create `dir` if it is missing, mode 700. An existing directory is left
 * exactly as it was found: the mode is applied on creation, never repaired.
 */
export async function ensureSecureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Make sure the session directory and the session file exist, the file mode
 * 600, and hand back its path for the client to open.
 *
 * The file is pre-created rather than chmod-ed afterwards because the SQLite
 * store keeps the mode of a file that is already there; an existing file is
 * left as it is, for the same reason `ensureSecureDir` does not re-mode.
 */
export async function ensureSession(p: Paths, name: string): Promise<string> {
  const path = p.sessionPath(name);
  await ensureSecureDir(p.dataDir);
  const handle = await open(path, "a", 0o600);
  await handle.close();
  return path;
}

/** Whether the session file for `name` is there and is a file. */
export async function sessionExists(p: Paths, name: string): Promise<boolean> {
  try {
    return (await stat(p.sessionPath(name))).isFile();
  } catch {
    return false;
  }
}

/** Delete `path`, saying whether it was there. Only a missing file is forgiven. */
async function remove(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Delete the session for `name`: the file itself plus the `-wal`, `-shm` and
 * `-journal` files SQLite leaves beside it. Any of them counts as something to
 * remove, so an interrupted run's leftovers are reported rather than ignored.
 *
 * The journal database is deliberately not touched here — `chaff logout`
 * composes that step (plan/safety.md, "Logging") — because a session can be
 * re-created without discarding the run history.
 */
export async function removeSession(p: Paths, name: string): Promise<boolean> {
  const base = p.sessionPath(name);
  let removed = false;
  for (const path of [base, ...SQLITE_SIBLINGS.map((suffix) => `${base}${suffix}`)]) {
    if (await remove(path)) removed = true;
  }
  return removed;
}

/**
 * The permission bits of whatever sits at `path`, or `null` when there is
 * nothing readable there. This is what `chaff doctor` compares against 600 and
 * 700 (plan/safety.md, "Local privileges and files"); the file type bits are
 * dropped so the number reads as a mode.
 */
export function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}
