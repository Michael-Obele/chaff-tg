/**
 * Pacing: the pause between leaves, the cap on how many leaves a run may start,
 * and the abort signal that ends a run early
 * (plan/architecture.md, "Pacing, caps, and stopping").
 *
 * Telegram punishes fast, regular request patterns, so the pause is jittered
 * rather than fixed: `base + (random() * 2 - 1) * jitter`, symmetric around the
 * base, which turns a machine-regular cadence into a human-looking one
 * (plan/safety.md, "Telegram's side of the risk").
 *
 * Nothing here reads the clock. `random` and `sleep` are injected, with their
 * defaults defined at this boundary, so tests are deterministic and never
 * really wait. The one real `setTimeout` lives in `defaultSleep` and is cleared
 * when the signal aborts, so a run told to stop does not sit out the rest of a
 * pause before it can stop.
 *
 * The class keeps one number of state: how many pauses it has admitted.
 * `checkCapacity(n)` is the question the leave loop asks before planning work
 * ("is there room for n more?"), and `wait()` asks it for itself.
 */
import { DEFAULT_DELAY_MS } from "./plan";

/** The documented jitter width, in milliseconds (architecture, "Pacing, caps, and stopping"). */
const DEFAULT_JITTER_MS = 400;

/** The documented `--max-leave` default. `0` means no cap (plan/cli.md). */
const DEFAULT_MAX_LEAVE = 50;

/** How to pace a run. Every field is optional; the defaults are the plan's. */
export interface PacerOptions {
  /** Pause at the middle of the jitter band, in milliseconds. Defaults to `DEFAULT_DELAY_MS` (1200). */
  baseMs?: number;
  /** Half-width of the jitter band, in milliseconds. Defaults to 400. */
  jitterMs?: number;
  /**
   * Hard cap on how many pauses this pacer will admit. `0` means no cap: above
   * 20 selected chats the CLI asks for a typed confirmation instead
   * (plan/cli.md), and a user who confirmed an uncapped run gets one.
   */
  maxLeave?: number;
  /** Ends the run; an aborted signal rejects the in-flight wait. */
  signal?: AbortSignal;
  /** A `Math.random` substitute: a number in `[0, 1)`. */
  random?: () => number;
  /** A sleep substitute, for tests and for front ends that need to report progress. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Thrown by `wait()` and `checkCapacity()` when the next pause would pass `maxLeave`. */
export class PacerCapError extends Error {
  /** The cap that was hit. Never `0`: `0` means no cap. */
  readonly maxLeave: number;
  /** How many pauses had already been admitted when the cap was hit. */
  readonly started: number;

  constructor(maxLeave: number, started: number) {
    super(`max-leave cap reached: ${started} leaves already started, and the limit is ${maxLeave}`);
    this.name = "PacerCapError";
    this.maxLeave = maxLeave;
    this.started = started;
  }
}

/**
 * An `Error` shaped like an abort: `name === "AbortError"`.
 *
 * `AbortSignal.reason` is only set when a caller bothers to pass one, and a
 * bare `DOMException` would drag DOM types into a plain library, so the shape is
 * built here once for the default sleep and for the pacer's own checks.
 */
export function abortError(message = "the run was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * The real sleep: a `setTimeout` that is cleared when the signal aborts.
 *
 * Clearing the timer is the point. Without it, an abort in the middle of a
 * 1200 ms pause would leave a dangling timer behind (and keep the process
 * alive), instead of stopping the run now.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The pause between leaves, plus the cap and the abort signal.
 *
 * Create one per run and call `wait()` before each leave. This class is the only
 * thing that knows the pace: a front end never computes a delay itself.
 */
export class Pacer {
  /** The pause at the middle of the jitter band, in milliseconds. */
  readonly baseMs: number;
  /** The half-width of the jitter band, in milliseconds. */
  readonly jitterMs: number;
  /** The cap on admitted pauses; `0` means no cap. */
  readonly maxLeave: number;

  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly signal: AbortSignal | undefined;
  /** Pauses admitted so far. `started + n` is exactly what the cap guards. */
  private count = 0;

  constructor(options: PacerOptions = {}) {
    this.baseMs = options.baseMs ?? DEFAULT_DELAY_MS;
    this.jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
    this.maxLeave = options.maxLeave ?? DEFAULT_MAX_LEAVE;
    this.signal = options.signal;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** How many pauses this pacer has admitted so far. */
  get started(): number {
    return this.count;
  }

  /**
   * Is there room for `n` more leaves?
   *
   * Throws rather than returning a boolean, so a caller cannot forget to look at
   * the answer. `maxLeave: 0` disables the cap entirely, which is the plan's
   * "0 means no cap, and asks once for confirmation"; the asking is the CLI's
   * job in a later task, not the pacer's.
   */
  checkCapacity(n: number): void {
    if (this.maxLeave === 0) return;
    if (this.count + n > this.maxLeave) throw new PacerCapError(this.maxLeave, this.count);
  }

  /**
   * Pause once, for a jittered version of the base delay.
   *
   * The order is deliberate. An aborted signal stops the wait before anything is
   * counted or slept: a run that has been told to stop must not pace for one
   * more leave. Then the cap is checked (a refused pause claims nothing), then
   * the pause is admitted and taken.
   */
  async wait(): Promise<void> {
    if (this.signal?.aborted === true) throw abortError();
    this.checkCapacity(1);
    this.count += 1;
    await this.sleep(this.delay(), this.signal);
  }

  /**
   * One delay: `base + (random * 2 - 1) * jitter`, symmetric about the base.
   *
   * Left unrounded. `setTimeout` floors a fractional millisecond anyway, and
   * rounding here would only make the tests and the real timer disagree about
   * what the pacer asked for.
   */
  private delay(): number {
    return this.baseMs + (this.random() * 2 - 1) * this.jitterMs;
  }
}
