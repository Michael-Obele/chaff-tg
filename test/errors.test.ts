/**
 * The error taxonomy: every failure from Telegram turned into a decision
 * (plan/architecture.md, "Error taxonomy"; plan/cli.md, "Exit codes";
 * plan/safety.md, "Telegram's side of the risk").
 *
 * Contract under test:
 * - One row per row of the architecture's taxonomy table, asserting the kind,
 *   whether the chat is worth retrying, and the exit code the run adopts when
 *   that row is the final word. The exit codes are written as literals here,
 *   not as `EXIT.*`, so the table really is the plan's table.
 * - Flood seconds are parsed out of the message (`FLOOD_WAIT_<n>`) and carried
 *   in `floodWaitSeconds`, so a caller can report the wait instead of sleeping
 *   through it.
 * - `classify` is total. It never throws: a thrown string, a thrown plain
 *   object, `null`, a number, anything that is not an `Error`, lands in
 *   `unknown` rather than crashing a `catch` block.
 * - `--force` changes the `unknown` row only, and never touches a flood wait.
 */
import { describe, expect, test } from "bun:test";
import * as core from "../src/core";
import { ChaffError, classify, EXIT } from "../src/core/errors";
import type { Classified, ErrorKind } from "../src/core/errors";

/** One row of the taxonomy table: what is thrown, and the decision it becomes. */
interface Row {
  /** The taxonomy row, named the way plan/architecture.md names it. */
  name: string;
  /** What a real caller would catch. */
  thrown: unknown;
  kind: ErrorKind;
  retryable: boolean;
  exitCode: number;
  /** Only the two flood rows carry this. */
  floodWaitSeconds?: number;
}

/** `plan/architecture.md`, "Error taxonomy", row by row. */
const ROWS: Row[] = [
  {
    name: "FLOOD_WAIT_X short",
    thrown: new Error("FLOOD_WAIT_30"),
    kind: "flood-short",
    retryable: true,
    exitCode: 0,
    floodWaitSeconds: 30,
  },
  {
    name: "FLOOD_WAIT_X long",
    thrown: new Error("FLOOD_WAIT_3600"),
    kind: "flood-long",
    retryable: false,
    exitCode: 5,
    floodWaitSeconds: 3600,
  },
  {
    name: "PEER_FLOOD",
    thrown: new Error("PEER_FLOOD"),
    kind: "peer-flood",
    retryable: false,
    exitCode: 5,
  },
  {
    name: "CHANNEL_PRIVATE",
    thrown: new Error("CHANNEL_PRIVATE"),
    kind: "skippable",
    retryable: false,
    exitCode: 0,
  },
  {
    name: "PEER_ID_INVALID",
    thrown: new Error("PEER_ID_INVALID"),
    kind: "skippable",
    retryable: false,
    exitCode: 0,
  },
  {
    name: "CHAT_ADMIN_REQUIRED",
    thrown: new Error("CHAT_ADMIN_REQUIRED"),
    kind: "skippable",
    retryable: false,
    exitCode: 0,
  },
  {
    name: "network down",
    thrown: new TypeError("fetch failed"),
    kind: "network",
    retryable: true,
    exitCode: 4,
  },
  {
    name: "anything else",
    thrown: new Error("SOMETHING_ELSE"),
    kind: "unknown",
    retryable: false,
    exitCode: 1,
  },
];

/** Thrown values that are not `Error`s and must still classify safely. */
const NOT_ERRORS: { name: string; thrown: unknown }[] = [
  { name: "a string", thrown: "boom" },
  { name: "an empty string", thrown: "" },
  { name: "a number", thrown: 42 },
  { name: "a boolean", thrown: true },
  { name: "null", thrown: null },
  { name: "undefined", thrown: undefined },
  { name: "a plain object", thrown: {} },
  { name: "an array", thrown: [] },
  // Deliberately unknown, not flood: only a real Error is pattern-matched, so a
  // look-alike object cannot turn a caller's bug into a flood pause.
  { name: "an object that looks like a flood error", thrown: { message: "FLOOD_WAIT_9" } },
];

describe("EXIT", () => {
  test("is exactly the table in plan/cli.md", () => {
    expect(EXIT).toEqual({ OK: 0, ERROR: 1, USAGE: 2, NOT_LOGGED_IN: 3, PARTIAL: 4, FLOOD: 5 });
  });
});

describe("classify: one row per row of the taxonomy", () => {
  for (const row of ROWS) {
    test(`${row.name} becomes ${row.kind}`, () => {
      const outcome: Classified = classify(row.thrown);

      expect(outcome.kind).toBe(row.kind);
      expect(outcome.retryable).toBe(row.retryable);
      expect(outcome.exitCode).toBe(row.exitCode);
      expect(outcome.message.length).toBeGreaterThan(0);
      if (row.floodWaitSeconds !== undefined) {
        expect(outcome.floodWaitSeconds).toBe(row.floodWaitSeconds);
      }
    });
  }

  test("every outcome carries the four documented fields, and nothing else", () => {
    const outcome: Classified = classify(new Error("SOMETHING_ELSE"));

    expect(Object.keys(outcome).sort()).toEqual(["exitCode", "kind", "message", "retryable"]);
  });
});

describe("flood waits", () => {
  test("60 seconds is still short, 61 seconds is long", () => {
    expect(classify(new Error("FLOOD_WAIT_60")).kind).toBe("flood-short");
    expect(classify(new Error("FLOOD_WAIT_61")).kind).toBe("flood-long");
  });

  test("the seconds are read out of the message", () => {
    expect(classify(new Error("FLOOD_WAIT_95")).floodWaitSeconds).toBe(95);
    expect(classify(new Error("FLOOD_WAIT_3600")).floodWaitSeconds).toBe(3600);
  });

  test("a flood code wrapped in the rest of the Telegram text is still caught", () => {
    const outcome = classify(new Error("[400 FLOOD_WAIT_17] too many requests"));

    expect(outcome.kind).toBe("flood-short");
    expect(outcome.floodWaitSeconds).toBe(17);
  });

  test("mtcute's FloodWaitError shape (a message plus seconds) classifies", () => {
    const error = Object.assign(new Error("FLOOD_WAIT_120"), { seconds: 120 });

    expect(classify(error)).toMatchObject({ kind: "flood-long", floodWaitSeconds: 120 });
  });

  test("a flood message with no number stops instead of guessing", () => {
    const outcome = classify(new Error("FLOOD_WAIT"));

    expect(outcome.kind).toBe("flood-long");
    expect(outcome.exitCode).toBe(5);
    expect(outcome.floodWaitSeconds).toBeUndefined();
  });
});

describe("network", () => {
  test("Bun's fetch failure (a TypeError whose cause holds the code) is network", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 149.154.167.51:443"), {
      code: "ECONNREFUSED",
    });
    const error = Object.assign(new TypeError("fetch failed"), { cause });

    const outcome = classify(error);
    expect(outcome.kind).toBe("network");
    expect(outcome.retryable).toBe(true);
    expect(outcome.exitCode).toBe(4);
  });

  test("the usual transport codes are network", () => {
    const texts = [
      "read ECONNRESET",
      "connect ETIMEDOUT 149.154.167.51:443",
      "getaddrinfo ENOTFOUND api.telegram.org",
      "socket hang up",
      "request to https://api.telegram.org failed, reason: EAI_AGAIN",
    ];

    for (const text of texts) {
      expect(classify(new Error(text)).kind).toBe("network");
    }
  });
});

describe("classify never throws", () => {
  for (const { name, thrown: value } of NOT_ERRORS) {
    test(`${name} is unknown, not a crash`, () => {
      const outcome = classify(value);

      expect(outcome.kind).toBe("unknown");
      expect(outcome.retryable).toBe(false);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.message.length).toBeGreaterThan(0);
    });
  }
});

describe("--force", () => {
  test("changes the unknown row only", () => {
    for (const row of ROWS) {
      const plain = classify(row.thrown);
      const forced = classify(row.thrown, { force: true });

      if (row.kind === "unknown") {
        expect(forced.kind).toBe("unknown");
        expect(forced.retryable).toBe(false);
        expect(forced.exitCode).toBe(EXIT.PARTIAL);
        expect(forced).not.toEqual(plain);
      } else {
        // Bit for bit the same: --force is documented to change the last row only.
        expect(forced).toEqual(plain);
      }
    }
  });

  test("never overrides a flood wait", () => {
    // Every flood row keeps its own exit code: the short wait stays 0 (it is
    // slept and retried), and both hard stops stay 5. --force cannot turn any
    // of them into "recorded and continue".
    const rows: [string, number][] = [
      ["FLOOD_WAIT_30", 0],
      ["FLOOD_WAIT_3600", 5],
      ["PEER_FLOOD", 5],
    ];

    for (const [text, exitCode] of rows) {
      expect(classify(new Error(text), { force: true }).exitCode).toBe(exitCode);
    }
  });
});

describe("ChaffError", () => {
  test("carries the kind and the exit code from a classification", () => {
    const outcome = classify(new Error("FLOOD_WAIT_30"));
    const error = new ChaffError(outcome);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ChaffError);
    expect(error.name).toBe("ChaffError");
    expect(error.kind).toBe("flood-short");
    expect(error.exitCode).toBe(0);
    expect(error.message).toBe(outcome.message);
  });

  test("from() classifies a thrown value and keeps it as the cause", () => {
    const thrown = new Error("PEER_FLOOD");
    const error = ChaffError.from(thrown);

    expect(error.kind).toBe("peer-flood");
    expect(error.exitCode).toBe(5);
    expect(error.cause).toBe(thrown);
  });

  test("from() takes --force, so an unknown error can be kept as a failure", () => {
    const error = ChaffError.from(new Error("WHAT_IS_THIS"), { force: true });

    expect(error.kind).toBe("unknown");
    expect(error.exitCode).toBe(EXIT.PARTIAL);
  });

  test("the core barrel exports the error surface", () => {
    expect(core.classify).toBe(classify);
    expect(core.ChaffError).toBe(ChaffError);
    expect(core.EXIT).toBe(EXIT);
  });
});
