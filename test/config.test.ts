/**
 * The optional config file (plan/cli.md, "Config file"; plan/safety.md,
 * "Local privileges and files").
 *
 * Contract under test:
 * - a missing file is not an error: the documented defaults come back;
 * - a partial file fills the rest from those defaults, and unknown keys are
 *   ignored rather than rejected, like the manifest;
 * - malformed JSON and a value of the wrong type both throw `ConfigError`
 *   naming the path, with the reason in `code`;
 * - the api hash never reaches a message: not from malformed JSON (the parser
 *   quotes the input it failed on) and not from a validation failure (valibot
 *   echoes the value it rejected);
 * - credentials come from the environment first, each half independently, and
 *   nothing resolves unless both halves do.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/core/config";
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveCredentials } from "../src/core/config";
import { DEFAULT_DELAY_MS } from "../src/core/plan";

/** A value with the shape of a real api hash, used to prove it never leaks. */
const HASH = "0123456789abcdef0123456789abcdef";
/** The hash the config file carries in the precedence tests. */
const FILE_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The file-backed credentials the precedence tests start from. */
const FILE: Config = { ...DEFAULT_CONFIG, apiId: 111, apiHash: FILE_HASH };

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chaff-config-"));
  configPath = join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run `loadConfig` and hand back what it threw, so a test can read `.code`. */
function capture(config: string): unknown {
  try {
    loadConfig(config);
  } catch (error) {
    return error;
  }
  throw new Error("expected loadConfig to throw");
}

/** Write a config file and read it back, the way the CLI will. */
async function load(text: string): Promise<Config> {
  await writeFile(configPath, text);
  return loadConfig(configPath);
}

describe("loadConfig", () => {
  test("returns the documented defaults when the file is missing", () => {
    expect(loadConfig(join(dir, "absent.json"))).toEqual(DEFAULT_CONFIG);
  });

  test("pins the documented default values", () => {
    expect(DEFAULT_CONFIG).toEqual({
      apiId: null,
      apiHash: null,
      session: "default",
      maxLeave: 50,
      delayMs: DEFAULT_DELAY_MS,
      sessionDir: "~/.local/share/chaff-tg",
    });
  });

  test("reads every documented key", async () => {
    const cfg = await load(
      JSON.stringify({
        apiId: 123456,
        apiHash: HASH,
        session: "work",
        maxLeave: 10,
        delayMs: 500,
        sessionDir: "/tmp/sessions",
      }),
    );
    expect(cfg).toEqual({
      apiId: 123456,
      apiHash: HASH,
      session: "work",
      maxLeave: 10,
      delayMs: 500,
      sessionDir: "/tmp/sessions",
    });
  });

  test("fills the keys a partial file leaves out", async () => {
    expect(await load('{"maxLeave": 5}')).toEqual({ ...DEFAULT_CONFIG, maxLeave: 5 });
  });

  test("ignores unknown keys instead of rejecting the file", async () => {
    const cfg = await load('{"futureFlag": true, "delayMs": 900}');
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, delayMs: 900 });
    expect(Object.keys(cfg).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
  });

  test("returns a fresh object every time, so a caller cannot edit the defaults", async () => {
    const first = await load('{"session": "work"}');
    first.session = "mutated";
    expect(DEFAULT_CONFIG.session).toBe("default");
    expect((await load('{"session": "work"}')).session).toBe("work");
  });

  test("throws ConfigError naming the path for malformed JSON", async () => {
    await writeFile(configPath, '{"apiId": 123');
    const failure = capture(configPath) as ConfigError;
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.code).toBe("not-json");
    expect(failure.message).toContain(configPath);
  });

  test("throws ConfigError naming the offending key for a wrong type", async () => {
    await writeFile(configPath, '{"maxLeave": "many"}');
    const failure = capture(configPath) as ConfigError;
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.code).toBe("malformed");
    expect(failure.message).toContain(configPath);
    expect(failure.message).toContain("maxLeave");
  });

  test("rejects a session name that could escape the data directory", async () => {
    await writeFile(configPath, '{"session": "../escape"}');
    const failure = capture(configPath) as ConfigError;
    expect(failure.code).toBe("malformed");
  });

  test("throws ConfigError when the path is a directory, not a file", () => {
    const failure = capture(dir) as ConfigError;
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.code).toBe("unreadable");
    expect(failure.message).toContain(dir);
  });
});

describe("the api hash never reaches a message", () => {
  const LEAKY: Array<[string, string]> = [
    ["unterminated JSON", `{"apiHash": "${HASH}",`],
    ["truncated JSON", `{"apiHash": "${HASH}"`],
    ["a rejected string value", `{"apiId": "${HASH}"}`],
    ["a sibling key failing", `{"apiHash": "${HASH}", "maxLeave": "many"}`],
    ["a string in a number's slot", `{"delayMs": "${HASH}"}`],
  ];

  for (const [name, text] of LEAKY) {
    test(`does not leak it from ${name}`, async () => {
      await writeFile(configPath, text);
      const failure = capture(configPath) as ConfigError;
      expect(failure).toBeInstanceOf(ConfigError);
      expect(failure.message).not.toContain(HASH);
      // Not even a prefix: quoting eight characters is already a leak.
      expect(failure.message).not.toContain(HASH.slice(0, 8));
      // The message is still useful: it names the file.
      expect(failure.message).toContain(configPath);
    });
  }
});

describe("resolveCredentials", () => {
  test("returns nothing when neither half is anywhere", () => {
    expect(resolveCredentials(DEFAULT_CONFIG, {})).toBeNull();
  });

  test("reads both halves from the file when the environment is empty", () => {
    expect(resolveCredentials(FILE, {})).toEqual({ apiId: 111, apiHash: FILE_HASH });
  });

  test("lets the environment beat the file", () => {
    expect(resolveCredentials(FILE, { CHAFF_API_ID: "222", CHAFF_API_HASH: HASH })).toEqual({
      apiId: 222,
      apiHash: HASH,
    });
  });

  test("resolves each half independently", () => {
    expect(resolveCredentials(FILE, { CHAFF_API_HASH: HASH })).toEqual({
      apiId: 111,
      apiHash: HASH,
    });
    expect(resolveCredentials(FILE, { CHAFF_API_ID: "222" })).toEqual({
      apiId: 222,
      apiHash: FILE_HASH,
    });
  });

  test("returns null when either half is missing", () => {
    expect(resolveCredentials({ ...FILE, apiHash: null }, {})).toBeNull();
    expect(resolveCredentials({ ...FILE, apiId: null }, {})).toBeNull();
    expect(resolveCredentials(DEFAULT_CONFIG, { CHAFF_API_ID: "222" })).toBeNull();
    expect(resolveCredentials(DEFAULT_CONFIG, { CHAFF_API_HASH: HASH })).toBeNull();
  });

  test("treats a blank environment value as unset, so the file still applies", () => {
    expect(resolveCredentials(FILE, { CHAFF_API_ID: "  ", CHAFF_API_HASH: "" })).toEqual({
      apiId: 111,
      apiHash: FILE_HASH,
    });
  });

  test("treats an unusable environment value as unresolved, never as the file's", () => {
    // The user meant the env var to win; quietly authenticating as a different
    // app id would be worse than refusing and making them fix it.
    expect(resolveCredentials(FILE, { CHAFF_API_ID: "not-a-number" })).toBeNull();
    expect(resolveCredentials(FILE, { CHAFF_API_ID: "0" })).toBeNull();
    expect(resolveCredentials(FILE, { CHAFF_API_ID: "1.5" })).toBeNull();
  });

  test("trims a pasted environment value", () => {
    expect(
      resolveCredentials(FILE, { CHAFF_API_ID: " 222 ", CHAFF_API_HASH: ` ${HASH}\n` }),
    ).toEqual({ apiId: 222, apiHash: HASH });
  });

  test("never throws, whatever the environment holds", () => {
    const junk = { CHAFF_API_ID: HASH, CHAFF_API_HASH: HASH };
    expect(() => resolveCredentials(DEFAULT_CONFIG, junk)).not.toThrow();
    expect(resolveCredentials(DEFAULT_CONFIG, junk)).toBeNull();
  });
});
