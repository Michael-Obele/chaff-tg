/**
 * The shared CLI test harness: a sandboxed environment, an in-memory sink, and
 * one `runCli` call that captures every byte.
 *
 * This is the single home for the helpers `commands-list.test.ts` and
 * `commands-doctor.test.ts` each grew their own copy of (counted as debt in
 * plan/notes.md, "Duplicate test harness"). New tests use this module; the two
 * older files can adopt it without changing a single assertion.
 *
 * Nothing here touches the network: `fakeEnv` sets `CHAFF_FAKE`, which makes
 * `openClient` return the fixture client before it reads any config, session or
 * credential, and every path is redirected into a throwaway root.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliContext } from "../src/cli/index";

/** The Task 2 fixtures, which `CHAFF_FIXTURE` points the fake client at. */
export const FIXTURES = join(import.meta.dir, "fixtures");

/** The clock every run sees, so nothing in a test depends on the real time. */
const NOW = new Date("2026-10-12T00:00:00Z");

/** An in-memory sink: whatever `runCli` writes, and nothing else. */
export interface Sink {
  write(s: string): unknown;
  text(): string;
}

/** One captured run. */
export interface Run {
  code: number;
  stdout: Sink;
  stderr: Sink;
}

/** A sink that keeps every chunk it was written. */
export function sink(): Sink {
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

/**
 * An environment pointed at a throwaway root, using the shipped fake client.
 *
 * The caller owns `root` and should remove it (the check test does it from
 * `afterEach`), which keeps this module free of shared mutable state.
 */
export function fakeEnv(extra: Record<string, string | undefined> = {}): {
  root: string;
  env: Record<string, string | undefined>;
} {
  const root = mkdtempSync(join(tmpdir(), "chaff-test-"));
  return {
    root,
    env: {
      HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      CHAFF_FAKE: "1",
      CHAFF_FIXTURE: FIXTURES,
      ...extra,
    },
  };
}

/** Run one command line through the real front end, capturing every byte. */
export async function run(argv: string[], env: Record<string, string | undefined>): Promise<Run> {
  const stdout = sink();
  const stderr = sink();
  const ctx: CliContext = { argv, env, stdout, stderr, now: () => NOW, isTTY: false };
  return { code: await runCli(ctx), stdout, stderr };
}
