<div align="center">
  <img src="docs/banner.svg" alt="chaff-tg — leave the chaff behind" width="100%">
</div>

<br>

<div align="center">

[![License: MIT][badge-license]][license]
[![Bun][badge-bun]][bun]
[![Tests][badge-tests]](#development)
[![Local only][badge-local]](#safety)

</div>

<br>

> **chaff-tg acts on your real Telegram account and can leave dozens of chats in one
> run.** Start with `chaff list` and `chaff report`, read the report, and only then run
> `chaff leave`. Keep the session file it creates private; anyone with that file can use
> your account. Leaving many chats quickly can trigger Telegram's flood limits, so the
> default pace is deliberately slow.

Telegram has no bulk leave. Leaving one group takes five taps, and the people who need
it most — the ones who joined a hundred crypto or course channels and now get nothing but
noise — are the ones with hundreds to leave. There is no filter for "the group I have not
opened in a year" and no way to remove many at once.

chaff-tg does one job: it lists your dialogs, filters them, writes a review file you read
_before_ anything happens, then leaves the ones you confirm. It runs on your own machine
with your own account. **Nothing is sent to a server of ours.**

_Chaff_ is the part of the grain you throw away after winnowing. That is the whole idea.

```console
$ chaff list --muted --inactive-days 365
$ chaff report --muted --inactive-days 365 --md --out cleanup.md
$ $EDITOR cleanup.md
$ chaff leave --from plans/cleanup.json --yes
```

## Why local

Two hosted products already do this. Both want your account session handed to their
servers. The difference here is not a feature list — it is where the session lives and who
can read the code:

- **Local only.** The session never leaves your machine. No telemetry, no analytics, no
  crash reporting, no usage check.
- **Auditable.** One file talks to Telegram (`src/core/telegram.ts`); the core never
  prints. Read it.
- **Scriptable.** Every command speaks `--json`, and the review manifest is replayable.

## Install

This build runs from source. There is no published release or `curl` installer yet —
packaging, checksums, and CI are the next piece of work, and this README will not claim
they exist before they do.

```bash
git clone https://github.com/Michael-Obele/chaff-tg
cd chaff-tg
bun install
bun run src/cli/index.ts --help
```

Requires **Bun 1.4.0** or newer. Node is not supported. To put it on your `PATH` while it
is still a source checkout:

```bash
bun link          # then just: chaff list
```

## Setup

Telegram requires your own `api_id` and `api_hash` from
[my.telegram.org](https://my.telegram.org) (API development tools). There is deliberately
no built-in credential: a shared app id puts everyone's risk on one registration, and the
ban would land on your account, not ours.

```bash
export CHAFF_API_ID=123456
export CHAFF_API_HASH=0123456789abcdef0123456789abcdef
chaff login           # then the code Telegram sends you
chaff whoami
```

Or put them in `~/.config/chaff-tg/config.json`. `apiHash` belongs in the environment
rather than a file, but the config accepts both.

## The safe way to use it

Filters run against a local snapshot and write nothing. The flow is fixed: build a plan,
write the report, read it, then act.

```bash
chaff login

chaff list --muted --inactive-days 365          # look first
chaff report --muted --inactive-days 365 \
  --md --out cleanup.md                         # read this file

chaff leave --from plans/cleanup.json --dry-run # rehearse
chaff leave --from plans/cleanup.json --yes     # act
```

Dry run is the default. `--yes` is required to leave anything, and there is no flag
combination that skips both the confirmation and the cap.

The everyday path, no files:

```bash
chaff leave --keyword signal,vip,airdrop --type channel --yes
```

That still stops at the checklist and still respects the 50-chat cap. To skip the
checklist on purpose, name the set:

```bash
chaff leave --select -1001234567890,-1009876543210 --yes
```

## Commands

| Command         | What it does                                                    |
| --------------- | --------------------------------------------------------------- |
| `chaff login`   | Asks for the my.telegram.org credentials and stores the session |
| `chaff whoami`  | Shows the logged-in account and where the session file lives    |
| `chaff list`    | Lists dialogs as a table, with filters applied                  |
| `chaff report`  | Writes a review manifest (table, JSON, CSV or markdown)         |
| `chaff leave`   | Leaves the selected chats                                       |
| `chaff journal` | Shows what previous runs did                                    |
| `chaff doctor`  | Checks the local setup: paths, file modes, and config           |
| `chaff logout`  | Deletes the local session file                                  |
| `chaff tui`     | Reserved for the full-screen interface — **not in this build**  |

`chaff --help` prints every filter and option; the help is rendered from the same tables
the parser uses, so it cannot drift from what the CLI accepts.

Filters worth knowing: `--muted`, `--inactive-days <n>`, `--never-posted`, `--members
0-50`, `--scam`, `--fake`, `--type`, `-k/--keyword`, `-r/--regex`, `--archived`,
`--read`. Selection: `--max-leave <n>` (default 50), `--delay <ms>` (default 1200),
`--clear`, `--select`, `--from`, `--exclude` (wins over everything), `--include`.

## The review manifest

`chaff report` writes a file with a `why` list per chat naming the filters that matched
it. That is the difference between a list you trust and a list you re-check by hand.

```json
{
  "version": 1,
  "createdAt": "2026-10-11T13:04:00Z",
  "account": { "id": 1234567, "username": "example" },
  "filters": { "types": ["channel"], "muted": true, "inactiveDays": 365 },
  "summary": { "matched": 37, "estimatedSeconds": 44 },
  "chats": [
    {
      "id": -1001234567890,
      "type": "channel",
      "title": "Big Signals Premium",
      "username": "bigsignals",
      "muted": true,
      "isScam": true,
      "lastMessageAt": "2024-08-02T09:12:00Z",
      "unread": 412,
      "why": ["keyword:signal", "muted", "inactive:365d"]
    }
  ]
}
```

Replaying it re-resolves each chat against the live account, so a stale manifest cannot
silently act on the wrong thing. Unknown manifest versions are refused with a clear
message rather than guessed at.

## Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | Success, including a clean dry run                              |
| 1    | Unexpected error                                                |
| 2    | Bad usage, unknown flag, or conflicting flags                   |
| 3    | Not logged in, or the session is unreadable                     |
| 4    | Some leaves failed — the journal has the details                |
| 5    | Stopped because of a flood wait longer than the allowed maximum |

## Safety

**The session file is the whole account.** Anyone who has it can act as you without a
password, a code, or two-factor. Treat it like a private key.

- Stored at `~/.local/share/chaff-tg/<name>.session`, directory `700`, file `600`,
  created with those modes rather than fixed up afterwards.
- Never written to stdout, never printed under `--verbose`, never in a report or a
  manifest, never in an error message.
- `chaff logout` removes it, including the `-wal` and `-shm` side files, and the journal.

**Telegram's side of the risk**, stated plainly rather than reassuringly: bulk leaving is
unusual account behaviour. Telegram flood-limits nearly every method, and leaving many
chats quickly can trigger `FLOOD_WAIT` and, in the worst case, `PEER_FLOOD` — a temporary
restriction on contacting peers. The mitigations are pacing and patience: 1200 ms base
delay with ±400 ms jitter, every flood wait respected, `PEER_FLOOD` treated as a hard stop
rather than retried, and a run capped at 50.

The real fix for the root cause is a privacy setting, not this tool: set **"Who can add me
to groups"** to _My Contacts_ or _Nobody_ in Telegram's privacy settings, so the problem
stops growing while you clean up.

### What it will never do

| Never                                                   | Why                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| Report chats to Telegram                                | Outward-facing, affects other people's channels, v2 at the earliest      |
| Delete one-to-one chats                                 | They cannot be left, only deleted — more destructive, harder to undo     |
| Act without `--yes`                                     | Dry run is the default; there is no quiet mode                           |
| Leave a chat listed in `--exclude`                      | Applied last and wins over the checklist                                 |
| Exceed `--max-leave` silently                           | Above the cap needs a fresh, explicit confirmation                       |
| Send anything about your chats anywhere except Telegram | No telemetry, no analytics, no update check                              |
| Retry a flood wait forever                              | A long flood wait stops the run; ignoring it is how accounts get limited |

## Development

```bash
bun run test        # the suite, plus a guard that fails the run if it discovers zero tests
bunx tsc --noEmit   # typecheck
bunx prettier --check .
```

Three rules hold the design together, and the test suite enforces them:

1. **Core purity.** `src/core` never imports from `src/cli` or `src/tui`, and never prints
   to stdout. Progress travels through a callback, which is what makes the front ends
   replaceable.
2. **One Telegram seam.** Only `src/core/telegram.ts` imports `@mtcute/*`. Everything else
   talks to our own types, so a library change is a one-file patch.
3. **No network in tests.** The suite runs offline with no Telegram account, against a fake
   client selected by `CHAFF_FAKE=1`. A compiled binary is exercised the same way.

The layering is deliberate: a core library that knows nothing about terminals, with thin
front ends on top.

```text
src/core/    types, filters, plan, manifest, journal, session, telegram, pacing, errors
src/cli/     argument parsing, commands, renderers, checklist
test/        502 tests, offline, fixtures in place of an account
```

## Status

Built and green: the core library, all nine commands (except the TUI), the review
manifest, the resumable journal, the filter set, and the pacing/flood taxonomy.
**502 tests pass** with no network and no account.

Deferred, tracked, and not pretended otherwise: `chaff tui` (the full-screen OpenTUI front
end), and the build/install/CI work — the eight cross-compiled targets, the `curl`
installer, checksum verification, and the release workflows.

This is `0.x` until the filter set stops changing. The manifest has its own `version`
field, independent of the binary.

## License

MIT. See [LICENSE](LICENSE). It touches your account, so it should be readable.

[badge-bun]: https://img.shields.io/badge/bun-%E2%89%A51.4.0-000?style=flat-square
[badge-license]: https://img.shields.io/badge/license-MIT-blue?style=flat-square
[badge-local]: https://img.shields.io/badge/session-stays%20local-2ea043?style=flat-square
[badge-tests]: https://img.shields.io/badge/tests-502%20passing-2ea043?style=flat-square
[bun]: https://bun.com
[license]: LICENSE
