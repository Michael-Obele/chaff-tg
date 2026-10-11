/**
 * `chaff whoami` and `chaff doctor` end to end, through `runCli`
 * (`plan/implementation-plan.md`, Task 11; `plan/safety.md`, "Local privileges
 * and files"). Everything runs against a temporary XDG root, so the suite never
 * reads or writes the real `~/.local/share/chaff-tg`, and the api hash is
 * planted in both the environment and a config file to prove it never reaches
 * any output.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/core/errors";
import { runCli, type CliContext } from "../src/cli/index";

/** The Task 2 fixtures, which `CHAFF_FIXTURE` points the fake client at. */
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A hash-shaped string, distinct enough that a leak cannot hide in a match. */
const API_HASH = "0123456789abcdef0123456789abcdef";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "chaff-doctor-"));
  roots.push(dir);
  return dir;
}

interface Sandbox {
  root: string;
  dataDir: string;
  configPath: string;
  sessionPath: string;
  env: Record<string, string | undefined>;
}

/** An environment pointed at a temporary root, so no real path is ever read. */
function sandbox(extra: Record<string, string | undefined> = {}): Sandbox {
  const root = tempRoot();
  const dataDir = join(root, "data", "chaff-tg");
  return {
    root,
    dataDir,
    configPath: join(root, "config", "chaff-tg", "config.json"),
    sessionPath: join(dataDir, "default.session"),
    env: {
      HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      ...extra,
    },
  };
}

/** A sandbox with a session file, created with `mode`. */
function withSession(mode: number, extra: Record<string, string | undefined> = {}): Sandbox {
  const box = sandbox(extra);
  mkdirSync(box.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(box.sessionPath, "", { mode });
  return box;
}

interface Sink {
  write(s: string): unknown;
  text(): string;
}

function sink(): Sink {
  const parts: string[] = [];
  return {
    write(chunk: string) {
      parts.push(chunk);
      return true;
    },
    text() {
      return parts.join("");
    },
  };
}

interface Run {
  code: number;
  stdout: Sink;
  stderr: Sink;
}

async function run(argv: string[], env: Record<string, string | undefined>): Promise<Run> {
  const stdout = sink();
  const stderr = sink();
  const ctx: CliContext = {
    argv,
    env,
    stdout,
    stderr,
    now: () => new Date("2026-10-12T00:00:00Z"),
    isTTY: false,
  };
  return { code: await runCli(ctx), stdout, stderr };
}

describe("chaff doctor", () => {
  test("reports the resolved paths under the injected root and exits 0", async () => {
    const box = sandbox();
    const { code, stdout, stderr } = await run(["doctor"], box.env);

    expect(code).toBe(EXIT.OK);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain(box.dataDir);
    expect(stdout.text()).toContain(box.configPath);
    expect(stdout.text()).toContain(box.sessionPath);
    expect(stdout.text()).toContain("(missing)");
  });

  test("creates and repairs nothing: the filesystem is untouched", async () => {
    const box = sandbox();
    await run(["doctor"], box.env);
    // The sandbox root was empty before, so it must still be empty: "doctor
    // reports, it does not repair".
    expect(readdirSync(box.root)).toEqual([]);
  });

  test("reports the modes it found and warns when one is looser than required", async () => {
    const box = withSession(0o644);
    const { stdout } = await run(["doctor", "--json"], box.env);
    const document = JSON.parse(stdout.text()) as {
      modes: Record<string, string | null>;
      warnings: string[];
    };

    expect(document.modes["dataDir"]).toBe("700");
    expect(document.modes["session"]).toBe("644");
    expect(document.warnings).toEqual(["session file mode 644 is looser than the required 600"]);
  });

  test("a mode that is tight enough produces no warning", async () => {
    const box = withSession(0o600);
    const { stdout } = await run(["doctor"], box.env);
    expect(stdout.text()).not.toContain("warning");
    expect(stdout.text()).toContain("600");
  });

  test("says whether the session directory sits inside a git repository", async () => {
    const inside = sandbox();
    mkdirSync(join(inside.root, ".git"), { recursive: true });
    const inRepo = await run(["doctor", "--json"], inside.env);
    expect(
      (JSON.parse(inRepo.stdout.text()) as { gitRepository: { inside: boolean } }).gitRepository
        .inside,
    ).toBe(true);

    const outside = sandbox();
    const noRepo = await run(["doctor", "--json"], outside.env);
    expect(
      (JSON.parse(noRepo.stdout.text()) as { gitRepository: { inside: boolean } }).gitRepository
        .inside,
    ).toBe(false);
  });

  test("reports which config values are present, never a secret value", async () => {
    const box = sandbox({ CHAFF_API_HASH: API_HASH });
    mkdirSync(join(box.root, "config", "chaff-tg"), { recursive: true });
    writeFileSync(box.configPath, JSON.stringify({ apiId: 123456, session: "work" }));

    const { code, stdout, stderr } = await run(["doctor", "--json"], box.env);
    const document = JSON.parse(stdout.text()) as {
      config: Record<string, unknown>;
      environment: Record<string, string>;
    };

    expect(code).toBe(EXIT.OK);
    expect(document.config["apiId"]).toBe("present");
    expect(document.config["apiHash"]).toBe("absent");
    expect(document.environment["CHAFF_API_HASH"]).toBe("set");
    expect(document.config["session"]).toBe("work");
    expect(stdout.text()).not.toContain(API_HASH);
    expect(stderr.text()).not.toContain(API_HASH);
  });

  test("a hash in the config file is never printed, only reported as present", async () => {
    const box = sandbox();
    mkdirSync(join(box.root, "config", "chaff-tg"), { recursive: true });
    writeFileSync(box.configPath, JSON.stringify({ apiId: 123456, apiHash: API_HASH }));

    const { stdout, stderr } = await run(["doctor"], box.env);
    expect(stdout.text()).toContain("present");
    expect(stdout.text()).not.toContain(API_HASH);
    expect(stderr.text()).not.toContain(API_HASH);
  });

  test("a config file that cannot be used is reported, not thrown", async () => {
    const box = sandbox();
    mkdirSync(join(box.root, "config", "chaff-tg"), { recursive: true });
    writeFileSync(box.configPath, "{ this is not json");

    const { code, stdout, stderr } = await run(["doctor"], box.env);
    expect(code).toBe(EXIT.OK);
    expect(stdout.text()).toContain("not valid JSON");
    expect(stderr.text()).toBe("");
  });

  test("runs with no session at all: being logged out is a fact to report", async () => {
    const box = sandbox();
    const { code, stdout } = await run(["doctor"], box.env);
    expect(code).toBe(EXIT.OK);
    expect(stdout.text()).toContain("session");
  });
});

describe("chaff whoami", () => {
  test("prints the account and the resolved session path", async () => {
    const box = sandbox({ CHAFF_FAKE: "1", CHAFF_FIXTURE: FIXTURES });
    const { code, stdout, stderr } = await run(["whoami"], box.env);

    expect(code).toBe(EXIT.OK);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("chaff_tester");
    expect(stdout.text()).toContain(box.sessionPath);
  });

  test("--json prints the account id, username and session path", async () => {
    const box = sandbox({ CHAFF_FAKE: "1", CHAFF_FIXTURE: FIXTURES });
    const { stdout } = await run(["whoami", "--json"], box.env);

    expect(JSON.parse(stdout.text())).toEqual({
      id: 1,
      username: "chaff_tester",
      session: box.sessionPath,
    });
  });

  test("no session and no fake is a plain sentence and exit 3", async () => {
    const box = sandbox();
    const { code, stdout, stderr } = await run(["whoami"], box.env);

    expect(code).toBe(EXIT.NOT_LOGGED_IN);
    expect(stdout.text()).toBe("");
    expect(stderr.text().split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("the api hash never reaches stdout or stderr", async () => {
    // The logged-out path (the credentials are configured, the session is not
    // there) and the fake path: the only two ways to run this command offline.
    const box = sandbox({ CHAFF_API_ID: "12345", CHAFF_API_HASH: API_HASH });
    const failed = await run(["whoami"], box.env);
    const fake = await run(
      ["whoami", "--json"],
      sandbox({ CHAFF_FAKE: "1", CHAFF_API_HASH: API_HASH }).env,
    );

    expect(failed.code).toBe(EXIT.NOT_LOGGED_IN);
    expect(fake.code).toBe(EXIT.OK);
    expect(fake.stdout.text()).toContain("chaff_tester");

    for (const result of [failed, fake]) {
      expect(result.stdout.text()).not.toContain(API_HASH);
      expect(result.stderr.text()).not.toContain(API_HASH);
    }
  });
});
