/**
 * The pacer: the human-looking pause between leaves, the hard cap, and the
 * abort signal (plan/architecture.md, "Pacing, caps, and stopping";
 * plan/safety.md, "Telegram's side of the risk").
 *
 * Contract under test:
 * - The pause is `baseMs + (random() * 2 - 1) * jitterMs`: jitter is
 *   SYMMETRIC around the base, so a whole run stays inside
 *   `[baseMs - jitterMs, baseMs + jitterMs]`. `random` and `sleep` are
 *   injected, so these tests are deterministic and never really wait.
 * - Defaults are the documented ones: 1200 ms base (the plan builder's own
 *   `DEFAULT_DELAY_MS`), 400 ms jitter, cap 50.
 * - The cap is hard: the `maxLeave + 1`th `wait()` throws `PacerCapError`
 *   before it sleeps, and `maxLeave: 0` means no cap at all.
 * - `started` counts the pauses that were admitted; a refused pause claims
 *   nothing.
 * - An aborted signal rejects the wait. The default `sleep` clears its timer
 *   and rejects with an `AbortError`-shaped error, so an aborted run never
 *   hangs for the rest of the pause.
 */
import { describe, expect, test } from "bun:test";
import * as core from "../src/core";
import { Pacer, PacerCapError } from "../src/core/pacing";

/** One recorded `sleep` call: how long, and with which signal. */
interface SleepCall {
  ms: number;
  signal: AbortSignal | undefined;
}

/** A `sleep` that records every call and returns at once. It never waits. */
function recorder(): {
  calls: SleepCall[];
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
} {
  const calls: SleepCall[] = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    calls.push({ ms, signal });
    return Promise.resolve();
  };
  return { calls, sleep };
}

/** The single sleep call a lone `wait()` is expected to have made. */
function onlyCall(calls: SleepCall[]): SleepCall {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

/** Await a promise that must reject, and hand back the rejection value. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** Run a function and hand back what it threw, or `undefined` when it returned. */
function caught(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A sleep that never finishes on its own and rejects as soon as the signal aborts. */
function abortAwareSleep(signal: AbortSignal | undefined, onCall: () => void): Promise<void> {
  onCall();
  return new Promise<void>((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      { once: true },
    );
  });
}

describe("jitter", () => {
  test("the delay is base + (random * 2 - 1) * jitter, exactly", async () => {
    const samples: [number, number][] = [
      [0, 800],
      [0.25, 1000],
      [0.5, 1200],
      [0.75, 1400],
      [1, 1600],
    ];

    for (const [r, expected] of samples) {
      const { calls, sleep } = recorder();
      await new Pacer({ baseMs: 1200, jitterMs: 400, random: () => r, sleep }).wait();
      expect(onlyCall(calls).ms).toBe(expected);
    }
  });

  test("defaults to a 1200 ms base with ±400 ms of jitter", async () => {
    const { calls, sleep } = recorder();
    await new Pacer({ sleep }).wait();

    const { ms } = onlyCall(calls);
    expect(ms).toBeGreaterThanOrEqual(800);
    expect(ms).toBeLessThanOrEqual(1600);
  });

  test("100 injected samples all land inside [base - jitter, base + jitter]", async () => {
    // A tiny deterministic generator: it visits every residue mod 101, so the
    // 100 samples cover the whole band instead of clustering near the middle.
    let n = 0;
    const random = (): number => {
      n = (n * 37 + 11) % 101;
      return n / 101;
    };
    const recorded: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      recorded.push(ms);
      return Promise.resolve();
    };

    // maxLeave 0: this is about the band, not the cap.
    const pacer = new Pacer({ baseMs: 1200, jitterMs: 400, maxLeave: 0, random, sleep });
    for (let i = 0; i < 100; i++) await pacer.wait();

    expect(recorded).toHaveLength(100);
    for (const ms of recorded) {
      expect(ms).toBeGreaterThanOrEqual(800);
      expect(ms).toBeLessThanOrEqual(1600);
    }
    // The sweep really exercises the band, not just the middle of it.
    expect(Math.min(...recorded)).toBeLessThan(900);
    expect(Math.max(...recorded)).toBeGreaterThan(1500);
  });

  test("jitter 0 always sleeps exactly the base", async () => {
    const { calls, sleep } = recorder();
    const pacer = new Pacer({ baseMs: 1200, jitterMs: 0, sleep });

    await pacer.wait();
    await pacer.wait();

    expect(calls.map((call) => call.ms)).toEqual([1200, 1200]);
  });

  test("hands the abort signal to sleep", async () => {
    const abort = new AbortController();
    const { calls, sleep } = recorder();

    await new Pacer({ signal: abort.signal, sleep }).wait();

    expect(onlyCall(calls).signal).toBe(abort.signal);
  });
});

describe("caps", () => {
  test("the (maxLeave + 1)th wait throws before it sleeps", async () => {
    const { calls, sleep } = recorder();
    const pacer = new Pacer({ maxLeave: 3, sleep });

    await pacer.wait();
    await pacer.wait();
    await pacer.wait();
    const error = await rejection(pacer.wait());

    expect(error).toBeInstanceOf(PacerCapError);
    expect(calls).toHaveLength(3); // the refused wait never slept
    expect(pacer.started).toBe(3);
  });

  test("the default cap is 50, so the 51st wait is refused", async () => {
    const { calls, sleep } = recorder();
    const pacer = new Pacer({ sleep });

    for (let i = 0; i < 50; i++) await pacer.wait();
    const error = await rejection(pacer.wait());

    expect(error).toBeInstanceOf(PacerCapError);
    expect(calls).toHaveLength(50);
    expect(pacer.started).toBe(50);
  });

  test("maxLeave 0 means no cap", async () => {
    const pacer = new Pacer({ maxLeave: 0, sleep: () => Promise.resolve() });

    for (let i = 0; i < 100; i++) await pacer.wait();

    expect(pacer.started).toBe(100);
  });

  test("checkCapacity(n) throws only when started + n would pass the cap", async () => {
    const pacer = new Pacer({ maxLeave: 5, sleep: () => Promise.resolve() });

    expect(caught(() => pacer.checkCapacity(5))).toBeUndefined();
    expect(caught(() => pacer.checkCapacity(6))).toBeInstanceOf(PacerCapError);

    await pacer.wait();
    await pacer.wait();

    expect(caught(() => pacer.checkCapacity(3))).toBeUndefined();
    expect(caught(() => pacer.checkCapacity(4))).toBeInstanceOf(PacerCapError);
  });

  test("checkCapacity is a no-op when the cap is 0", () => {
    const pacer = new Pacer({ maxLeave: 0 });

    expect(caught(() => pacer.checkCapacity(10_000))).toBeUndefined();
  });

  test("started is 0 before any wait", () => {
    expect(new Pacer().started).toBe(0);
  });
});

describe("abort", () => {
  test("an aborted signal rejects the in-flight wait", async () => {
    const abort = new AbortController();
    let slept = 0;
    let sawSignal: AbortSignal | undefined;
    const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
      sawSignal = signal;
      slept++;
      return abortAwareSleep(signal, () => {});
    };

    const pacer = new Pacer({ signal: abort.signal, sleep });
    const waiting = pacer.wait();
    expect(sawSignal).toBe(abort.signal);
    expect(slept).toBe(1);

    abort.abort();
    const error = await rejection(waiting);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  test("an already aborted signal rejects before sleeping at all", async () => {
    const abort = new AbortController();
    abort.abort();
    const { calls, sleep } = recorder();
    const pacer = new Pacer({ signal: abort.signal, sleep });

    const error = await rejection(pacer.wait());

    expect((error as Error).name).toBe("AbortError");
    expect(calls).toHaveLength(0);
    expect(pacer.started).toBe(0); // a refused pause claims nothing
  });

  test("the default sleep honours the abort signal", async () => {
    const abort = new AbortController();
    // No injected sleep, and a base far longer than this test will live: the
    // timer must be cleared on abort, or the test would hang instead of fail.
    const pacer = new Pacer({ baseMs: 60_000, signal: abort.signal });

    const waiting = pacer.wait();
    abort.abort();
    const error = await rejection(waiting);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  test("the core barrel exports the pacing surface", () => {
    expect(core.Pacer).toBe(Pacer);
    expect(core.PacerCapError).toBe(PacerCapError);
  });
});
