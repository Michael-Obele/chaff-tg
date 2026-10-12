/**
 * chaff-tg core library.
 *
 * Pure domain logic. The core never imports from `src/cli` or `src/tui`,
 * and it never prints to stdout/stderr. Both front ends depend on this
 * package — never the reverse.
 */

/** Keep in sync with `package.json` "version"; asserted by test/smoke.test.ts. */
export const VERSION = "0.2.0";

//
// The plan surface: the plan builder and the types it produces. The filter
// engine and the manifest sit on either side of it and are imported straight
// from their own modules; this barrel grows as each seam lands.
//
export { applyExclude, buildPlan, DEFAULT_DELAY_MS, estimateSeconds } from "./plan";
export { DEFAULT_SESSION, Journal } from "./journal";
export type {
  ActionRow,
  ActionState,
  PendingChat,
  PlannedChat,
  RunMode,
  RunRow,
  SettledRow,
} from "./journal";
export type { Account, Plan, PlanChat } from "./types";

//
// The safety seams: the pause between leaves (`Pacer`) and the decision every
// Telegram failure becomes (`classify`). Both are pure and both take their
// clock/randomness/sleep as injected callbacks, so neither reaches for a
// global and neither can be tested against real time.
//
export { ChaffError, classify, EXIT } from "./errors";
export type { Classified, ClassifyOptions, ErrorKind } from "./errors";
export { abortError, Pacer, PacerCapError } from "./pacing";
export type { PacerOptions } from "./pacing";

//
// The leave loop: the one function the CLI and the TUI both call
// (plan/architecture.md, "The TUI seam"). It owns the cap, the abort signal,
// the retry rules and the journal writes; a front end only reports what the
// callback hands it, and turns the returned facts into an exit code.
//
export { runLeave } from "./leave";
export type { LeaveClient, LeaveFailure, LeaveOptions, Progress, RunResult } from "./leave";

//
// Local state: where the session file lives, the modes it is born with, and the
// config file the run's defaults come from. The session file is the whole
// account, so the modes are set on creation and the credential is read from the
// environment first (plan/safety.md, "The session file").
//
export { ConfigError, DEFAULT_CONFIG, loadConfig, resolveCredentials } from "./config";
export type { Config, ConfigErrorCode, Credentials } from "./config";
export {
  ensureSecureDir,
  ensureSession,
  fileMode,
  removeSession,
  resolvePaths,
  sessionExists,
} from "./session";
export type { Paths } from "./session";
