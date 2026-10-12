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
 *   quotes the input it failed on), not from a validation failure (valibot
 *   echoes the value it rejected), and not from a config whose JSON root is a
 *   scalar rather than an object;
 * - credentials come from the environment first, each half independently, and
 *   nothing resolves unless both halves do.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/core/config";
import {
  ConfigError,
  DEFAULT_CONFIG,
  loadConfig,
  resolveCredentials,
  writeConfigCredentials,
} from "../src/core/config";
import { DEFAULT_DELAY_MS } from "../src/core/plan";

/** A value with the shape of a real api hash, used to prove it never leaks. */
const HASH = "0123456789abcdef0123456789abcdef";
/** A letter-leading token: the one syntax error this runtime quotes back. */
const BAREWORD = "abcdef0123456789";
/** A digit-only hash, which valibot echoes as a number. */
const NUMBER_HASH = "1234567890";
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

describe("writeConfigCredentials", () => {
  test("creates the file mode 600, and what it wrote loads back", async () => {
    writeConfigCredentials(configPath, { apiId: 123456, apiHash: HASH });

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      apiId: 123456,
      apiHash: HASH,
    });

    // The point of writing it is that the next command reads it back.
    const loaded = loadConfig(configPath);
    expect(loaded.apiId).toBe(123456);
    expect(loaded.apiHash).toBe(HASH);
    expect(loaded.session).toBe(DEFAULT_CONFIG.session);
  });

  test("keeps the keys a hand-written file already holds", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ session: "work", maxLeave: 7, delayMs: 500, sessionDir: "~/chaff" }),
    );

    writeConfigCredentials(configPath, { apiId: 1, apiHash: HASH });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      session: "work",
      maxLeave: 7,
      delayMs: 500,
      sessionDir: "~/chaff",
      apiId: 1,
      apiHash: HASH,
    });
  });

  test("replaces a file that cannot be parsed", async () => {
    await writeFile(configPath, "{ not json");

    writeConfigCredentials(configPath, { apiId: 2, apiHash: HASH });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ apiId: 2, apiHash: HASH });
  });

  test("the second login replaces the first one's credentials", async () => {
    writeConfigCredentials(configPath, { apiId: 1, apiHash: HASH });
    writeConfigCredentials(configPath, { apiId: 9, apiHash: FILE_HASH });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      apiId: 9,
      apiHash: FILE_HASH,
    });
  });
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
      // `null` is "no preference": the XDG-aware default in `resolvePaths`
      // decides, so plan/cli.md's `~/.local/share/chaff-tg` is not restated here.
      sessionDir: null,
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

  test("rejects a relative sessionDir, which would follow the command's cwd", async () => {
    await writeFile(configPath, '{"sessionDir": "sessions"}');
    const failure = capture(configPath) as ConfigError;
    expect(failure.code).toBe("malformed");
    expect(failure.message).toContain("sessionDir");
  });

  test("rejects a blank sessionDir", async () => {
    await writeFile(configPath, '{"sessionDir": ""}');
    const failure = capture(configPath) as ConfigError;
    expect(failure.code).toBe("malformed");
    expect(failure.message).toContain("sessionDir");
  });

  test("keeps a ~-prefixed sessionDir as written, for the resolver to expand", async () => {
    expect((await load('{"sessionDir": "~/sessions"}')).sessionDir).toBe("~/sessions");
  });

  test("throws ConfigError when the path is a directory, not a file", () => {
    const failure = capture(dir) as ConfigError;
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.code).toBe("unreadable");
    expect(failure.message).toContain(dir);
  });
});

describe("the api hash never reaches a message", () => {
  /**
   * The third column is the fragment a message would quote if the code ever
   * forwarded a validator or parser message verbatim, so a regression that
   * reinstated one fails here rather than shipping green.
   */
  const LEAKY: Array<[string, string, string]> = [
    ["unterminated JSON", `{"apiHash": "${HASH}",`, HASH],
    ["truncated JSON", `{"apiHash": "${HASH}"`, HASH],
    ["a rejected string value", `{"apiId": "${HASH}"}`, HASH],
    ["a sibling key failing", `{"apiHash": "${HASH}", "maxLeave": "many"}`, HASH],
    ["a string in a number's slot", `{"delayMs": "${HASH}"}`, HASH],
    // The one syntax error this runtime quotes back: JSON.parse says
    // `Unexpected identifier "abcdef0123456789"`, so this row fails if the
    // parser's own message is ever forwarded.
    ["a bareword in the hash's slot", `{"apiHash": ${BAREWORD}}`, BAREWORD],
    // The braces deleted while pasting the hash in: the whole file is the value.
    ["a scalar root", `"${HASH}"`, HASH],
    ["a numeric root", NUMBER_HASH, NUMBER_HASH],
  ];

  for (const [name, text, token] of LEAKY) {
    test(`does not leak it from ${name}`, async () => {
      await writeFile(configPath, text);
      const failure = capture(configPath) as ConfigError;
      expect(failure).toBeInstanceOf(ConfigError);
      expect(failure.message).not.toContain(token);
      // Not even a prefix: quoting eight characters is already a leak.
      expect(failure.message).not.toContain(token.slice(0, 8));
      // Nothing forwards the parser's own message either, whatever it said.
      expect(failure.message).not.toContain("JSON Parse error");
      expect(failure.message).not.toContain("Unexpected identifier");
      // The message is still useful: it names the file.
      expect(failure.message).toContain(configPath);
    });
  }

  test("refuses a scalar root with a fixed sentence, never the received value", async () => {
    // Imagining the trigger: someone edits config.json to add the hash and
    // deletes the surrounding braces, so the file is one bare scalar.
    await writeFile(configPath, `"${HASH}"`);
    const failure = capture(configPath) as ConfigError;
    expect(failure.code).toBe("malformed");
    expect(failure.message).toContain("expected a JSON object");
    expect(failure.message).not.toContain(HASH);
  });
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
