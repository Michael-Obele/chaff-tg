# AGENTS.md — `web/`

The SvelteKit front end for chaff-tg. Read the repo root `AGENTS.md` first.

## Comment style

Short. A comment earns its place by saying **why**, never **what**.

- No prose header above code that already reads clearly.
- No restating a signature, a type, or the next line.
- A trap gets a comment because someone will hit it again — the one case worth length.
- `// ponytail:` marks a deliberate simplification and names its ceiling.

## What this is

A client-rendered SvelteKit app (`ssr = false`). The Telegram client runs in the browser via
`@mtcute/web`, and the MTProto session lives in IndexedDB — **Telegram never moves server-side**.

The only server code is the login gate (`src/hooks.server.ts`, `src/lib/server/auth.ts`), which is why
the deploy uses `@sveltejs/adapter-netlify`.

**Two logins, in this order.** `/` is gated by the admin account (Better Auth, seeded from
`CHAFF_APP_EMAIL`/`CHAFF_APP_PASSWORD`); only then does the Telegram flow appear. `/login` is the
only page outside the gate. "Sign out" closes both — the cookie _and_ the IndexedDB session.
Enforcement is in the server hook for the document and in `+page.svelte` for the SPA. Full story:
[`../docs/telegram-setup.md`](../docs/telegram-setup.md), section 3.

## Commands

```bash
bun install
bun run check             # svelte-check — 0 errors, 0 warnings
bun run build             # adapter-netlify → .netlify/functions + assets
bun run db:migrate        # bunx auth@latest migrate
bun run db:seed           # creates the one account from CHAFF_APP_EMAIL/PASSWORD
```

Run the dev server on the port named in `BETTER_AUTH_URL`, or `/api/auth/*` 404s:

```bash
exec bunx vite dev "$PWD" --port 5173
```

Restart it after editing `src/lib/server/auth.ts`: a running instance keeps the old options and
answers `INVALID_ORIGIN`.

Bun only. Never npm, yarn or pnpm.

## Environment

`web/.env` is the only env file; `web/.env.example` is its template. The long version of
this table — and the `[tg]` console trace that exists to debug it — is
[`../docs/telegram-setup.md`](../docs/telegram-setup.md).

| Name                                                    | Reaches        | Notes                                               |
| ------------------------------------------------------- | -------------- | --------------------------------------------------- |
| `CHAFF_API_ID`, `CHAFF_API_HASH`                        | the **bundle** | inlined by `vite.config.ts`; the browser needs them |
| `CHAFF_APP_EMAIL`, `CHAFF_APP_PASSWORD`                 | `db:seed`      | the single account                                  |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DATABASE_URL` | the **server** | never bundled                                       |

Three traps, all hit for real:

1. `loadEnv(mode, '.', 'CHAFF_')` takes a **prefix**, which is why the server secrets need
   `process.loadEnvFile` — the prefix filter excludes them.
2. `process.loadEnvFile` resolves against `process.cwd()`, the **repo root**. Pass an absolute path or
   it silently loads nothing.
3. `svelteKitHandler` matches `/api/auth` by comparing the request origin to `BETTER_AUTH_URL`. A
   wrong port gives a 404 and the HTML fallback, not an auth error. `hooks.server.ts` therefore
   dispatches on the path prefix instead.
4. `trustedOrigins` is **empty by default**. Better Auth rejects the `Origin` header of any
   credentialed POST that is not on the list — a correct `baseURL` alone still yields
   `INVALID_ORIGIN` and a login form that never succeeds. `auth.ts` sets it from `BETTER_AUTH_URL`.

A `DATABASE_URL` pasted with wrapping quotes is stripped in `auth.ts`; otherwise `pg` treats the
quote as part of the host and dials `127.0.0.1`.

## Sharing the core

Import pure modules directly: `@core/filters`, `@core/plan`, `@core/types`. There is no barrel — one
broke `svelte-check` for no gain.

Safe: `filters.ts`, `plan.ts`, `manifest.ts`, `pacing.ts`, `errors.ts`, `types.ts`.
Never: `config.ts`, `groups.ts`, `journal.ts`, `session.ts`, `telegram.ts` — filesystem, SQLite, TCP.

`filterRecords` returns **every** row with an `ok` flag; take the accepted set with `.filter(r => r.ok)`.

## Svelte 5

Runes only. `$derived` over `$effect`; effects are an escape hatch. Keyed `{#each}` blocks. `onclick`
not `on:click`. Snippets not slots. `$state.raw` for large read-only data such as a dialog list.

## Rules

- **One mtcute importer.** Exactly one file in `web/` may import `@mtcute/web`.
- **Core stays silent.** The UI renders state; shared code never prints. `src/lib/log.ts` is the
  single exception, and it is the browser trace, not core.
- **Admin before Telegram.** Nothing in the Telegram flow may render before `adminSession()` has
  answered; a new page that skips the gate reopens the deployment.
- **Leaving is gated.** Checkboxes → dry-run list → type `leave`. No flag or query parameter skips it.
- **No Telegram on the server.** Moving MTProto into a function reverses the design.

## Verifying

`svelte-check` and the build are the floor. Prove behaviour by driving the app — Playwright for the
repeatable journey, browser tools for console, network and WebSocket state. A string match is not
evidence.

## Out of scope

No TUI, no native app, no hosted session, no i18n, no accounts, no telemetry. Planning lives in
`../plan/web/`, gitignored.
