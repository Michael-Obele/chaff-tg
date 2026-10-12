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
5. **Bun APIs first, `node:` only where Bun leaves no choice.** Reach for
   `Bun.file`, `Bun.write`, `Bun.file().delete()`, `Bun.file().stat()`, `Bun.Glob`,
   `Bun.spawn`, `Bun.env`, `bun:sqlite` and the global `prompt()` before their
   `node:` equivalents. Bun's own boundary (`bun.com/docs/runtime/file-io`): the
   `Bun.file`/`Bun.write` APIs "are heavily optimized and are the recommended way
   to work with files in Bun", and for what they do not cover — "such as `mkdir`
   or `readdir`" — "Bun's implementation of `node:fs` is fast. Use `node:fs` for
   working with directories in Bun."

   What still imports `node:`, each measured on Bun 1.4.0 rather than assumed:
   directories (`mkdir`/`readdir`; no Bun API) · `existsSync` in `doctor.ts`
   (`Bun.file().exists()` is `false` for a directory, and `.git` may be one) ·
   creating a file _with_ a mode (`Bun.write` makes a `664` file and takes no mode;
   _reading_ one is `(await Bun.file(p).stat()).mode`) · `writeFileSync` in
   `output.ts` (the sink is sync by design, and `Bun.write` is async-only) ·
   `readFileSync` in `config.ts` (`loadConfig` is sync by design) · `node:path` and
   `node:os` (no Bun surface of their own) · `node:readline` in the checklist and
   `logout` (no Bun equivalent; single-line prompts use `prompt()`).
