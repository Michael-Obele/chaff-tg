import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/core/errors";
import { DEFAULT_CONFIG } from "../src/core/index";
import type { Filters } from "../src/core/types";
import { parseArgs, UsageError, type ParsedArgs } from "../src/cli/args";
import {
  CLI_COMMIT,
  CLI_VERSION,
  COMMANDS,
  promptable,
  runCli,
  versionLine,
  type CliContext,
  type Command,
  type CommandContext,
} from "../src/cli/index";
import type { Table } from "../src/cli/render/columns";
import { renderJson } from "../src/cli/render/json";
import { renderTable } from "../src/cli/render/table";

//
// One row per flag in plan/cli.md, "Filters" -- the canonical flag names. A
// row's argv uses the long form; the rows whose flag cli.md documents with a
// short alias are repeated with the short spelling, so both forms are pinned.
//
const FILTER_ROWS: ReadonlyArray<{ flag: string; argv: string[]; want: Partial<Filters> }> = [
  {
    flag: "--type",
    argv: ["--type", "channel,supergroup"],
    want: { types: ["channel", "supergroup"] },
  },
  // `group` is the family: a legacy basic group, a supergroup and a broadcast
  // group are all "Groups" in Telegram's own clients, and the legacy kind alone
  // matches nothing on a live account (mtcute guide, "Peers").
  {
    flag: "--type group",
    argv: ["--type", "group"],
    want: { types: ["group", "supergroup", "gigagroup"] },
  },
  {
    flag: "--type group,group",
    argv: ["--type", "group,group"],
    want: { types: ["group", "supergroup", "gigagroup"] },
  },
  {
    flag: "--type group,channel",
    argv: ["--type", "group,channel"],
    want: { types: ["group", "supergroup", "gigagroup", "channel"] },
  },
  { flag: "-k/--keyword", argv: ["-k", "signal,vip"], want: { keyword: ["signal", "vip"] } },
  { flag: "--keyword", argv: ["--keyword", " Signal , "], want: { keyword: ["Signal"] } },
  { flag: "-K/--any", argv: ["-K", "vip,airdrop"], want: { any: ["vip", "airdrop"] } },
  { flag: "--any", argv: ["--any", "vip"], want: { any: ["vip"] } },
  { flag: "--not", argv: ["--not", "airdrop"], want: { not: ["airdrop"] } },
  { flag: "-r/--regex", argv: ["-r", "^Rust"], want: { regex: "^Rust" } },
  { flag: "--regex", argv: ["--regex", "^Rust"], want: { regex: "^Rust" } },
  { flag: "--id", argv: ["--id", "-1001,-1002"], want: { ids: [-1001, -1002] } },
  { flag: "--muted", argv: ["--muted"], want: { muted: true } },
  { flag: "--not-muted", argv: ["--not-muted"], want: { muted: false } },
  { flag: "--archived", argv: ["--archived"], want: { archived: true } },
  { flag: "--no-archived", argv: ["--no-archived"], want: { archived: false } },
  { flag: "--inactive-days", argv: ["--inactive-days", "365"], want: { inactiveDays: 365 } },
  { flag: "--members", argv: ["--members", "0-50"], want: { members: { min: 0, max: 50 } } },
  { flag: "--scam", argv: ["--scam"], want: { scam: true } },
  { flag: "--fake", argv: ["--fake"], want: { fake: true } },
  { flag: "--unread", argv: ["--unread"], want: { unread: true } },
  { flag: "--read", argv: ["--read"], want: { unread: false } },
  { flag: "--pinned", argv: ["--pinned"], want: { pinned: true } },
  { flag: "--no-pinned", argv: ["--no-pinned"], want: { pinned: false } },
  { flag: "--include", argv: ["--include", "-1,-2"], want: { include: [-1, -2] } },
  { flag: "--exclude", argv: ["--exclude", "-3"], want: { exclude: [-3] } },
  { flag: "--limit", argv: ["--limit", "25"], want: { limit: 25 } },
];

/** Every filter starts at the value the filter engine treats as "unset". */
const UNSET_FILTERS: Filters = {
  types: null,
  keyword: [],
  any: [],
  not: [],
  regex: null,
  ids: null,
  muted: null,
  archived: null,
  inactiveDays: null,
  members: null,
  scam: false,
  fake: false,
  unread: null,
  pinned: null,
  include: [],
  exclude: [],
  limit: null,
};

describe("parseArgs: filters", () => {
  for (const row of FILTER_ROWS) {
    test(`${row.flag} lands in filters`, () => {
      expect(parseArgs(row.argv).filters).toEqual({ ...UNSET_FILTERS, ...row.want });
    });
  }

  test("no flags leaves every filter unset", () => {
    const args = parseArgs([]);
    expect(args.command).toBeNull();
    expect(args.filters).toEqual(UNSET_FILTERS);
    expect(args.provided.size).toBe(0);
  });
});

describe("parseArgs: selection and pacing", () => {
  const ROWS: ReadonlyArray<{
    flag: string;
    argv: string[];
    want: Partial<ParsedArgs["selection"]>;
  }> = [
    { flag: "--max-leave", argv: ["--max-leave", "10"], want: { maxLeave: 10 } },
    { flag: "--max-leave 0", argv: ["--max-leave", "0"], want: { maxLeave: 0 } },
    { flag: "--delay", argv: ["--delay", "500"], want: { delayMs: 500 } },
    { flag: "--clear", argv: ["--clear"], want: { clear: true } },
    { flag: "--yes", argv: ["--yes"], want: { yes: true } },
    { flag: "--force", argv: ["--force"], want: { force: true } },
    {
      flag: "--from",
      argv: ["--from", "plans/cleanup.json"],
      want: { from: "plans/cleanup.json" },
    },
    {
      flag: "--select",
      argv: ["--select", "-1001234567890,-1009876543210", "--yes"],
      want: { select: [-1001234567890, -1009876543210] },
    },
  ];

  for (const row of ROWS) {
    test(`${row.flag} lands in selection`, () => {
      expect(parseArgs(row.argv).selection).toMatchObject(row.want);
    });
  }

  test("defaults are the documented ones: maxLeave 50, delayMs 1200", () => {
    const { selection } = parseArgs([]);
    expect(selection.maxLeave).toBe(50);
    expect(selection.delayMs).toBe(1200);
    expect(selection.maxLeave).toBe(DEFAULT_CONFIG.maxLeave);
    expect(selection.delayMs).toBe(DEFAULT_CONFIG.delayMs);
  });

  test("--dry-run is a rehearsal: provided and selection.yes both stay false", () => {
    const args = parseArgs(["--dry-run"]);
    expect(args.flags.dryRun).toBe(true);
    expect(args.selection.yes).toBe(false);
    expect(args.provided.has("yes")).toBe(false);
    expect([...args.provided]).toEqual(["dry-run"]);
  });

  test("--yes alone is a live run: provided and selection.yes are both true", () => {
    const args = parseArgs(["--yes"]);
    expect(args.selection.yes).toBe(true);
    expect(args.provided.has("yes")).toBe(true);
    expect(args.flags.dryRun).toBe(false);
  });

  test("--yes with --dry-run is contradictory, so it is a usage error", () => {
    const error = captureError(() => parseArgs(["--yes", "--dry-run"]));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(EXIT.USAGE);
    expect((error as UsageError).message).toContain("--dry-run");
  });
});

describe("parseArgs: output", () => {
  const ROWS: ReadonlyArray<{ flag: string; argv: string[]; want: Partial<ParsedArgs["flags"]> }> =
    [
      { flag: "--json", argv: ["--json"], want: { json: true } },
      { flag: "--csv", argv: ["--csv"], want: { csv: true } },
      { flag: "--md", argv: ["--md"], want: { md: true } },
      { flag: "--out", argv: ["--out", "cleanup.md"], want: { out: "cleanup.md" } },
      { flag: "--quiet", argv: ["--quiet"], want: { quiet: true } },
      { flag: "-v/--verbose", argv: ["-v"], want: { verbose: true } },
      { flag: "--verbose", argv: ["--verbose"], want: { verbose: true } },
      { flag: "-h/--help", argv: ["-h"], want: { help: true } },
      { flag: "--help", argv: ["--help"], want: { help: true } },
      { flag: "-V/--version", argv: ["-V"], want: { version: true } },
      { flag: "--version", argv: ["--version"], want: { version: true } },
    ];

  for (const row of ROWS) {
    test(`${row.flag} lands in flags`, () => {
      expect(parseArgs(row.argv).flags).toMatchObject(row.want);
    });
  }
});

describe("parseArgs: command and value shapes", () => {
  test("the first bare word is the command; flags may precede it", () => {
    expect(parseArgs(["list", "--json"]).command).toBe("list");
    expect(parseArgs(["--json", "list"]).command).toBe("list");
    expect(parseArgs([]).command).toBeNull();
  });

  test("a second bare word is a usage error", () => {
    expect(() => parseArgs(["list", "extra"])).toThrow(UsageError);
  });

  test("--flag=value is accepted", () => {
    expect(parseArgs(["--out=cleanup.md"]).flags.out).toBe("cleanup.md");
    expect(parseArgs(["--keyword=signal,vip"]).filters.keyword).toEqual(["signal", "vip"]);
  });

  test("a value may start with a dash: --select takes negative chat ids", () => {
    const args = parseArgs(["--select", "-1001234567890,-1009876543210", "--yes"]);
    expect(args.selection.select).toEqual([-1001234567890, -1009876543210]);
    expect(parseArgs(["--id", "-1001"]).filters.ids).toEqual([-1001]);
  });

  test("--members parses a range, and only a range", () => {
    expect(parseArgs(["--members", "0-50"]).filters.members).toEqual({ min: 0, max: 50 });
    expect(() => parseArgs(["--members", "50-0"])).toThrow(UsageError);
    expect(() => parseArgs(["--members", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["--members", "50"])).toThrow(UsageError);
  });

  test("--provided records which flags were given, in canonical long spelling", () => {
    const args = parseArgs(["-k", "signal", "--max-leave", "10", "list"]);
    expect([...args.provided].sort()).toEqual(["keyword", "max-leave"]);
  });
});

describe("parseArgs: conflicts and bad usage exit 2", () => {
  const CONFLICTS: ReadonlyArray<{ name: string; argv: string[] }> = [
    { name: "--muted with --not-muted", argv: ["--muted", "--not-muted"] },
    { name: "--archived with --no-archived", argv: ["--archived", "--no-archived"] },
    { name: "--unread with --read", argv: ["--unread", "--read"] },
    { name: "--pinned with --no-pinned", argv: ["--pinned", "--no-pinned"] },
    { name: "--quiet with --verbose", argv: ["--quiet", "-v"] },
    { name: "--json with --csv", argv: ["--json", "--csv"] },
    { name: "--csv with --md", argv: ["--csv", "--md"] },
    { name: "--json with --md", argv: ["--json", "--md"] },
    { name: "--yes with --dry-run", argv: ["--yes", "--dry-run"] },
    { name: "--select without --yes", argv: ["--select", "-1"] },
  ];

  for (const row of CONFLICTS) {
    test(`${row.name} is a usage error`, () => {
      const error = captureError(() => parseArgs(row.argv));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).exitCode).toBe(EXIT.USAGE);
    });
  }

  const BAD_USAGE: ReadonlyArray<{ name: string; argv: string[] }> = [
    { name: "an unknown flag", argv: ["--nope"] },
    { name: "an unknown short flag", argv: ["-z"] },
    { name: "a missing value", argv: ["--out"] },
    { name: "a non-numeric number", argv: ["--limit", "abc"] },
    { name: "a negative limit", argv: ["--limit", "-1"] },
    { name: "an unknown chat type", argv: ["--type", "nonsense"] },
    { name: "a non-numeric id", argv: ["--id", "abc"] },
    { name: "a value given to a switch", argv: ["--muted=yes"] },
  ];

  for (const row of BAD_USAGE) {
    test(`${row.name} throws UsageError (exit ${EXIT.USAGE})`, () => {
      const error = captureError(() => parseArgs(row.argv));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).exitCode).toBe(EXIT.USAGE);
    });
  }
});

describe("runCli: dispatch, version, help, and stubs", () => {
  test("--version prints version and commit to stdout and exits 0", async () => {
    const io = capture();
    const code = await runCli({ ...io.ctx, argv: ["--version"] });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout.text()).toContain(CLI_VERSION);
    expect(io.stdout.text()).toContain(CLI_COMMIT);
    expect(io.stderr.text()).toBe("");
  });

  test("versionLine names the binary, the version and the commit", () => {
    expect(versionLine()).toBe(`chaff ${CLI_VERSION} (${CLI_COMMIT})\n`);
  });

  test("the build defines are absent here, so both default to dev", () => {
    expect(CLI_VERSION).toBe("dev");
    expect(CLI_COMMIT).toBe("dev");
  });

  test("--help writes usage to stdout and exits 0", async () => {
    const io = capture();
    const code = await runCli({ ...io.ctx, argv: ["--help"] });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout.text()).toContain("--keyword");
    expect(io.stderr.text()).toBe("");
  });

  test("-h is the same: usage on stdout, exit 0", async () => {
    const io = capture();
    expect(await runCli({ ...io.ctx, argv: ["-h"] })).toBe(EXIT.OK);
    expect(io.stdout.text()).toContain("Commands");
    expect(io.stderr.text()).toBe("");
  });

  test("no command prints usage to stderr and exits 2", async () => {
    const io = capture();
    expect(await runCli({ ...io.ctx, argv: [] })).toBe(EXIT.USAGE);
    expect(io.stderr.text()).toContain("Commands");
    expect(io.stdout.text()).toBe("");
  });

  test("an unknown command prints usage to stderr and exits 2", async () => {
    const io = capture();
    expect(await runCli({ ...io.ctx, argv: ["nope"] })).toBe(EXIT.USAGE);
    expect(io.stderr.text()).toContain(`unknown command "nope"`);
    expect(io.stdout.text()).toBe("");
  });

  test("a conflicting flag exits 2 with usage on stderr and nothing on stdout", async () => {
    const io = capture();
    expect(await runCli({ ...io.ctx, argv: ["--yes", "--dry-run"] })).toBe(EXIT.USAGE);
    expect(io.stderr.text()).toContain("--yes and --dry-run contradict");
    expect(io.stdout.text()).toBe("");
  });

  test("a bad flag exits 2 with the message on stderr and nothing on stdout", async () => {
    const io = capture();
    expect(await runCli({ ...io.ctx, argv: ["--nope"] })).toBe(EXIT.USAGE);
    expect(io.stderr.text()).toContain("unknown flag --nope");
    expect(io.stdout.text()).toBe("");
  });

  test("every command is listed in the usage text", async () => {
    const io = capture();
    await runCli({ ...io.ctx, argv: ["--help"] });
    for (const command of COMMANDS) {
      expect(io.stdout.text()).toContain(command.name);
    }
  });

  /**
   * The commands that are not stubs-in-waiting any more are removed from this
   * list as they land. Listed by name, so landing one is a one-line edit here
   * rather than a silently weaker loop.
   */
  const NOT_BUILT_YET: readonly string[] = [];

  test("the commands that are not built yet are stubs that exit 1 and say so", async () => {
    for (const name of NOT_BUILT_YET) {
      expect(COMMANDS.some((command) => command.name === name)).toBe(true);
      const io = capture();
      expect(await runCli({ ...io.ctx, argv: [name] })).toBe(EXIT.ERROR);
      expect(io.stderr.text()).toContain("not implemented");
    }
  });

  test("the dispatch table is the command list `plan/cli.md` documents", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([
      "login",
      "whoami",
      "list",
      "report",
      "leave",
      "journal",
      "doctor",
      "logout",
      "tui",
    ]);
  });

  test("runCli never returns a code the core does not define", async () => {
    // The dispatch has to reach a real command, and `env: {}` would resolve the
    // REAL data directory: on a machine with a session in it, `list` opened a
    // socket to Telegram (AGENTS.md rule 1 says `test/` never does) and hung past
    // this test's own timeout, while staying green wherever no session exists.
    // A throwaway root keeps the same dispatch honest and offline.
    const codes = new Set<number>(Object.values(EXIT));
    const root = mkdtempSync(join(tmpdir(), "chaff-dispatch-"));
    try {
      const io = capture();
      const code = await runCli({
        ...io.ctx,
        env: {
          HOME: root,
          XDG_DATA_HOME: join(root, "data"),
          XDG_CONFIG_HOME: join(root, "config"),
        },
        argv: ["list"],
      });
      expect(codes.has(code)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * `runCli` binds the sink once, before it calls a command: the command says
 * *what* it emits and the front end decides *where* each kind of line goes.
 * These tests dispatch a real probe command through the real dispatch path, so
 * the binding is exercised where a Task-11 command would meet it.
 */
describe("runCli: a command cannot choose its stream", () => {
  const PROBE_TABLE: Table<{ id: number }> = {
    columns: [{ key: "id", header: "id", align: "right", value: (row) => String(row.id) }],
    rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };

  const probe: Command = {
    name: "probe",
    summary: "Emit a payload and two chatter lines",
    async run(ctx) {
      // The sink is the only writer a command can reach, and no channel takes a
      // format, so the routing cannot be re-opened from inside a command.
      for (const channel of [
        ctx.out.payload,
        ctx.out.document,
        ctx.out.line,
        ctx.out.note,
        ctx.out.verbose,
        ctx.out.error,
      ]) {
        expect(channel.length).toBe(1);
      }
      ctx.out.payload(PROBE_TABLE);
      ctx.out.note("probe: note\n");
      ctx.out.verbose("probe: verbose\n");
      return EXIT.OK;
    },
  };

  test("with --json -v stdout parses as JSON and both lines are on stderr", async () => {
    const io = capture();
    const code = await runCli({ ...io.ctx, argv: ["--json", "-v", "probe"] }, [probe]);

    expect(code).toBe(EXIT.OK);
    expect(io.stdout.text()).toBe(renderJson(PROBE_TABLE));
    expect(JSON.parse(io.stdout.text())).toHaveLength(3);
    expect(io.stderr.text()).toBe("probe: note\nprobe: verbose\n");
  });

  test("without a machine format the note stays on stdout", async () => {
    const io = capture();
    const code = await runCli({ ...io.ctx, argv: ["-v", "probe"] }, [probe]);

    expect(code).toBe(EXIT.OK);
    expect(io.stdout.text()).toBe(renderTable(PROBE_TABLE) + "probe: note\nprobe: verbose\n");
    expect(io.stderr.text()).toBe("");
  });

  test("under --json a command's error line still goes to stderr", async () => {
    const io = capture();
    const errProbe: Command = {
      name: "errprobe",
      summary: "error line",
      async run(ctx) {
        ctx.out.error("boom\n");
        return EXIT.ERROR;
      },
    };
    expect(await runCli({ ...io.ctx, argv: ["--json", "errprobe"] }, [errProbe])).toBe(EXIT.ERROR);
    expect(io.stdout.text()).toBe("");
    expect(io.stderr.text()).toContain("boom");
  });

  test("a command's context has no raw writer, and not only by type", async () => {
    const io = capture();
    let seen: CommandContext | undefined;
    const spy: Command = {
      name: "probe",
      summary: "Record the context it was handed",
      async run(ctx) {
        seen = ctx;
        return EXIT.OK;
      },
    };

    expect(await runCli({ ...io.ctx, argv: ["probe"] }, [spy])).toBe(EXIT.OK);

    // The old `Omit<CliContext, "stdout" | "stderr">` was a promise the type
    // checker kept and the object broke: `runCli` handed the command the whole
    // `CliContext`, so both writers were own properties of it, one cast away.
    // These assertions are RED on that shape and RED on any `Omit`.
    const ctx = seen as CommandContext;
    expect(Object.keys(ctx).sort()).toEqual(["args", "env", "isTTY", "now", "out"]);
    expect(Object.hasOwn(ctx, "stdout")).toBe(false);
    expect(Object.hasOwn(ctx, "stderr")).toBe(false);
    expect("stdout" in ctx).toBe(false);
    expect("stderr" in ctx).toBe(false);
    expect("argv" in ctx).toBe(false);
    expect((ctx as unknown as { stdout?: unknown }).stdout).toBeUndefined();
    expect((ctx as unknown as { stderr?: unknown }).stderr).toBeUndefined();
    expect(ctx.args.command).toBe("probe");
    expect(ctx.isTTY).toBe(false);
    expect(ctx.now()).toEqual(new Date("2026-10-11T13:04:00Z"));
  });

  test("the type has no `stdout`, so a stray write does not compile (belt and braces)", () => {
    const read = (ctx: CommandContext): unknown => {
      // @ts-expect-error a command context deliberately has no `stdout`.
      return ctx.stdout;
    };
    expect(read).toBeTypeOf("function");
  });
});

describe("src/cli hygiene", () => {
  const CLI_ROOT = new URL("../src/cli", import.meta.url).pathname;
  const CORE_ROOT = new URL("../src/core", import.meta.url).pathname;

  function sources(root: string): Array<{ path: string; text: string }> {
    return readdirSync(root, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => ({ path: entry, text: readFileSync(join(root, entry), "utf8") }));
  }

  test("no file under src/cli writes to the real console", () => {
    const offenders = sources(CLI_ROOT)
      .filter((file) => /\bconsole\./.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("no file under src/cli imports mtcute", () => {
    const offenders = sources(CLI_ROOT)
      .filter((file) => file.text.includes("@mtcute"))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("the core never imports a front end", () => {
    const offenders = sources(CORE_ROOT)
      .filter((file) => /from\s+"\.\.\/(cli|tui)\//.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

describe("promptable", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  test("both ends have to be terminals", () => {
    expect(promptable(tty, tty)).toBe(true);
    // The case that used to hang: stdout was a terminal, so the old stdout-only
    // check said "ask", and the question went out to a stdin that could never
    // answer it.
    expect(promptable(tty, pipe)).toBe(false);
    expect(promptable(pipe, tty)).toBe(false);
    expect(promptable(pipe, pipe)).toBe(false);
  });

  test("a stream that does not say is not a terminal", () => {
    expect(promptable(undefined, undefined)).toBe(false);
    expect(promptable({}, tty)).toBe(false);
  });
});

/** The value of a thrown call, or `undefined` when it did not throw. */
function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** An in-memory capture of everything a `runCli` call writes. */
function capture(): {
  ctx: CliContext;
  stdout: Sink;
  stderr: Sink;
} {
  const stdout = sink();
  const stderr = sink();
  return {
    ctx: {
      argv: [],
      env: {},
      stdout,
      stderr,
      now: () => new Date("2026-10-11T13:04:00Z"),
      isTTY: false,
    },
    stdout,
    stderr,
  };
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
