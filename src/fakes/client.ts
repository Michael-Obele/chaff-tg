/**
 * The offline stand-in for the Telegram seam — shipped, not test-only.
 *
 * `CHAFF_FAKE` is how CI runs a compiled binary against this tool without a
 * live account (implementation-plan.md, "Fake client switch"), and a binary
 * built from `src/` alone cannot resolve anything under `test/`, so the
 * implementation lives here and `test/fake-client.ts` re-exports it with the
 * Task 2 fixtures wired in as defaults.
 *
 * Two rules shape it:
 *
 * - It never imports `@mtcute/*` (AGENTS.md rule 3: mtcute lives in exactly one
 *   file, `src/core/telegram.ts`). The imports below are `import type`, so
 *   loading this module pulls in no library and no wasm.
 * - Its failure list is scripted, so the tasks that must survive Telegram's
 *   answers — `FLOOD_WAIT_90`, `PEER_FLOOD`, `CHANNEL_PRIVATE` — can be tested
 *   without provoking them (plan/safety.md, "Telegram's side of the risk").
 */
import type { TelegramClientLike } from "../core/telegram";
import type { Account, ChatRecord } from "../core/types";

/** `FLOOD_WAIT_<n>`: the one error whose text the library rewrites. */
const FLOOD_WAIT_RE = /^FLOOD_WAIT_(\d+)$/;

/**
 * A stand-in for mtcute's `RpcError`, carrying the same fields with the same
 * values so code written against the real error reads this one identically.
 *
 * Faithful, per `@mtcute/core/tl/inner-tl.js:10-38`:
 *
 * - `.message` is `Telegram API error <code>: <text>`, built from the raw text
 *   *before* any rewriting — so `FLOOD_WAIT_90` is still in the message, which
 *   is where `classify` (src/core/errors.ts) reads it;
 * - `.code` is Telegram's own (a flood wait answers 420, everything else 400);
 * - a flood's `.text` becomes the template `"FLOOD_WAIT_%d"` and the number
 *   moves to `.seconds`, exactly as `RpcError.fromTl` does;
 * - `.name` is `"Error"`, as it is on the real class — which never assigns one.
 *
 * Not faithful, and it cannot be: this is not the library's class, so
 * `RpcError.is(err)` — which compares `err.constructor === RpcError` — never
 * matches a fake. Anything branching on that has to branch on `.text` here.
 *
 * A non-flood keeps its text verbatim and leaves `.seconds` undefined (mtcute
 * leaves the property absent; an optional field reads the same either way).
 */
export class FakeRpcError extends Error {
  readonly code: number;
  readonly text: string;
  /** The seconds Telegram asked for; set on a flood wait, like `fromTl`. */
  readonly seconds?: number;

  constructor(code: number, text: string) {
    super(`Telegram API error ${code}: ${text}`);
    this.code = code;

    const flood = FLOOD_WAIT_RE.exec(text);
    if (flood?.[1] === undefined) {
      this.text = text;
      return;
    }

    this.text = "FLOOD_WAIT_%d";
    this.seconds = Number.parseInt(flood[1], 10);
  }
}

/**
 * Build a fake Telegram answer: `fakeRpcError("FLOOD_WAIT_90")`. Flood waits
 * carry 420, everything else 400 — mtcute never invents its own code, it
 * reports the one Telegram sent.
 */
export function fakeRpcError(
  text: string,
  code = text.startsWith("FLOOD_WAIT_") ? 420 : 400,
): FakeRpcError {
  return new FakeRpcError(code, text);
}

/**
 * Parse `CHAFF_FAKE_FAILURES`: `chatId:error[:times]` entries, comma separated
 * (for example `-1002:FLOOD_WAIT_90,-1003:CHANNEL_PRIVATE:2`).
 *
 * This is how the tasks that must survive Telegram's answers are exercised
 * end to end through the real front end -- the CLI builds its fake through
 * `openClient`, and this variable is the one seam that scripts its failures
 * without a test-only code path.
 *
 * A malformed entry throws with the entry in the message: it is a typo in the
 * caller's own environment, and silently ignoring it would turn a scripted
 * failure into a real one.
 */
export function parseFakeFailures(text: string): FakeFailure[] {
  const failures: FakeFailure[] = [];
  for (const entry of text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")) {
    const [idText, errorText, timesText] = entry.split(":");
    const chatId = Number(idText);
    if (idText === undefined || idText === "" || errorText === undefined || errorText === "") {
      throw new Error(
        `invalid CHAFF_FAKE_FAILURES entry ${JSON.stringify(entry)}: expected chatId:error[:times]`,
      );
    }
    const failure: FakeFailure = { chatId, error: fakeRpcError(errorText) };
    if (timesText !== undefined) {
      const times = Number(timesText);
      if (!Number.isInteger(times) || times < 1) {
        throw new Error(
          `invalid CHAFF_FAKE_FAILURES count ${JSON.stringify(timesText)} in ` +
            `${JSON.stringify(entry)}: expected a whole number of attempts`,
        );
      }
      failure.times = times;
    }
    failures.push(failure);
  }
  return failures;
}

/** One scripted `leaveChat` failure. */
export interface FakeFailure {
  /** The chat whose leave request fails. */
  chatId: number;
  /** What to throw. Build it with {@link fakeRpcError}. */
  error: Error;
  /** How many attempts fail, counting this one. Default 1; `Infinity` always. */
  times?: number;
}

/**
 * How to build a fake client.
 *
 * Nothing here reads a fixture file by default: this module ships, and a
 * shipped module cannot point at `test/fixtures`. Callers hand the data over —
 * `test/fake-client.ts` passes the Task 2 fixtures, `CHAFF_FAKE` mode passes
 * whatever {@link loadFixtures} was pointed at.
 */
export interface FakeClientOptions {
  /** The raw dialogs `iterDialogs()` yields. Defaults to none. */
  rawDialogs?: unknown[];
  /** Scripted `leaveChat` failures, consumed as they are thrown. */
  failures?: FakeFailure[];
  /** What `getMe()` / `me()` report. */
  account?: Account;
}

/** The fixture file a fake client is built from. */
export interface FakeFixtures {
  /** `raw-dialogs.json`: the chats as raw mtcute shapes (see {@link loadFixtures}). */
  rawDialogs: unknown[];
}

/**
 * Read the Task 2 fixtures — `dialogs.json` and `raw-dialogs.json` — from a
 * directory.
 *
 * `dir` is a URL or a path so each caller resolves it from its own module: the
 * suite passes `new URL("./fixtures/", import.meta.url)` and `CHAFF_FAKE` mode
 * passes wherever it was pointed at. Which directory to read is the caller's
 * decision, so no default lives here.
 */
export async function loadFixtures(dir: string | URL): Promise<FakeFixtures> {
  const base = fixtureDir(dir);
  return {
    // Only the raw shape: the records read out of it are the wrapper's job
    // (`TelegramApi.dialogs`), which is the code the offline suite must exercise.
    rawDialogs: (await Bun.file(new URL("raw-dialogs.json", base)).json()) as unknown[],
  };
}

/** A directory URL: `new URL(relative, dir)` needs the trailing slash. */
function fixtureDir(dir: string | URL): URL {
  const url = typeof dir === "string" ? new URL(dir, `file://${process.cwd()}/`) : dir;
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

/**
 * A `TelegramClientLike` and a `TelegramApi`, both offline.
 *
 * The two roles are why it has both `getMe()` and `me()`, and both `leaveChat()`
 * and `leave()`: the low-level names are the library's, the others are the ones
 * the rest of chaff-tg calls.
 */
export class FakeClient implements TelegramClientLike {
  /** Every `leaveChat` call, in order, with the params it was given. */
  readonly attempts: Array<{ chatId: number; params?: { clear?: boolean } }> = [];

  /** The chat ids that were actually left, in order. */
  readonly left: number[] = [];

  /** How many raw dialogs `iterDialogs()` handed out — evidence for early stops. */
  yields = 0;

  /** Whether `destroy()` was called. */
  destroyed = false;

  private readonly raws: unknown[];
  private readonly failures: FakeFailure[];
  private readonly account: Account;

  constructor(opts: FakeClientOptions = {}) {
    this.raws = opts.rawDialogs ?? [];
    this.failures = [...(opts.failures ?? [])];
    this.account = opts.account ?? { id: 1, username: "chaff_tester" };
  }

  /**
   * Raw dialogs, in fixture order.
   *
   * `archived` is the one parameter honoured, because it is the one whose
   * *default* changes what exists: mtcute's `iterDialogs` defaults to
   * `archived: "exclude"` and returns the main folder only unless asked for
   * both. A fake that ignored that would hand out archived rows the real
   * client never yields, so the `--archived` filter could pass every offline
   * test while never matching a live account. Modelling it here is what makes
   * `test/normalize.test.ts` able to catch that regression.
   *
   * Everything else is accepted and deliberately ignored: `limit` is
   * `TelegramApi.dialogs`'s contract, and a cap here would shadow the wrapper's
   * own stop, leaving it untested. The fixture is small enough that the extra
   * requests do not matter.
   */
  async *iterDialogs(params?: unknown): AsyncIterableIterator<unknown> {
    const archived =
      (params as { archived?: "exclude" | "only" | "keep" } | undefined)?.archived ?? "exclude";
    for (const raw of this.raws) {
      const isArchived = (raw as { isArchived?: unknown } | null)?.isArchived === true;
      if (archived === "exclude" && isArchived) continue;
      if (archived === "only" && !isArchived) continue;
      this.yields += 1;
      yield raw;
    }
  }

  /** Record the attempt, throw a scripted failure if one is due, else leave. */
  async leaveChat(chatId: unknown, params?: { clear?: boolean }): Promise<void> {
    const id = typeof chatId === "number" ? chatId : Number.NaN;
    this.attempts.push({ chatId: id, params });

    const failure = this.takeFailure(id);
    if (failure !== null) throw failure;
    this.left.push(id);
  }

  /** The authorized account, in mtcute's `User` shape. */
  async getMe(): Promise<unknown> {
    return {
      type: "user",
      id: this.account.id,
      username: this.account.username,
      displayName: this.account.username ?? "Fake Account",
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  /**
   * The fixture's own answer to `getChat`: a known id comes back as its peer,
   * and anything else throws the way mtcute throws for an id it cannot resolve,
   * so the `gone` path of `chaff check` is exercised offline too. A forbidden
   * row carries `isBanned`, so `banned` is exercised from the same place.
   */
  async getChat(chatId: unknown): Promise<unknown> {
    const row = this.raws.find(
      (raw) => (raw as { peer?: { id?: unknown } } | null)?.peer?.id === chatId,
    );
    if (row === undefined) throw fakeRpcError("CHAT_ID_INVALID");
    return (row as { peer: unknown }).peer;
  }

  /** The `TelegramApi`-shaped leave. */
  async leave(chatId: number, opts: { clear?: boolean } = {}): Promise<void> {
    await this.leaveChat(chatId, opts);
  }

  /** The `TelegramApi`-shaped account read. */
  async me(): Promise<Account> {
    return { ...this.account };
  }

  /**
   * The next scripted failure for this chat, consumed so that the documented
   * retry can succeed: a `FLOOD_WAIT_90` run stops, and the resume run has to
   * get past the chat it stopped on.
   */
  private takeFailure(chatId: number): Error | null {
    const index = this.failures.findIndex((failure) => failure.chatId === chatId);
    const failure = this.failures[index];
    if (failure === undefined) return null;

    const remaining = (failure.times ?? 1) - 1;
    if (remaining > 0) this.failures[index] = { ...failure, times: remaining };
    else this.failures.splice(index, 1);
    return failure.error;
  }
}
