/**
 * An offline stand-in for the Telegram seam (implementation-plan.md, "Fake
 * client switch"; task 8 brief).
 *
 * It implements `TelegramClientLike` — the same four methods the real mtcute
 * client exposes — so `TelegramApi` can be driven without a network, and it
 * adds the app-shaped `dialogs()` / `leave()` / `me()` helpers so the CLI can
 * use it as a drop-in for `TelegramApi` under `CHAFF_FAKE=1` (Task 11).
 *
 * Two rules shape it:
 *
 * - It never imports `@mtcute/*` (AGENTS.md rule 3: mtcute lives in exactly
 *   one file, `src/core/telegram.ts`). The import below is type-only, so
 *   importing this module at runtime loads no library at all.
 * - Its failure list is scripted, so the tasks that must survive Telegram's
 *   answers — `FLOOD_WAIT_90`, `PEER_FLOOD`, `CHANNEL_PRIVATE` — can be tested
 *   without provoking them (plan/safety.md, "Telegram's side of the risk").
 */
import type { TelegramClientLike } from "../src/core/telegram";
import type { Account, ChatRecord } from "../src/core/types";

const dialogs = (await Bun.file(
  new URL("./fixtures/dialogs.json", import.meta.url),
).json()) as ChatRecord[];

const rawDialogs = (await Bun.file(
  new URL("./fixtures/raw-dialogs.json", import.meta.url),
).json()) as unknown[];

/**
 * An `Error` shaped exactly like mtcute's `RpcError`, which is what the leave
 * loop has to classify: the constructor is
 * `super("Telegram API error " + code + ": " + text)`
 * (`@mtcute/core/tl/inner-tl.js:10-16`), and `classify` reads that message
 * rather than `.code`/`.text` (`src/core/errors.ts`).
 */
export class FakeRpcError extends Error {
  readonly code: number;
  readonly text: string;

  constructor(code: number, text: string) {
    super(`Telegram API error ${code}: ${text}`);
    this.name = "FakeRpcError";
    this.code = code;
    this.text = text;
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

/** One scripted `leaveChat` failure. */
export interface FakeFailure {
  /** The chat whose leave request fails. */
  chatId: number;
  /** What to throw. Build it with {@link fakeRpcError}. */
  error: Error;
  /** How many attempts fail, counting this one. Default 1; `Infinity` always. */
  times?: number;
}

/** How to build a fake client. Every field falls back to the Task 2 fixture. */
export interface FakeClientOptions {
  /** The records `dialogs()` yields. Defaults to `fixtures/dialogs.json`. */
  dialogs?: ChatRecord[];
  /** The raw dialogs `iterDialogs()` yields. Defaults to `fixtures/raw-dialogs.json`. */
  rawDialogs?: unknown[];
  /** Scripted `leaveChat` failures, consumed as they are thrown. */
  failures?: FakeFailure[];
  /** What `getMe()` / `me()` report. */
  account?: Account;
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

  private readonly records: ChatRecord[];
  private readonly raws: unknown[];
  private readonly failures: FakeFailure[];
  private readonly account: Account;

  constructor(opts: FakeClientOptions = {}) {
    this.records = opts.dialogs ?? dialogs;
    this.raws = opts.rawDialogs ?? rawDialogs;
    this.failures = [...(opts.failures ?? [])];
    this.account = opts.account ?? { id: 1, username: "chaff_tester" };
  }

  /**
   * Raw dialogs, in fixture order.
   *
   * `params` is accepted and deliberately ignored: `limit` is
   * `TelegramApi.dialogs`'s contract, and a cap here would shadow the wrapper's
   * own stop, leaving it untested. The fixture is small enough that the extra
   * requests do not matter.
   */
  async *iterDialogs(params?: unknown): AsyncIterableIterator<unknown> {
    void params;
    for (const raw of this.raws) {
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

  /** The `TelegramApi`-shaped list, straight from the fixture. */
  async *dialogs(opts: { limit?: number } = {}): AsyncIterable<ChatRecord> {
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let seen = 0;
    for (const chat of this.records) {
      if (seen >= limit) return;
      seen += 1;
      yield chat;
    }
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
