/**
 * The Telegram seam: the pure dialog normalizer, and the thin wrapper over a
 * fake client (task 8 brief; plan/architecture.md, "The normalized record",
 * "The only file that talks to Telegram").
 *
 * Contract under test:
 * - `normalizeDialog` is pure — no client, no clock, no network — and maps the
 *   corrected mtcute facts (`dialog.peer`, `chat.chatType`, `chat.displayName`,
 *   `dialog.isMuted` possibly null, `chat.membersCount` possibly null,
 *   `dialog.lastMessage?.date` possibly absent) onto a `ChatRecord`. The opt-in
 *   `neverPosted` is deliberately left absent.
 * - It refuses what a `ChatRecord` cannot describe: a private chat has no
 *   `ChatType`, so it throws rather than inventing one, and `TelegramApi.dialogs`
 *   skips those before they reach it.
 * - `TelegramApi` is thin, so it is exercised over `test/fake-client.ts`. No test
 *   in this file opens a socket.
 */
import { describe, expect, test } from "bun:test";
import { EXIT, classify } from "../src/core/errors";
import {
  normalizeDialog,
  TelegramApi,
  type RawDialog,
  type TelegramClientLike,
} from "../src/core/telegram";
import type { ChatRecord } from "../src/core/types";
import { FakeClient as ShippedFakeClient } from "../src/fakes/client";
import { FakeClient, fakeRpcError, type FakeClientOptions } from "./fake-client";

type Raw = Record<string, unknown>;

const chats = (await Bun.file(
  new URL("./fixtures/dialogs.json", import.meta.url),
).json()) as ChatRecord[];

const raws = (await Bun.file(
  new URL("./fixtures/raw-dialogs.json", import.meta.url),
).json()) as Raw[];

/** The `peer` object of a fixture row, asserted rather than cast blind. */
function peerOf(raw: Raw): Record<string, unknown> {
  const peer = raw["peer"];
  if (typeof peer !== "object" || peer === null) throw new Error("fixture row has no peer");
  return peer as Record<string, unknown>;
}

/** The fixture row for a marked id; chats and the one user row share the lookup. */
function rawById(id: number): Raw {
  const row = raws.find((raw) => peerOf(raw)["id"] === id);
  if (row === undefined) throw new Error(`raw fixture row ${id} is missing`);
  return row;
}

/**
 * `raw-dialogs.json` is JSON, so its rows arrive untyped. This is the boundary
 * where a test tells the compiler which shape it is holding: `normalizeDialog`
 * declares its input in mtcute's own types and casts nothing itself.
 */
function asRawDialog(value: unknown): RawDialog {
  return value as RawDialog;
}

const byId = new Map(chats.map((chat) => [chat.id, chat]));

/** The raw rows the Task 2 fixture describes; the rest are this file's edge cases. */
const mirrored: Array<{ raw: Raw; expected: ChatRecord }> = [];
for (const raw of raws) {
  const id = peerOf(raw)["id"];
  const expected = typeof id === "number" ? byId.get(id) : undefined;
  if (expected !== undefined) mirrored.push({ raw, expected });
}

/**
 * The fixtures spell `lastMessageAt` without milliseconds; the seam emits
 * `Date#toISOString()`. Compare the instant, not the spelling.
 */
function canonicalLastMessage(chat: Omit<ChatRecord, "neverPosted">): ChatRecord {
  return {
    ...chat,
    lastMessageAt: chat.lastMessageAt === null ? null : new Date(chat.lastMessageAt).toISOString(),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** The value a promise rejects with; the failure list is the point of the fake. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

function apiOver(opts?: FakeClientOptions): { client: FakeClient; api: TelegramApi } {
  const client = new FakeClient(opts);
  return { client, api: new TelegramApi(client) };
}

describe("normalizeDialog", () => {
  test("the raw fixture covers every chatType Telegram reports", () => {
    const types = [...new Set(mirrored.map(({ expected }) => expected.type))].sort();
    expect(types).toEqual([
      "channel",
      "community",
      "gigagroup",
      "group",
      "monoforum",
      "supergroup",
    ]);
  });

  test("every raw chat row mirrors a dialogs.json record, or says it is extra", () => {
    const chatRows = raws.filter((raw) => peerOf(raw)["type"] === "chat");
    const extra = chatRows.filter((raw) => !byId.has(peerOf(raw)["id"] as number));
    expect(extra.map((raw) => peerOf(raw)["id"])).toEqual([-2002, -2003]);
  });

  for (const { raw, expected } of mirrored) {
    test(`normalizes ${expected.id} (${expected.type}) to its dialogs.json record`, () => {
      const { neverPosted: _neverPosted, ...want } = expected;
      expect(normalizeDialog(asRawDialog(raw))).toEqual(canonicalLastMessage(want));
    });
  }

  test("neverPosted is left absent: it costs one request per chat", () => {
    for (const raw of raws) {
      if (peerOf(raw)["type"] !== "chat") continue;
      expect(Object.hasOwn(normalizeDialog(asRawDialog(raw)), "neverPosted")).toBe(false);
    }
  });

  test("a chat with every optional property missing gets the documented defaults", () => {
    expect(normalizeDialog(asRawDialog(rawById(-2002)))).toEqual({
      id: -2002,
      type: "group",
      title: "Bare Minimum",
      username: null,
      members: null,
      muted: null,
      archived: false,
      pinned: false,
      unread: 0,
      isScam: false,
      isFake: false,
      isVerified: false,
      lastMessageAt: null,
    });
  });

  test("a last message without a date is not a timestamp", () => {
    expect(normalizeDialog(asRawDialog(rawById(-2003))).lastMessageAt).toBeNull();
  });

  test("a live client's Date is normalized to ISO 8601 UTC", () => {
    const raw = asRawDialog({
      ...rawById(-2002),
      lastMessage: { date: new Date("2026-10-11T09:30:00Z") },
    });
    expect(normalizeDialog(raw).lastMessageAt).toBe("2026-10-11T09:30:00.000Z");
  });

  test("a date the seam cannot read degrades to null instead of failing mid-listing", () => {
    const unreadable = asRawDialog({ ...rawById(-2002), lastMessage: { date: "yesterday" } });
    const invalid = asRawDialog({
      ...rawById(-2002),
      lastMessage: { date: new Date(Number.NaN) },
    });
    expect(normalizeDialog(unreadable).lastMessageAt).toBeNull();
    expect(normalizeDialog(invalid).lastMessageAt).toBeNull();
  });

  test("a missing title is an empty title, not a crash", () => {
    const raw = asRawDialog({ peer: { type: "chat", id: -3003, chatType: "group" } });
    expect(normalizeDialog(raw).title).toBe("");
  });
});

describe("normalizeDialog refuses what a ChatRecord cannot describe", () => {
  test("a private chat (user peer) is not a chat", () => {
    expect(() => normalizeDialog(asRawDialog(rawById(424242)))).toThrow(/not a chat/);
  });

  test("a dialog with no peer at all", () => {
    expect(() => normalizeDialog(asRawDialog({ isMuted: false, unreadCount: 3 }))).toThrow(
      /expected a dialog object with a peer/,
    );
  });

  test("a chat peer with no numeric id", () => {
    const raw = asRawDialog({ peer: { type: "chat", chatType: "group", displayName: "No Id" } });
    expect(() => normalizeDialog(raw)).toThrow(/no numeric id/);
  });

  test("a chatType outside the six the core knows is refused, not mislabelled", () => {
    const raw = asRawDialog({
      peer: { type: "chat", id: -3001, chatType: "forum", displayName: "New Kind" },
    });
    expect(() => normalizeDialog(raw)).toThrow(/unknown chatType/);
  });

  test("an absent chatType is refused too", () => {
    const raw = asRawDialog({ peer: { type: "chat", id: -3002, displayName: "Unlabelled" } });
    expect(() => normalizeDialog(raw)).toThrow(/unknown chatType/);
  });
});

describe("TelegramApi", () => {
  test("dialogs() normalizes every chat and skips private chats", async () => {
    const { client, api } = apiOver();
    const rows = await collect(api.dialogs());
    expect(rows.map((row) => row.id)).toEqual([...chats.map((chat) => chat.id), -2002, -2003]);
    expect(client.yields).toBe(raws.length);
  });

  test("dialogs({ limit }) stops iterating as soon as it has enough", async () => {
    const { client, api } = apiOver();
    const rows = await collect(api.dialogs({ limit: 2 }));
    expect(rows.map((row) => row.id)).toEqual([-1001, -1002]);
    expect(client.yields).toBe(2);
  });

  test("a skipped private chat does not consume a limit slot", async () => {
    // The 16th raw row is the user; the limit must still be filled by chats.
    const { client, api } = apiOver();
    const rows = await collect(api.dialogs({ limit: 16 }));
    expect(rows).toHaveLength(16);
    expect(rows.at(-1)?.id).toBe(-2002);
    expect(client.yields).toBe(17);
  });

  test("dialogs({ limit: 0 }) yields nothing and never asks the client", async () => {
    const { client, api } = apiOver();
    expect(await collect(api.dialogs({ limit: 0 }))).toEqual([]);
    expect(client.yields).toBe(0);
  });

  test("dialogs() ignores rows that are not dialog objects", async () => {
    const { api } = apiOver({ rawDialogs: [null, 42, "nope", rawById(-2002)] });
    expect((await collect(api.dialogs())).map((row) => row.id)).toEqual([-2002]);
  });

  test("an empty account yields an empty list", async () => {
    const { api } = apiOver({ rawDialogs: [] });
    expect(await collect(api.dialogs())).toEqual([]);
  });

  test("me() maps the client's user onto { id, username }", async () => {
    const { api } = apiOver({ account: { id: 7, username: "michael" } });
    expect(await api.me()).toEqual({ id: 7, username: "michael" });
  });

  test("me() keeps a null username", async () => {
    const { api } = apiOver({ account: { id: 8, username: null } });
    expect(await api.me()).toEqual({ id: 8, username: null });
  });

  test("me() rejects a client that reports no account id", async () => {
    const seam: TelegramClientLike = {
      async *iterDialogs() {},
      async leaveChat() {},
      async getMe() {
        return { username: "nameless" };
      },
      async destroy() {},
    };
    await expect(new TelegramApi(seam).me()).rejects.toThrow(/no account id/);
  });

  test("leave() forwards the clear flag and records the call", async () => {
    const { client, api } = apiOver();
    await api.leave(-1001, { clear: true });
    await api.leave(-1002);
    expect(client.attempts).toEqual([
      { chatId: -1001, params: { clear: true } },
      { chatId: -1002, params: {} },
    ]);
    expect(client.left).toEqual([-1001, -1002]);
  });

  test("destroy() closes the client", async () => {
    const { client, api } = apiOver();
    await api.destroy();
    expect(client.destroyed).toBe(true);
  });
});

describe("the fake client's failure script", () => {
  test("FLOOD_WAIT_90 is the flood the leave loop must refuse to sleep through", async () => {
    const { client } = apiOver({
      failures: [{ chatId: -1002, error: fakeRpcError("FLOOD_WAIT_90") }],
    });
    const outcome = classify(await rejection(client.leaveChat(-1002)));
    expect(outcome.kind).toBe("flood-long");
    expect(outcome.floodWaitSeconds).toBe(90);
    expect(outcome.retryable).toBe(false);
    // The exit code the process adopts when a long flood is the final word.
    expect(outcome.exitCode).toBe(EXIT.FLOOD);
    expect(outcome.exitCode).toBe(5);
  });

  test("a scripted RpcError carries the fields mtcute's does", () => {
    const error = fakeRpcError("FLOOD_WAIT_90");
    // The library's constructor builds the message from the raw text and
    // `fromTl` only then rewrites `.text`, so the raw form survives in
    // `.message` — which is where `classify` reads it.
    expect(error.message).toBe("Telegram API error 420: FLOOD_WAIT_90");
    expect(error.code).toBe(420);
    expect(error.text).toBe("FLOOD_WAIT_%d");
    expect(error.seconds).toBe(90);

    const peerFlood = fakeRpcError("PEER_FLOOD");
    expect(peerFlood.message).toBe("Telegram API error 400: PEER_FLOOD");
    expect(peerFlood.text).toBe("PEER_FLOOD");
    expect(peerFlood.seconds).toBeUndefined();
  });

  test("the test fake is the shipped one, with the fixtures wired in", () => {
    // `CHAFF_FAKE` runs a compiled binary, so the implementation ships; only
    // the fixture path is test-local (task 8 review, Important 4).
    expect(Object.getPrototypeOf(FakeClient)).toBe(ShippedFakeClient);
  });

  test("PEER_FLOOD and CHANNEL_PRIVATE classify the way the taxonomy expects", async () => {
    const peerFlood = apiOver({ failures: [{ chatId: -1003, error: fakeRpcError("PEER_FLOOD") }] });
    expect(classify(await rejection(peerFlood.client.leaveChat(-1003))).kind).toBe("peer-flood");

    const forbidden = apiOver({
      failures: [{ chatId: -1004, error: fakeRpcError("CHANNEL_PRIVATE") }],
    });
    expect(classify(await rejection(forbidden.client.leaveChat(-1004))).kind).toBe("skippable");
  });

  test("a scripted failure is consumed, so the documented retry can succeed", async () => {
    const { client } = apiOver({
      failures: [{ chatId: -1002, error: fakeRpcError("FLOOD_WAIT_90") }],
    });
    await rejection(client.leaveChat(-1002));
    await client.leaveChat(-1002);
    expect(client.attempts).toHaveLength(2);
    expect(client.left).toEqual([-1002]);
  });

  test("times: Infinity keeps failing, for the runs that must stop", async () => {
    const { client } = apiOver({
      failures: [{ chatId: -1002, error: fakeRpcError("PEER_FLOOD"), times: Infinity }],
    });
    await rejection(client.leaveChat(-1002));
    await rejection(client.leaveChat(-1002));
    expect(client.left).toEqual([]);
  });

  test("a chat with no scripted failure is left and recorded", async () => {
    const { client } = apiOver({
      failures: [{ chatId: -1002, error: fakeRpcError("PEER_FLOOD") }],
    });
    await client.leaveChat(-1005);
    expect(client.left).toEqual([-1005]);
  });
});
