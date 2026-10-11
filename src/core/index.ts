/**
 * chaff-tg core library.
 *
 * Pure domain logic. The core never imports from `src/cli` or `src/tui`,
 * and it never prints to stdout/stderr. Both front ends depend on this
 * package — never the reverse.
 */

/** Keep in sync with `package.json` "version"; asserted by test/smoke.test.ts. */
export const VERSION = "0.1.0";

//
// The plan surface: the plan builder and the types it produces. The filter
// engine and the manifest sit on either side of it and are imported straight
// from their own modules; this barrel grows as each seam lands.
//
export { applyExclude, buildPlan, DEFAULT_DELAY_MS, estimateSeconds } from "./plan";
export { Journal } from "./journal";
export type { ActionState, PendingChat, RunMode, RunRow } from "./journal";
export type { Account, Plan, PlanChat } from "./types";
