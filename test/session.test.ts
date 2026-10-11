/**
 * Secure session storage: XDG-aware paths, creation modes, and the removal of
 * the SQLite side files (plan/safety.md, "The session file", "Local privileges
 * and files").
 *
 * Contract under test:
 * - `resolvePaths` honors `XDG_DATA_HOME` / `XDG_CONFIG_HOME` when they are
 *   absolute, and falls back to `~/.local/share` / `~/.config`; the session and
 *   the one journal live in the data directory.
 * - A `sessionDir` a config file asks for replaces that data directory, with a
 *   leading `~` expanded to the home directory; a relative one is refused.
 * - `ensureSecureDir` creates a missing directory mode 700 and leaves an
 *   existing one exactly as it found it — created with the mode, never fixed up.
 * - `ensureSession` pre-creates the session file mode 600, so the store that
 *   fills it inherits that mode, and never re-modes a file that is already there.
 * - `sessionExists` is false for a name with no file.
 * - `removeSession` removes the file and its `-wal`, `-shm` and `-journal`
 *   siblings, and reports whether there was anything to remove.
 * - `fileMode` reports the permission bits, or null when there is nothing there.
 *
 * No test touches the real `~/.local/share/chaff-tg`: every path comes from an
 * injected env pointing at a fresh temporary root, so the only directory a test
 * creates is the one it deletes afterwards.
 */
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Paths } from "../src/core/session";
import {
  ensureSecureDir,
  ensureSession,
  fileMode,
  removeSession,
  resolvePaths,
  sessionExists,
} from "../src/core/session";

/** The temporary root every test hangs its XDG directories under. */
let root: string;
/** A data and config root pointing at `root`, never at the real home directory. */
let env: Record<string, string | undefined>;
let paths: Paths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chaff-session-"));
  env = {
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  paths = resolvePaths(env);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  test("honors XDG_DATA_HOME and XDG_CONFIG_HOME", () => {
    expect(paths.dataDir).toBe(join(root, "data", "chaff-tg"));
    expect(paths.configPath).toBe(join(root, "config", "chaff-tg", "config.json"));
  });

  test("keeps the session and the one journal in the data directory", () => {
    expect(paths.sessionPath("work")).toBe(join(root, "data", "chaff-tg", "work.session"));
    // One journal per data directory, never one per session: `src/core/journal.ts`
    // documents a single database, and plan/safety.md has `chaff logout` remove it.
    expect(paths.journalPath()).toBe(join(root, "data", "chaff-tg", "journal.db"));
  });

  test("falls back to ~/.local/share and ~/.config when the XDG vars are unset", () => {
    const fallback = resolvePaths({ HOME: "/home/tester" });
    expect(fallback.dataDir).toBe("/home/tester/.local/share/chaff-tg");
    expect(fallback.configPath).toBe("/home/tester/.config/chaff-tg/config.json");
  });

  test("ignores a relative root, which XDG requires to be absolute", () => {
    // A relative root would put the session file in the working directory.
    const relative = resolvePaths({
      HOME: "/home/tester",
      XDG_DATA_HOME: "data",
      XDG_CONFIG_HOME: "config",
    });
    expect(relative.dataDir).toBe("/home/tester/.local/share/chaff-tg");
    expect(relative.configPath).toBe("/home/tester/.config/chaff-tg/config.json");
  });

  test("refuses a session name that could escape the data directory", () => {
    expect(() => paths.sessionPath("../../elsewhere")).toThrow();
    expect(() => paths.sessionPath("nested/work")).toThrow();
    expect(() => paths.sessionPath(".")).toThrow();
    expect(() => paths.sessionPath("")).toThrow();
  });
});

describe("the session directory a config file asks for", () => {
  test("uses the XDG-aware default when the config has no opinion", () => {
    // `null` is the config saying "no preference", not a directory called "null".
    expect(resolvePaths(env, null).dataDir).toBe(paths.dataDir);
    expect(resolvePaths(env, undefined).dataDir).toBe(paths.dataDir);
    expect(paths.dataDir).toBe(join(root, "data", "chaff-tg"));
  });

  test("honors an absolute sessionDir", () => {
    const configured = join(root, "elsewhere");
    const resolved = resolvePaths(env, configured);
    expect(resolved.dataDir).toBe(configured);
    expect(resolved.sessionPath("work")).toBe(join(configured, "work.session"));
    expect(resolved.journalPath()).toBe(join(configured, "journal.db"));
    // The config file is not session state, so it stays where XDG put it.
    expect(resolved.configPath).toBe(paths.configPath);
  });

  test("expands a leading ~ to the home directory", () => {
    const home = join(root, "home");
    expect(resolvePaths(env, "~/sessions").dataDir).toBe(join(home, "sessions"));
    expect(resolvePaths(env, "~").dataDir).toBe(home);
  });

  test("refuses a relative sessionDir instead of using the working directory", () => {
    expect(() => resolvePaths(env, "sessions")).toThrow();
  });
});

describe("ensureSecureDir", () => {
  test("creates a missing directory mode 700", async () => {
    await ensureSecureDir(paths.dataDir);
    expect(fileMode(paths.dataDir)).toBe(0o700);
  });

  test("leaves an existing directory exactly as it found it", async () => {
    await mkdir(paths.dataDir, { recursive: true, mode: 0o755 });
    const before = fileMode(paths.dataDir);
    await ensureSecureDir(paths.dataDir);
    expect(fileMode(paths.dataDir)).toBe(before);
  });

  test("is idempotent", async () => {
    await ensureSecureDir(paths.dataDir);
    await expect(ensureSecureDir(paths.dataDir)).resolves.toBeUndefined();
  });
});

describe("ensureSession and sessionExists", () => {
  test("creates the session file mode 600", async () => {
    const path = await ensureSession(paths, "work");
    expect(path).toBe(paths.sessionPath("work"));
    expect(fileMode(path)).toBe(0o600);
    expect(await sessionExists(paths, "work")).toBe(true);
  });

  test("does not re-mode a session file that already exists", async () => {
    // The rule is "created with the mode, never fixed up afterwards": a file the
    // user deliberately widened stays theirs to manage.
    const path = paths.sessionPath("work");
    await ensureSecureDir(paths.dataDir);
    await writeFile(path, "");
    chmodSync(path, 0o640);
    await ensureSession(paths, "work");
    expect(fileMode(path)).toBe(0o640);
  });

  test("sessionExists is false when there is no session file", async () => {
    expect(await sessionExists(paths, "work")).toBe(false);
  });
});

describe("removeSession", () => {
  test("removes the session file and its -wal, -shm and -journal siblings", async () => {
    const path = await ensureSession(paths, "work");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      await writeFile(`${path}${suffix}`, "");
    }
    expect(await removeSession(paths, "work")).toBe(true);
    expect(await readdir(paths.dataDir)).toEqual([]);
    expect(await sessionExists(paths, "work")).toBe(false);
  });

  test("removes a sibling left behind by an interrupted run", async () => {
    const path = paths.sessionPath("work");
    await ensureSecureDir(paths.dataDir);
    await writeFile(`${path}-wal`, "");
    expect(await removeSession(paths, "work")).toBe(true);
    expect(await readdir(paths.dataDir)).toEqual([]);
  });

  test("reports false when there was nothing to remove", async () => {
    expect(await removeSession(paths, "work")).toBe(false);
  });

  test("leaves another session's files alone", async () => {
    const work = await ensureSession(paths, "work");
    const other = await ensureSession(paths, "other");
    await removeSession(paths, "work");
    expect(await sessionExists(paths, "other")).toBe(true);
    expect(fileMode(other)).toBe(0o600);
    expect(fileMode(work)).toBeNull();
  });
});

describe("fileMode", () => {
  test("returns null when there is nothing at the path", () => {
    expect(fileMode(paths.sessionPath("work"))).toBeNull();
  });

  test("reports the permission bits of a directory", async () => {
    await ensureSecureDir(paths.dataDir);
    expect(fileMode(paths.dataDir)).toBe(0o700);
  });
});
