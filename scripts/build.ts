#!/usr/bin/env bun
/**
 * `bun scripts/build.ts` — the release binaries, one per target.
 *
 * Uses the `Bun.build` API rather than `bun build --compile` for two reasons
 * (plan/distribution.md, "Build script"): the CLI form ignores `bunfig.toml`,
 * and the API form takes the build constants and assets explicitly.
 *
 * No subagents, no magic: one loop over the target list, `compile.outfile`
 * (never `--outdir`, which `--compile` refuses), and a summary table so a
 * failed target is visible in the log rather than only in an exit code.
 *
 *   bun scripts/build.ts                              # all eight, the release matrix
 *   bun scripts/build.ts --target bun-linux-x64       # one target, e.g. the host
 *   bun scripts/build.ts --outdir /tmp/chaff-out      # somewhere else
 *   bun scripts/build.ts --version 0.2.0              # what the release workflow passes
 *
 * The version comes from `package.json`, unless `--version` says otherwise. The release
 * workflow passes the tag, because the tag is the release's own statement of what it is:
 * a binary built from `v0.3.0` must report `0.3.0`, whatever `package.json` happens to
 * say at that moment (plan/distribution.md, "Versioning"). `src/core/index.ts` carries
 * the same number for the CLI run from source, and `test/smoke.test.ts` fails when the
 * two disagree.
 *
 * The other seven targets are exercised in CI, not by hand: each cross target
 * makes Bun download that platform's runtime (tens of MB each), so a local
 * release build is the slow, metered path. `--target` is how the smoke test and
 * a local spot-check stay cheap.
 */
// `node:fs` for `mkdirSync` on purpose: Bun has no directory API of its own, and
// its file I/O docs point at `node:fs` for mkdir and readdir.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** The repo root, so the script runs from anywhere. */
const ROOT = resolve(import.meta.dir, "..");

/**
 * The eight targets (plan/distribution.md, "Targets"). Bun cross-compiles all
 * of them, and they line up with the platforms a native library would have to
 * ship for, which matters again when the TUI lands.
 */
const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
] as const;

type Target = (typeof TARGETS)[number];

/** What the parser read off the command line. */
interface Options {
  targets: Target[];
  outdir: string;
  /** `--version`: the version to stamp, already normalized. `null` means "read package.json". */
  version: string | null;
  help: boolean;
}

const USAGE = `Usage: bun scripts/build.ts [options]

Options:
  --target <name>   Build one target (repeatable). Default: all eight.
  --outdir <dir>    Where the binaries go. Default: dist
  --version <v>     Version to stamp. Default: the one in package.json.
  --list            Print the target names and exit.
  -h, --help        Show this help.

Targets: ${TARGETS.join(", ")}
`;

/**
 * `v1.2.3` and `1.2.3` both mean `1.2.3`; anything else is a usage error.
 *
 * The tag is allowed to arrive with its `v` because that is how the workflow has it, and
 * silently stamping `v0.2.0` into a binary that prints `chaff v0.2.0` would look like a
 * second spelling of the same version. A malformed value is refused rather than stamped:
 * the number is printed in bug reports, so a typo here outlives the release.
 */
function normalizeVersion(value: string): string {
  const trimmed = value.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new UsageError(`${JSON.stringify(value)} is not a version such as 1.2.3 or v1.2.3`);
  }
  return trimmed;
}

/** A usage error: the message is the whole diagnosis, and the exit code is 2. */
class UsageError extends Error {}

/** Parse the command line. Unknown flags and targets are usage errors (exit 2). */
function parseArgs(argv: readonly string[]): Options {
  const options: Options = { targets: [], outdir: "dist", version: null, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--list":
        console.log(TARGETS.join("\n"));
        process.exit(0);
        break;
      case "--target": {
        const value = argv[++i];
        if (value === undefined) throw new UsageError("--target needs a target name");
        if (!isTarget(value)) {
          throw new UsageError(`unknown target ${JSON.stringify(value)}; see --list`);
        }
        options.targets.push(value);
        break;
      }
      case "--outdir": {
        const value = argv[++i];
        if (value === undefined) throw new UsageError("--outdir needs a directory");
        options.outdir = value;
        break;
      }
      case "--version": {
        const value = argv[++i];
        if (value === undefined) throw new UsageError("--version needs a version such as 1.2.3");
        options.version = normalizeVersion(value);
        break;
      }
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(arg ?? "")}`);
    }
  }

  return options;
}

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

/**
 * The version stamped into the binary.
 *
 * `--version` wins, because at release time the tag is the authority and `package.json` is
 * only a file someone may have forgotten to bump. With no flag, `package.json` decides, so
 * a local build still reports something a person can recognise.
 */
async function resolveVersion(explicit: string | null): Promise<string> {
  if (explicit !== null) return explicit;
  const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { version?: unknown };
  return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
}

/**
 * The commit stamped into the binary: `CHAFF_COMMIT` when CI passes it (that is
 * the only honest answer in a checkout CI shallow-clones), otherwise `git`, and
 * `unknown` when neither is available. Short, because it is printed, not used.
 */
function readCommit(): string {
  const fromEnv = process.env.CHAFF_COMMIT?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv.slice(0, 12);

  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  if (git.exitCode === 0) return git.stdout.toString().trim().slice(0, 12);
  return "unknown";
}

/** A byte count a person can read at a glance. */
function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One finished artifact. */
interface Built {
  target: Target;
  path: string;
  bytes: number;
}

/**
 * Build one target. The artifact's real path comes back from the build result
 * rather than being assumed: Bun appends `.exe` for Windows targets, and a
 * guessed name is how a release ends up with a checksums file that names a file
 * nobody uploaded.
 */
async function buildTarget(
  target: Target,
  outdir: string,
  version: string,
  commit: string,
): Promise<Built> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/cli/index.ts")],
    compile: { target, outfile: join(outdir, `chaff-${target}`) },
    minify: true,
    define: {
      CHAFF_VERSION: JSON.stringify(version),
      CHAFF_COMMIT: JSON.stringify(commit),
      // Read by OpenTUI through `bun:ffi` to pick one native package per libc.
      // Nothing imports OpenTUI yet, so this define is inert today; it is here
      // because it must be defined at build time and forgetting it later makes
      // a Linux build want both libc branches (plan/distribution.md).
      "process.env.OPENTUI_LIBC": JSON.stringify(target.includes("musl") ? "musl" : "glibc"),
    },
  });

  if (!result.success) {
    throw new Error(`build failed for ${target}:\n${result.logs.map(String).join("\n")}`);
  }

  const output = result.outputs[0];
  if (output === undefined) throw new Error(`build for ${target} produced no artifact`);

  // `Bun.file().size` is a synchronous property, so no extra call is needed to
  // report the artefact's size.
  return { target, path: output.path, bytes: Bun.file(output.path).size };
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const targets: readonly Target[] = options.targets.length > 0 ? options.targets : TARGETS;
  const outdir = resolve(ROOT, options.outdir);
  const version = await resolveVersion(options.version);
  const commit = readCommit();

  mkdirSync(outdir, { recursive: true });
  // Name the source: "version 0.2.0" alone leaves a reader guessing whether the
  // release workflow stamped the tag or nobody bumped package.json.
  console.log(
    `chaff-tg build: version ${version} from ` +
      `${options.version === null ? "package.json" : "--version"}, ` +
      `commit ${commit}, ${targets.length} target(s)`,
  );

  const built: Built[] = [];
  const failed: Target[] = [];

  for (const target of targets) {
    try {
      const artifact = await buildTarget(target, outdir, version, commit);
      built.push(artifact);
      console.log(`  ok    ${target}  ${megabytes(artifact.bytes)}`);
    } catch (error) {
      failed.push(target);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAIL  ${target}\n${message}`);
    }
  }

  const total = built.reduce((sum, artifact) => sum + artifact.bytes, 0);
  console.log(
    `\n${built.length} of ${targets.length} built into ${options.outdir}` +
      (built.length > 0 ? `, ${megabytes(total)} total` : ""),
  );

  for (const artifact of built) console.log(`  ${artifact.path}`);

  if (failed.length > 0) {
    console.error(`\nfailed targets: ${failed.join(", ")}`);
    process.exit(1);
  }
}

await main();
