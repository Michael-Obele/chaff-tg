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
 * The mtcute client narrowed to the four methods this tool uses.
 *
 * Structural on purpose. The names are the library's own — `iterDialogs`
 * (`@mtcute/core/highlevel/client.d.ts:2153`), `leaveChat` (:1524) and `getMe`
 * (:5964), plus `destroy` (`@mtcute/bun/client.d.ts`) — so a real
 * `TelegramClient` satisfies this interface as written. `createClient` returns
 * one without a cast, which makes the type a checked statement about the
 * installed library rather than a description of it.
 */
export interface TelegramClientLike {
  /** `iterDialogs(params?)`: an async iterable of `Dialog`s, newest first. */
  iterDialogs(params?: unknown): AsyncIterable<unknown>;
  /** `leaveChat(chatId, { clear })`: leave one group, supergroup or channel. */
  leaveChat(chatId: unknown, params?: { clear?: boolean }): Promise<void>;
  /** `getMe()`: the authorized user. */
  getMe(): Promise<unknown>;
  /** `destroy()`: close the connection and release the session. */
  destroy(): Promise<void>;
}

/** Credentials and the stored session a real client needs. */
export interface ClientOptions {
  apiId: number;
  /** Never logged, never stored outside the config file (plan/safety.md). */
  apiHash: string;
  /** Where mtcute's SQLite storage keeps the account (`Paths.sessionPath`). */
  sessionPath: string;
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
 * `start()` is the connect step. On a live session it returns immediately:
 * mtcute's `start` calls `getMe` first and only falls through to the login
 * flow when the session is not authorized — and even then it throws
 * `MtArgumentError` rather than prompting, because we pass no phone or bot
 * token (`@mtcute/core/highlevel/methods/auth/start.js`). Deciding that there
 * is no session at all is the CLI's job.
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

  await client.start({});

  // The return statement is the structural check: this line stops compiling
  // the moment mtcute's surface drifts away from the seam.
  return client;
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
   * `limit` stops iterating as soon as that many records have been yielded —
   * a skipped chat does not consume a slot — and `0` yields nothing without
   * touching the client at all.
   */
  async *dialogs(opts: { limit?: number } = {}): AsyncIterable<ChatRecord> {
    const limit = opts.limit;
    if (limit !== undefined && limit <= 0) return;

    const params = limit === undefined ? {} : { limit };
    let seen = 0;
    for await (const raw of this.client.iterDialogs(params)) {
      if (!isChatDialog(raw)) continue;
      yield normalizeDialog(raw);
      seen += 1;
      if (limit !== undefined && seen >= limit) return;
    }
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
  "peer" | "isMuted" | "isArchived" | "isPinned" | "unreadCount" | "lastMessage"
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
 * `neverPosted` is deliberately absent, not `false`: finding out whether the
 * account ever posted in a chat costs one request per chat, so it is opt-in and
 * a later task fills it in.
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
    isScam: asBoolean(peer.isScam) ?? false,
    isFake: asBoolean(peer.isFake) ?? false,
    isVerified: asBoolean(peer.isVerified) ?? false,
    lastMessageAt: isoUtcOrNull(raw.lastMessage?.date),
  };
}
