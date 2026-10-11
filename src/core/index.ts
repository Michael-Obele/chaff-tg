/**
 * chaff-tg core library.
 *
 * Pure domain logic. The core never imports from `src/cli` or `src/tui`,
 * and it never prints to stdout/stderr. Both front ends depend on this
 * package — never the reverse.
 */

/** Keep in sync with `package.json` "version"; asserted by test/smoke.test.ts. */
export const VERSION = "0.1.0";
