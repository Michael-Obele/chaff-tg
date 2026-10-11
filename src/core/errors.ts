/**
 * The error taxonomy: every failure from Telegram becomes one of six kinds,
 * each carrying a plain sentence, a retry decision, and the exit code the run
 * adopts when that failure is the final word
 * (plan/architecture.md, "Error taxonomy"; plan/cli.md, "Exit codes").
 *
 * A taxonomy instead of letting errors bubble, because a bulk leave is unusual
 * account behaviour and Telegram answers it in a handful of very specific ways.
 * Each way needs a different answer (plan/safety.md, "Telegram's side of the
 * risk"):
 *
 * - a short flood wait is survivable, so pause and retry that one chat once;
 * - a long one is not, so stop and say how long instead of sleeping for an hour;
 * - `PEER_FLOOD` is Telegram asking the account to slow down, so stop and do not
 *   retry;
 * - a chat the account cannot leave is not a failure at all, so skip it and keep
 *   going;
 * - the network is retryable, so retry twice with backoff;
 * - anything else is recorded and stops the run, unless `--force` keeps going.
 *
 * `classify` is total: it never throws and never returns nothing, because the
 * one place it is called is a `catch` block, and an error thrown from inside a
 * `catch` handler loses the original failure.
 *
 * `retryable` means "the same chat is worth trying again". It is not "the
 * failure is harmless": a short flood wait is retryable but still has to be
 * waited out, and a skipped chat is harmless but never retried.
 */

/** The process exit codes, verbatim from plan/cli.md, "Exit codes". */
export const EXIT = {
  /** Success, including a clean dry run. */
  OK: 0,
  /** Unexpected error. */
  ERROR: 1,
  /** Bad usage, unknown flag, or conflicting flags. */
  USAGE: 2,
  /** Not logged in, or the session is unreadable. */
  NOT_LOGGED_IN: 3,
  /** Some leaves failed; the journal has the details. */
  PARTIAL: 4,
  /** Stopped because of a flood wait longer than the allowed maximum. */
  FLOOD: 5,
} as const;

/** The six ways a failure from Telegram is handled. */
export type ErrorKind =
  "flood-short" | "flood-long" | "peer-flood" | "skippable" | "network" | "unknown";

/** One failure, as a decision the leave loop can act on. */
export interface Classified {
  kind: ErrorKind;
  /** A plain sentence for the user: no stack trace, no error-code soup. */
  message: string;
  /** Whether retrying the same chat is the documented answer. */
  retryable: boolean;
  /** The exit code the run adopts when this failure is the final word. */
  exitCode: number;
  /** Seconds Telegram asked us to wait. Present on the two flood kinds only. */
  floodWaitSeconds?: number;
}

/** Options for {@link classify}. `force` is the CLI's `--force` flag. */
export interface ClassifyOptions {
  /** Keep going past an unrecognised error, recording it as a failure. */
  force?: boolean;
}

/** Anything longer than this many seconds stops the run instead of sleeping. */
const FLOOD_LIMIT_SECONDS = 60;

/** Telegram puts the wait inside the text, e.g. `FLOOD_WAIT_30`. */
const FLOOD_WAIT_RE = /FLOOD_WAIT_(\d+)/;

/** Codes that mean "this chat cannot be left": a skip, not a failure. */
const SKIPPABLE_CODES = ["CHANNEL_PRIVATE", "PEER_ID_INVALID", "CHAT_ADMIN_REQUIRED"] as const;

/** The transport shapes: Node/Bun error codes, and the words `fetch()` uses. */
const NETWORK_RE =
  /fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|connection reset|network error/i;

/**
 * Everything worth searching in a thrown value: the message, plus the messages
 * of any wrapped causes (`fetch()` on Bun puts the real transport code in
 * `cause`, so a bare `TypeError: fetch failed` is only diagnosable one level
 * down).
 *
 * Only a real `Error` is inspected. A thrown string or object is deliberately
 * left to `unknown`: nothing in mtcute throws a non-Error, so a non-Error is a
 * bug in a caller rather than an answer from Telegram, and pattern-matching its
 * text would turn a programming mistake into a flood pause.
 */
function searchableText(error: Error): string {
  const parts: string[] = [error.message || error.name];
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 3 && cause instanceof Error; depth++) {
    parts.push(cause.message || cause.name);
    cause = cause.cause;
  }
  return parts.join(" ");
}

/** A short, honest description of a thrown value that is not an `Error`. */
function describeThrown(value: unknown): string {
  if (typeof value === "string") return value.length > 0 ? value : "an empty string";
  if (typeof value === "object" && value !== null) return "a non-Error object";
  return String(value);
}

/**
 * Classify a thrown value into a decision. Total by construction: every path
 * returns an outcome, including the paths for values that are not `Error`s.
 */
export function classify(value: unknown, options: ClassifyOptions = {}): Classified {
  if (!(value instanceof Error)) return unrecognised(describeThrown(value), options);

  const text = searchableText(value);

  // PEER_FLOOD is checked before the flood wait: it is the "slow down" answer,
  // and it must never be answered with a retry
  // (plan/safety.md, "Telegram's side of the risk").
  if (text.includes("PEER_FLOOD")) {
    return {
      kind: "peer-flood",
      message:
        "Telegram is limiting this account (PEER_FLOOD). Stop the run and do not retry: retrying makes it worse.",
      retryable: false,
      exitCode: EXIT.FLOOD,
    };
  }

  if (text.includes("FLOOD_WAIT")) {
    const seconds = floodSeconds(text);
    // No number means no basis for a safe pause, so it is treated as the long
    // kind: stop and let the user decide, never sleep blind.
    if (seconds === undefined) return longFlood(undefined);
    return seconds > FLOOD_LIMIT_SECONDS ? longFlood(seconds) : shortFlood(seconds);
  }

  for (const code of SKIPPABLE_CODES) {
    if (text.includes(code)) {
      return {
        kind: "skippable",
        message: `Telegram says this chat cannot be left (${code}). Mark it skipped and keep going.`,
        retryable: false,
        exitCode: EXIT.OK,
      };
    }
  }

  if (NETWORK_RE.test(text)) {
    return {
      kind: "network",
      message:
        "The connection to Telegram failed. Retry twice, then record the failure and keep going.",
      retryable: true,
      exitCode: EXIT.PARTIAL,
    };
  }

  return unrecognised(text, options);
}

/** The seconds Telegram asked for, or `undefined` when the text carries no number. */
function floodSeconds(text: string): number | undefined {
  const match = FLOOD_WAIT_RE.exec(text);
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const seconds = Number.parseInt(digits, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** A short flood wait: pause, then retry that one chat once. */
function shortFlood(seconds: number): Classified {
  return {
    kind: "flood-short",
    message: `Telegram asked the account to wait ${seconds} seconds. Pause for that long, then retry once.`,
    retryable: true,
    exitCode: EXIT.OK,
    floodWaitSeconds: seconds,
  };
}

/** A flood wait too long to sleep through (or one with no number): stop, do not wait. */
function longFlood(seconds: number | undefined): Classified {
  const outcome: Classified = {
    kind: "flood-long",
    message:
      seconds === undefined
        ? "Telegram said to wait, but the reply carried no number. Stop instead of guessing how long."
        : `Telegram asked the account to wait ${seconds} seconds, which is past the ${FLOOD_LIMIT_SECONDS} second pause chaff-tg allows. Stop instead of waiting.`,
    retryable: false,
    exitCode: EXIT.FLOOD,
  };
  if (seconds !== undefined) outcome.floodWaitSeconds = seconds;
  return outcome;
}

/**
 * Anything we could not place: record it, then stop unless `--force` says to keep
 * going. With `--force` the failure is still recorded, so the run ends partial
 * (exit 4) rather than clean (exit 1 would stop the run).
 */
function unrecognised(text: string, options: ClassifyOptions): Classified {
  const forced = options.force === true;
  return {
    kind: "unknown",
    message: forced
      ? `Unrecognised error (${text}). Record the failure and keep going, because --force is set.`
      : `Unrecognised error (${text}). Record the failure and stop; --force keeps going past it.`,
    retryable: false,
    exitCode: forced ? EXIT.PARTIAL : EXIT.ERROR,
  };
}

/**
 * A classified failure, ready to be thrown or handed to a front end.
 *
 * `classify` returns a plain object; `ChaffError` is that object as an `Error`,
 * so it can travel through a `catch`, and so `instanceof ChaffError` tells a
 * caller that a failure has already been classified.
 */
export class ChaffError extends Error {
  /** One of the six taxonomy kinds. */
  readonly kind: ErrorKind;
  /** The exit code the run adopts if this failure is the final word. */
  readonly exitCode: number;
  /** Whether retrying the same chat is the documented answer. */
  readonly retryable: boolean;
  /** Seconds Telegram asked us to wait; present on the two flood kinds only. */
  readonly floodWaitSeconds: number | undefined;

  /**
   * @param classified the outcome of {@link classify}
   * @param options.cause the original thrown value, kept as `Error.cause`
   */
  constructor(classified: Classified, options: { cause?: unknown } = {}) {
    super(classified.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChaffError";
    this.kind = classified.kind;
    this.exitCode = classified.exitCode;
    this.retryable = classified.retryable;
    this.floodWaitSeconds = classified.floodWaitSeconds;
  }

  /** Classify a thrown value and wrap it, keeping the original as `cause`. */
  static from(value: unknown, options: ClassifyOptions = {}): ChaffError {
    return new ChaffError(classify(value, options), { cause: value });
  }
}
