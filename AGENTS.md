# AGENTS.md

Working agreement for anyone (human or agent) working on `chaff-tg`.

## Commands

- `bun run test` — run the suite (equals `bun test && bun scripts/check-tests.ts`,
  which fails the run if zero test files are discovered). **Must be green before every commit.**
- `bun run typecheck` — `bunx tsc --noEmit`, must be clean before every commit.
- `bunx prettier --write .` — format before every commit; CI checks with
  `bun run format:check`.
- Toolchain is Bun 1.4+ only. Never use `npm`/`yarn`/`pnpm` here — use
  `bun add`, `bun remove`, `bunx`.

## Rules

1. **No network in tests.** The suite runs offline with no real Telegram
   account. Mock at the core seam; `test/` must never open a socket.
2. **Core purity.** `src/core/` never imports from `src/cli/` or `src/tui/`,
   and never writes to stdout/stderr. Front ends depend on the core, never
   the reverse.
3. **mtcute lives in exactly one file.** `@mtcute/*` may only be imported by
   `src/core/telegram.ts`. Everything else talks to our own types.
4. **Destructive actions default to dry-run.** Anything that leaves or clears
   chats requires explicit confirmation; no flag combination may bypass it.
5. **Bun APIs first, `node:fs` for what Bun leaves to it.** Reach for `Bun.file`,
   `Bun.write`, `Bun.spawn`, `Bun.Glob` and `bun:sqlite` before their `node:`
   equivalents. Three things stay on `node:fs` because Bun has no equivalent and
   its own file I/O docs say to use `node:fs` for them: directories (`mkdir`,
   `readdir`), file modes (`open(path, "a", 0o600)` for the 600 session and
   config files), and synchronous reads (`loadConfig` is sync by design).
   `Bun.write` creates a file `664` and takes no mode, and `BunFile.exists()` is
   false for a directory, so neither can replace those.
