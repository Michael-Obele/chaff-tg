/**
 * The Telegram seam: the only file in the repository that may import
 * `@mtcute/*` (AGENTS.md rule 3; plan/architecture.md, "The only file that
 * talks to Telegram").
 *
 * Two things live here, and nothing else does:
 *
 * - {@link normalizeDialog} turns one mtcute `Dialog` into the `ChatRecord`
 *   every filter sees. It is pure — no client, no clock, no network — so the
 *   shape the whole core is built on is unit-tested from a fixture instead of
 *   against a live account.
 * - {@link TelegramApi} wraps a {@link TelegramClientLike} in the four
 *   operations chaff-tg performs: list dialogs, leave one chat, read the
 *   account, close.
 *
 * Every API detail below was verified against the installed type definitions
 * (`@mtcute/bun` 0.32.4), never against documentation prose. The three
 * mistakes in the snippet everyone copies (plan/notes.md, "Corrections to the
 * original snippet") are visible in the field mapping: `dialog.peer` and not
 * `dialog.chat`, `chat.chatType` and not `chat.type`, `iterDialogs` and not
 * `getDialogs`.
 *
 * Field *names* are not left to that reading alone: {@link normalizeDialog}
 * takes a {@link RawDialog}, a `Pick` of the library's own `Dialog`, so a
 * rename or retype upstream fails `tsc --noEmit` instead of quietly defaulting
 * every chat. Field *values* are still validated at runtime.
 */
import { TelegramClient } from "@mtcute/bun";
import type { Chat, Dialog } from "@mtcute/core";
import type { Account, ChatRecord, ChatType } from "./types";

/**
 * The mtcute client narrowed to the five methods this tool uses.
 *
 * Structural on purpose. The names are the library's own — `iterDialogs`
 * (`@mtcute/core/highlevel/client.d.ts:2153`), `leaveChat` (:1524), `getMe`
 * (:5964), `getChats` (:1386) and `destroy` (`@mtcute/bun/client.d.ts`) — so a
 * real `TelegramClient` satisfies this interface as written. `createClient`
 * returns one without a cast, which makes the type a checked statement about
 * the installed library rather than a description of it.
 */
export interface TelegramClientLike {
  /** `iterDialogs(params?)`: an async iterable of `Dialog`s, newest first. */
  iterDialogs(params?: unknown): AsyncIterable<unknown>;
  /** `leaveChat(chatId, { clear })`: leave one group, supergroup or channel. */
  leaveChat(chatId: unknown, params?: { clear?: boolean }): Promise<void>;
  /** `getChat(chatId)`: one chat by id; throws when the id cannot be resolved. */
  getChat(chatId: unknown): Promise<unknown>;
  /** `getMe()`: the authorized user. */
  getMe(): Promise<unknown>;
  /** `destroy()`: close the connection and release the session. */
  destroy(): Promise<void>;
}

/**
 * What `chaff check` can say about one chat id.
 *
 * `gone` is the only status that means "this id is dead"; `banned` and
 * `unavailable` both mean Telegram still answers for it, but will not let this
 * account see it.
 */
export type ChatStatus = "ok" | "banned" | "unavailable" | "gone";

/** One id's verdict: its status, and its title when Telegram still answers. */
export interface ChatCheck {
  id: number;
  status: ChatStatus;
  /** `null` when the chat is gone; there is nothing left to name. */
  title: string | null;
  /**
   * Whether Telegram marks the chat restricted (`Chat.isRestricted`). A
   * restricted chat is usually still `ok`: Telegram answers for it, and shows
   * the content to be withheld.
   */
  restricted: boolean;
  /**
   * The restriction reasons, comma joined and deduped, or `null`. This is the
   * only place the "why is this blocked" question has an answer at all: a
   * forbidden peer carries no reason in this TL layer
   * (`RawChannelForbidden` in @mtcute/core/tl is id, access hash, title and
   * untilDate), so `banned` cannot say copyright, spam or anything else
   * (plan/groups.md, "Blocked channels and `chaff check`").
   */
  restriction: string | null;
}

/**
 * The ways Telegram and mtcute say "this id is not a chat I can show you": an
 * id Telegram rejects outright, a chat the account may no longer see, and the
 * library's own "was not found" for an id it cannot resolve.
 *
 * A connect-time failure, a flood wait or a network error is deliberately NOT
 * in here: those are the caller's to classify, and turning one into a quiet
 * "gone" would hide a real problem behind a reassuring answer.
 */
const UNRESOLVABLE_RE = /CHAT_ID_INVALID|PEER_ID_INVALID|CHANNEL_PRIVATE|was not found/i;

function isUnresolvable(error: unknown): boolean {
  return error instanceof Error && UNRESOLVABLE_RE.test(error.message);
}

/** The verdict for a chat Telegram still answered for. */
function verdictOf(id: number, chat: RawObject): ChatCheck {
  const status: ChatStatus =
    asBoolean(chat["isBanned"]) === true
      ? "banned"
      : asBoolean(chat["isLikelyUnavailable"]) === true
        ? "unavailable"
        : "ok";
  // The same two spellings `normalizeDialog` accepts: `displayName` is the
  // library's alias for the raw title.
  return {
    id,
    status,
    title: asString(chat["displayName"]) ?? asString(chat["title"]),
    restricted: asBoolean(chat["isRestricted"]) ?? false,
    restriction: restrictionTextOf(chat),
  };
}

/**
 * The restriction reasons of a chat, as one field.
 *
 * `Chat.restrictions` is an array of `{ platform, reason, text }`, present only
 * when the chat is restricted. The machine `reason` is what a script and a
 * filter want; `text` is the sentence for the user, and is deliberately not
 * folded in here: a column that sometimes holds prose and sometimes a token is
 * a column nobody can read off. When there is no usable reason the answer is
 * `null`, not an empty string.
 */
export function restrictionTextOf(chat: RawObject): string | null {
  const list = chat["restrictions"];
  if (!Array.isArray(list)) return null;
  const reasons: string[] = [];
  for (const item of list) {
    const reason = asString(asObject(item)?.["reason"]);
    if (reason !== null && reason !== "" && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons.length === 0 ? null : reasons.join(",");
}

/** Credentials and the stored session a real client needs. */
export interface ClientOptions {
  apiId: number;
  /** Never logged, never stored outside the config file (plan/safety.md). */
  apiHash: string;
  /** Where mtcute's SQLite storage keeps the account (`Paths.sessionPath`). */
  sessionPath: string;
  /**
   * Whether mtcute may ask the terminal for a phone number, a code and a 2fa
   * password when the session turns out not to be signed in.
   *
   * `chaff login` at a terminal says yes — signing in is the point of that
   * command. Everything else says no: a command in the middle of a run must
   * never stop and wait for a human, and a caller with no terminal would wait
   * forever for an answer that can never arrive.
   */
  interactive: boolean;
  /**
   * Where the library's own log lines go, or `undefined` to drop them.
   *
   * mtcute logs with `console.log`, which is stdout, and stdout is the channel a
   * machine format owns. One library warning is enough to make
   * `chaff list --json` unparseable: measured, a `messages.getDialogs` flood
   * wait put its line ahead of the JSON object, and every `jq` downstream broke.
   *
   * The sink is injected rather than written to here, because the core never
   * prints (plan/architecture.md, "Repo layout"). A caller that passes nothing
   * loses the library's chatter, which is the honest default for a library: the
   * front end decides what a user sees.
   */
  log?: (line: string) => void;
}

/**
 * Build and connect a real client over a stored session.
 *
 * `storage: sessionPath` selects Bun's SQLite storage on `bun:sqlite`
 * (`@mtcute/bun/sqlite`: `SqliteStorage(filename?)`), so the `-wal` and `-shm`
 * side files appear next to the session inside the 0700 data directory, where
 * `removeSession` already knows to look for them
 * (plan/architecture.md, "Session and journal").
 *
 * `start()` is the connect step. On a signed-in session it returns immediately:
 * mtcute's `start` calls `getMe` first, and only falls through to the sign-in
 * flow when the session is not authorized.
 *
 * That fall-through is where the prompts live, and they are NOT `@mtcute/core`'s:
 * core's own `start` throws rather than asking
 * (`@mtcute/core/highlevel/methods/auth/start.js`), but `@mtcute/bun`'s client
 * installs terminal prompts for the phone, the code and the 2fa password
 * whenever they are missing (`@mtcute/bun/client.js`, `start`), so core never
 * sees one missing. Measured on chaff-tg itself: `chaff login < /dev/null` sat at
 * a `phone > ` prompt until it was killed, because that prompt reads a stdin that
 * had already ended.
 *
 * So whether anyone may be asked is {@link ClientOptions.interactive}, a decision
 * this module is handed rather than one it makes: the CLI knows whether a
 * terminal is attached, and the core may not read `process.stdin`. Non-interactive
 * callers get {@link refuseSignIn}, which turns the silent wait into a sentence.
 *
 * This function never reads `CHAFF_FAKE`: choosing the fake client belongs to
 * the CLI layer (implementation-plan.md, Task 11).
 */
export async function createClient(opts: ClientOptions): Promise<TelegramClientLike> {
  const client = new TelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage: opts.sessionPath,
  });

  // Take the library's log away from stdout. `LogManager.handler` is the single
  // sink every child logger ends up in, so setting it once covers the network,
  // updates and storage loggers together.
  const sink = opts.log;
  client.log.mgr.handler = (_color, _level, tag, fmt, args) => {
    if (sink === undefined) return;
    const rest = args.map(describeLogArgument).join(" ");
    sink(`${tag}: ${fmt}${rest === "" ? "" : ` ${rest}`}`);
  };

  try {
    await client.start(
      // These three are exactly what the Bun client would otherwise fill in with a
      // prompt, so when nobody may be asked the sign-in fails instead of waiting.
      opts.interactive ? {} : { phone: refuseSignIn, code: refuseSignIn, password: refuseSignIn },
    );
  } catch (error) {
    // The client owns sockets and a SQLite handle, and this function is what
    // created it, so a failed connect has to close it here too. Left open it holds
    // the event loop, and the process prints the failure and then never exits
    // (measured: `timeout` reported 124 with the message already on stderr).
    await client.destroy().catch(() => {});
    throw error;
  }

  // The return statement is the structural check: this line stops compiling
  // the moment mtcute's surface drifts away from the seam.
  return client;
}

/**
 * Refuse a sign-in that would have to ask a terminal.
 *
 * This is what a non-interactive caller passes as the phone, the code and the 2fa
 * password (see {@link createClient}). It returns `never`, which is assignable to
 * each provider's return type, so one function stands in for all three — and the
 * throw becomes a sentence the command can report, instead of a prompt that never
 * returns.
 */
function refuseSignIn(): never {
  throw new Error(
    "this session is not signed in, and there is no terminal to sign in on: " +
      "run `chaff login` in a terminal, or set CHAFF_FAKE=1 to work offline",
  );
}

/**
 * The four Telegram operations chaff-tg performs, over an injected client.
 *
 * The constructor takes the client rather than building one, so the wrapper is
 * testable without a network — `test/fake-client.ts` is a `TelegramClientLike`
 * — and {@link TelegramApi.connect} stays the only place a real client is
 * created.
 */
export class TelegramApi {
  /** Connect a real client over a stored session, then wrap it. */
  static async connect(opts: ClientOptions): Promise<TelegramApi> {
    return new TelegramApi(await createClient(opts));
  }

  constructor(private readonly client: TelegramClientLike) {}

  /**
   * List the account's dialogs as `ChatRecord`s, in mtcute's order (newest
   * first), skipping private chats and bots: they are not chats this tool can
   * leave, and `ChatRecord` has no shape for them.
   *
   * The two parameters are decided by the client's own contract, read from
   * `@mtcute/core/highlevel/methods/dialogs/iter-dialogs.js` rather than
   * assumed:
   *
   * - **`archived: "keep"` is required, not a preference.** `iterDialogs`
   *   defaults to `archived: "exclude"`, which fetches the main folder only.
   *   Left at the default, no archived dialog ever reaches this method, so
   *   `--archived` could never match a live account and `--no-archived` was
   *   trivially true. Asking for both folders keeps the split this module
   *   promises: the seam gathers, the pure filter decides (`src/core/filters.ts`).
   * - **`limit` is deliberately NOT forwarded.** The client's `limit` caps the
   *   dialogs it hands out, and that stream carries users and bots too, which
   *   the line below skips. Forwarding it spends the caller's `--limit` on peers
   *   that can never become a record, so the caller would silently get fewer
   *   rows than it asked for. The cap belongs here, on the records, which is
   *   what `--limit` documents ("maximum rows to gather"). The price is at most
   *   one extra chunk of `chunkSize` dialogs fetched from the client.
   *
   * `limit` stops iterating as soon as that many records have been yielded —
   * a skipped peer does not consume a slot — and `0` yields nothing without
   * touching the client at all.
   */
  async *dialogs(opts: { limit?: number } = {}): AsyncIterable<ChatRecord> {
    const limit = opts.limit;
    if (limit !== undefined && limit <= 0) return;

    let seen = 0;
    for await (const raw of this.client.iterDialogs({ archived: "keep" })) {
      if (!isChatDialog(raw)) continue;
      yield normalizeDialog(raw);
      seen += 1;
      if (limit !== undefined && seen >= limit) return;
    }
  }

  /**
   * Ask Telegram about chat ids this account already knows.
   *
   * The ids have to come from somewhere the account has seen them (a manifest,
   * the journal): a chat that is gone has no dialog left to list, which is
   * exactly why "find banned channels" cannot be a filter on
   * {@link TelegramApi.dialogs} (plan/notes.md, "Banned channels").
   *
   * One `getChat` per id, deliberately. mtcute also offers `getChats`, which
   * batches, but a batch is only as good as its worst id: measured against a
   * real account, a single unresolvable id makes `getChats` throw
   * `CHAT_ID_INVALID` for the whole call, so every other answer is lost with
   * it. Asked one at a time, an id that cannot be resolved is one row of the
   * report, which is the whole point of asking.
   *
   * A forbidden chat comes back as a chat object rather than an error, so the
   * verdict is read off the peer:
   *
   * - `banned` — Telegram returned `chatForbidden`, `channelForbidden` or
   *   `communityForbidden`;
   * - `unavailable` — `Chat.isLikelyUnavailable`, which is wider: banned, a
   *   group you left or that was deactivated, a private channel you are no
   *   longer in;
   * - `ok` — anything else Telegram still answers for;
   * - `gone` — the id cannot be resolved any more ({@link UNRESOLVABLE_RE}).
   *   An id that never existed and a chat that was deleted are deliberately
   *   not distinguished: the account cannot tell them apart either.
   *
   * Anything else the client throws is the caller's to classify, exactly as in
   * {@link TelegramApi.leave}.
   */
  async checkChats(ids: number[]): Promise<ChatCheck[]> {
    const out: ChatCheck[] = [];
    for (const id of ids) {
      try {
        const chat = asObject(await this.client.getChat(id));
        out.push(
          chat === null
            ? { id, status: "gone", title: null, restricted: false, restriction: null }
            : verdictOf(id, chat),
        );
      } catch (error) {
        if (!isUnresolvable(error)) throw error;
        out.push({ id, status: "gone", title: null, restricted: false, restriction: null });
      }
    }
    return out;
  }

  /** Leave one chat. `clear` also wipes the history of a legacy group chat. */
  async leave(chatId: number, opts: { clear?: boolean } = {}): Promise<void> {
    await this.client.leaveChat(chatId, opts);
  }

  /** The authorized account, as the two fields a plan records. */
  async me(): Promise<Account> {
    const me = asObject(await this.client.getMe());
    const id = asNumber(me?.["id"]);
    if (id === null) throw new TypeError("TelegramApi.me: the client returned no account id");
    return { id, username: asString(me?.["username"]) };
  }

  /** Close the client and release the session file. */
  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}

//
// Normalization. Pure: the only inputs are the raw dialog and the readers
// below, and the only output is a value.
//

/**
 * The `chatType` values Telegram reports, as one checked table
 * (`Chat.chatType`, plan/architecture.md).
 *
 * The `satisfies` is the point of the object: the runtime list and the closed
 * `ChatType` union (src/core/types.ts) cannot drift apart, because a new member
 * of either one fails `tsc` here — a missing key when the union grows, an
 * excess one when mtcute grows a chat kind first. The `readonly ChatType[]`
 * this replaces checked neither direction, and the failure it left behind was a
 * *runtime* refusal of a legitimate chat, which aborts the whole listing.
 */
const CHAT_TYPES = {
  group: true,
  supergroup: true,
  channel: true,
  gigagroup: true,
  monoforum: true,
  community: true,
} satisfies Record<ChatType, true> & Record<Chat["chatType"], true>;

function isChatType(value: string): value is ChatType {
  return Object.hasOwn(CHAT_TYPES, value);
}

type RawObject = Record<string, unknown>;

/**
 * Structural readers.
 *
 * `normalizeDialog` reads *values* through these, never field names: the input
 * type ({@link RawDialog}) carries mtcute's own names and types, but a fixture
 * or a hand-built dialog reaches this module through one cast at its own
 * boundary, so nothing here trusts a declared shape at run time. That is why
 * every read has to survive a missing key.
 */
function asObject(value: unknown): RawObject | null {
  return typeof value === "object" && value !== null ? (value as RawObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * One argument of a library log line, as text.
 *
 * mtcute logs things like `messages.getDialogs resulted in a flood wait` with
 * an occasional `Error` mixed in. `String(error)` is `Error: message`, which
 * reads fine; `String({…})` is `[object Object]`, which does not, so plain
 * objects fall back to JSON and anything unreadable degrades to its string form
 * rather than throwing inside a logger.
 */
export function describeLogArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `Error: ${value.message}`;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * `lastMessage.date` is a `Date` on a live client
 * (`@mtcute/core/highlevel/types/messages/message.d.ts:135`) and a string in
 * the JSON fixture, so accept both and emit one spelling: ISO 8601 UTC.
 *
 * A date that cannot be read is treated as "no usable timestamp" rather than
 * crashing a listing halfway through; a chat with no message at all is a
 * genuine `null` (plan/architecture.md, "The normalized record").
 */
function isoUtcOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  return null;
}

/**
 * Whether a raw dialog is a chat (`Chat`) rather than a person (`User`).
 *
 * `Chat` and `User` both carry a literal `type` — `"chat"`
 * (`types/peers/chat.d.ts:21`) and `"user"` (`types/peers/user.d.ts:25`) — and
 * `Dialog.peer` is `User | Chat` (`types/peers/peer.d.ts:29`). `iterDialogs`
 * hands its values over as `unknown`, so this predicate is what carries one
 * across into the typed normalizer; it is deliberately partial, and
 * {@link normalizeDialog} still validates every field it reads.
 */
function isChatDialog(raw: unknown): raw is RawDialog {
  return asObject(asObject(raw)?.["peer"])?.["type"] === "chat";
}

/**
 * The runtime half of {@link RawDialog}: the type says the keys exist, but a
 * fixture reaches this module through a cast the compiler cannot check, so the
 * object itself is tested before its keys are read. Not a cast — a property
 * test, which is the only thing that can be honest about a value from JSON.
 */
function isDialogLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "peer" in value;
}

/**
 * What `normalizeDialog` reads out of one raw mtcute `Dialog`, taken from the
 * library's own class instead of restated by hand.
 *
 * This alias is the guarantee: the members below are mtcute's names with
 * mtcute's types, so `tsc --noEmit` fails the build when the library renames or
 * retypes one of them, rather than the seam silently defaulting every chat to
 * `null`/`false`/`0` with the suite still green. A structural `Pick` (rather
 * than `Dialog` itself) keeps the JSON fixtures castable at their own boundary
 * without inventing a second shape: a real `Dialog` satisfies it, and
 * `createClient` still proves that in one line.
 */
export type RawDialog = Pick<
  Dialog,
  | "peer"
  | "isMuted"
  | "isArchived"
  | "isPinned"
  | "unreadCount"
  | "isManuallyUnread"
  | "lastMessage"
>;

/**
 * One raw mtcute `Dialog` as a `ChatRecord`.
 *
 * Pure and total over anything Telegram can send; it throws only when the
 * value could not become a `ChatRecord` honestly — a peer that is not a chat,
 * or a `chatType` outside the six the core knows. Both are caller errors worth
 * naming loudly rather than mislabelling a chat into the wrong filter bucket.
 *
 * Field names are compile-checked through {@link RawDialog}; field values are
 * still validated here, because the one cast that gets a fixture this far is
 * outside the compiler's reach. `muted` carries the bit mtcute computed when
 * the dialog was read (the library resolves a mute's expiry against its own
 * clock), so a `ChatRecord` is not a clock-free snapshot.
 *
 * `manuallyUnread` is read from the same dialog as `unread`: Telegram badges a
 * chat as unread when the account marked it unread or it holds more than one
 * unread message (mtcute `Dialog.isUnread`), so the count alone cannot answer
 * `--unread` honestly.
 */
export function normalizeDialog(raw: RawDialog): ChatRecord {
  if (!isDialogLike(raw)) {
    throw new TypeError("normalizeDialog: expected a dialog object with a peer");
  }

  const peer = raw.peer;
  if (peer.type !== "chat") {
    throw new TypeError(
      `normalizeDialog: peer is not a chat (type ${JSON.stringify(peer.type)}); private chats cannot be left`,
    );
  }

  const id = asNumber(peer.id);
  if (id === null) {
    throw new TypeError("normalizeDialog: chat peer has no numeric id");
  }

  const chatType = asString(peer.chatType);
  if (chatType === null || !isChatType(chatType)) {
    throw new TypeError(`normalizeDialog: unknown chatType ${JSON.stringify(chatType)}`);
  }

  return {
    id,
    type: chatType,
    // `Chat.displayName` is the alias of `Chat.title` (chat.d.ts:164); accept
    // either spelling so a hand-built dialog is not a special case.
    title: asString(peer.displayName) ?? asString(peer.title) ?? "",
    username: asString(peer.username),
    members: asNumber(peer.membersCount),
    muted: asBoolean(raw.isMuted),
    archived: asBoolean(raw.isArchived) ?? false,
    pinned: asBoolean(raw.isPinned) ?? false,
    unread: asNumber(raw.unreadCount) ?? 0,
    manuallyUnread: asBoolean(raw.isManuallyUnread) ?? false,
    isScam: asBoolean(peer.isScam) ?? false,
    isFake: asBoolean(peer.isFake) ?? false,
    isVerified: asBoolean(peer.isVerified) ?? false,
    // `isBanned`/`isLikelyUnavailable` are getters on the peer we already hold,
    // so both are free: no extra request, no extra field to fetch.
    banned: asBoolean(peer.isBanned) ?? false,
    unavailable: asBoolean(peer.isLikelyUnavailable) ?? false,
    lastMessageAt: isoUtcOrNull(raw.lastMessage?.date),
  };
}
