<div align="center">
  <img src="docs/banner.svg" alt="chaff-tg: leave the chaff behind" width="100%">
</div>

<br>

<div align="center">

**A local CLI that lists your Telegram chats, filters them, and leaves only the ones you confirm.**

[![License: MIT][badge-license]][license]
[![Bun][badge-bun]][bun]
[![Tests][badge-tests]](#testing)
[![Local only][badge-local]](#safety)

</div>

<br>

> **chaff-tg acts on your real Telegram account and can leave dozens of chats in one
> run.** Start with `chaff list` and `chaff report`, read the report, and only then run
> `chaff leave`. Keep the session file it creates private; anyone with that file can use
> your account. Leaving many chats quickly can trigger Telegram's flood limits, so the
> default pace is slow on purpose.

## Contents

- [Why this exists](#why-this-exists)
- [Why local](#why-local)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Install](#install)
- [Setup](#setup)
- [The safe way to use it](#the-safe-way-to-use-it)
- [Commands](#commands)
- [Filters and selection](#filters-and-selection)
- [The review manifest](#the-review-manifest)
- [Exit codes](#exit-codes)
- [Safety](#safety)
- [Development](#development)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Status](#status)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Documentation](#documentation)
- [License](#license)

## Why this exists

Telegram has no bulk leave. Leaving one group takes five taps, and the people with the
most to leave are the ones who joined a hundred crypto or course channels and now get
nothing but noise from them. There is no filter for "the group I have not opened in a
year", and no way to remove many at once.

chaff-tg does one job: it lists your dialogs, filters them, writes a review file you read
_before_ anything happens, then leaves the ones you confirm. It runs on your own machine,
with your own account. **Nothing is sent to a server of ours.**

_Chaff_ is the part of the grain you throw away after winnowing. That is the whole idea.

```console
$ chaff list --muted --inactive-days 365
$ chaff report --muted --inactive-days 365 --out cleanup.json
$ chaff report --from cleanup.json --md --out cleanup.md
$ $EDITOR cleanup.md
$ chaff leave --from cleanup.json --yes
```

## Why local

Two hosted products already do this. Both want your account session handed to their
servers. What makes this one different is where the session lives, and who can read the
code:

- **Local only.** The session never leaves your machine. No telemetry, no analytics, no
  crash reporting, no usage check.
- **Auditable.** One file talks to Telegram (`src/core/telegram.ts`), and the core never
  prints. Read that file and check for yourself.
- **Scriptable.** Every command speaks `--json`, and the review manifest is replayable.

## Requirements

| Requirement                                                     | Notes                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Bun](https://bun.com) 1.4.0 or newer                           | Node is not supported.                                            |
| Linux or macOS                                                  | The session file uses `700` and `600` modes. Windows is untested. |
| A Telegram account of your own                                  | There is no shared app credential.                                |
| An `api_id` and `api_hash` from [my.telegram.org][telegram-api] | Needed once, before the first login.                              |

[telegram-api]: https://my.telegram.org
[obtaining-api-id]: https://core.telegram.org/api/obtaining_api_id

## Quick start

From a source checkout:

```bash
git clone https://github.com/Michael-Obele/chaff-tg
cd chaff-tg
bun install
bun link                     # this is what puts `chaff` on your PATH
```

`bun link` is not optional: until it runs there is no `chaff` command, and every command
below fails with `command not found`. If you would rather not touch your global bun setup,
run `bun run src/cli/index.ts` in place of `chaff`; the arguments are identical.

Not a checkout? [Install from a release](#from-a-release) is one command, needs no clone
and no `bun link`, and you can skip the `cp` below because `chaff login` asks for the two
values itself.

Then log in and look before you touch anything:

```bash
cp .env.example .env                             # then fill in the two values
chaff login                                      # then the code Telegram sends you

chaff list --muted --inactive-days 365           # look first
chaff report --muted --inactive-days 365 --out cleanup.json
chaff report --from cleanup.json --md --out cleanup.md
$EDITOR cleanup.md                               # read this file
chaff leave --from cleanup.json --dry-run        # rehearse
chaff leave --from cleanup.json --yes            # act
```

`--out` writes the file exactly where you point it, and it does not expand `~`. A manifest
lists chat titles, so keep it out of commits; `chaff report` warns when `--out` lands
inside a git repository.

## Install

### From source

This build runs from source, and the clone in [Quick start](#quick-start) is the install.
To put `chaff` on your `PATH` while it is still a source checkout:

```bash
bun link          # then just: chaff list
```

You can also compile a standalone binary yourself. It needs no runtime on the machine that
runs it, and `--target` builds one target instead of all eight:

```bash
bun scripts/build.ts --target bun-linux-x64    # dist/chaff-bun-linux-x64
```

### From a release

One command on a fresh machine:

```bash
curl -fsSL https://raw.githubusercontent.com/Michael-Obele/chaff-tg/main/install.sh | sh
```

`install.sh` detects the OS and CPU, downloads the matching binary and `checksums.txt`,
verifies the sha256 before writing anything executable, and installs to
`~/.local/bin/chaff`. `--version <tag>` pins a release (for example `--version v0.1.0`),
`--dry-run` prints what it would do, and `--system` targets `/usr/local/bin` without ever
calling `sudo` on its own.

Releases are published, so that one-liner has something to fetch. Pushing a `v*` tag is
what starts `.github/workflows/release.yml`: it builds the eight targets, writes the
checksums, and re-downloads the published Linux binary to run it before anyone else does.

**The tag is the version.** `v0.2.0` is what the binaries report, because the release job
stamps the tag into the build, and the `gates` job refuses to build when the tag and
`package.json` disagree. That is what stops a release from shipping a `--version` nobody
can find. Which commit prefix earns which bump (`fix` a patch, `feat` a minor, `feat!` a
minor while `0.x`, a major from `1.0.0`) is written at the top of the workflow, next to the
four step release dance.

### macOS and Windows

There are no code signing certificates behind this, so both platforms warn first:

- **macOS.** Gatekeeper blocks an unsigned binary downloaded through a browser. Install
  with the `curl` one-liner instead, which skips the quarantine flag, or clear it once with
  `xattr -d com.apple.quarantine ~/.local/bin/chaff`.
- **Windows.** SmartScreen says "unknown publisher". Choose **More info**, then **Run
  anyway**, and check the download against `checksums.txt`.

### Uninstall

`rm ~/.local/bin/chaff`, or `bun unlink` if you installed with `bun link`. There is no
daemon, no service, no scheduled task, and no state anywhere else. `chaff logout` is what
deletes the session file.

## Setup

Telegram requires your own `api_id` and `api_hash` from the [my.telegram.org][telegram-api]
API development tools. There is no built-in credential on purpose: a shared app id puts
everyone's risk on one registration, and the ban would land on your account instead of
ours.

### Create your own api_id

Sign in at [my.telegram.org/apps][telegram-api] with the phone number of the account you
will be leaving chats with. The code arrives in your Telegram app. Then choose **API
development tools** and fill in the form. Nothing is reviewed and nothing has to be
approved, so the credentials appear the moment you submit.

| Field           | What to put there                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| **App title**   | Anything honest, such as `chaff-tg`.                                                                    |
| **Short name**  | 5 to 32 characters, letters and numbers only. `chafftg` works; spaces, hyphens, and underscores do not. |
| **URL**         | Leave it blank. It is optional, and nothing reads it.                                                   |
| **Platform**    | **Desktop**. It is a label in your app list; it does not change the credentials or the API you get.     |
| **Description** | One plain line, such as `A local CLI that reviews my Telegram chats and leaves the ones I confirm.`     |

Press **Create application**. The App configuration screen shows **App api_id** (a number)
and **App api_hash** (32 hex characters). Copy both.

Two things to know before you start:

- **One `api_id` per phone number**, which is the rule on [Telegram's API
  page][obtaining-api-id]. If this number already has an app registered, the form refuses a
  second one, so reuse the credentials you have. Any app id works for any account: the id
  identifies the application, not the account it logs in, so an id you created on another
  number of yours is fine.
- **`api_hash` is a secret**, like the session file `chaff login` writes. Anyone holding
  either one can act as you.

### Set the credentials

Copy the template and fill in your own two values:

```bash
cp .env.example .env
$EDITOR .env
```

Bun loads `.env` from the working directory, for `bun run src/cli/index.ts` and for a
compiled binary alike, so nothing has to be exported first. `.env` is in `.gitignore`,
because the hash is a secret.

Exporting them does the same thing:

```bash
export CHAFF_API_ID=123456
export CHAFF_API_HASH=0123456789abcdef0123456789abcdef
```

Then log in:

```bash
chaff login           # then the code Telegram sends you
chaff whoami
```

`chaff login` records the credentials it resolved, whether they came from `.env`, from the
environment, or from its own prompts, into `~/.config/chaff-tg/config.json`. That is what
makes `chaff list` work from any directory, because a `.env` is only found in the
directory a command runs in. The file is written for you, file mode `600` in a `700`
directory, so there is no reason to create it by hand:

```json
{
  "apiId": 123456,
  "apiHash": "0123456789abcdef0123456789abcdef"
}
```

The environment beats the file, one half at a time, and nothing resolves unless both halves
do. A half that is set but unusable (`CHAFF_API_ID=abc`) is an error, not a silent
fallback. Set neither and `chaff login` asks for the id, the hash, the phone number, and
the code. The file also takes `session`, `maxLeave`, `delayMs`, and `sessionDir`.

## The safe way to use it

Filters run against a local snapshot and write nothing. The order is fixed: build a plan,
write the manifest, read the review, then act.

```bash
chaff login

chaff list --muted --inactive-days 365                       # look first
chaff report --muted --inactive-days 365 --out cleanup.json  # the plan, replayable
chaff report --from cleanup.json --md --out cleanup.md       # read this file

chaff leave --from cleanup.json --dry-run                    # rehearse
chaff leave --from cleanup.json --yes                        # act
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

| Command         | What it does                                                      |
| --------------- | ----------------------------------------------------------------- |
| `chaff login`   | Asks for the my.telegram.org credentials and stores the session   |
| `chaff whoami`  | Shows the logged-in account and where the session file lives      |
| `chaff list`    | Lists dialogs as a table, with filters applied                    |
| `chaff check`   | Asks Telegram about chat ids you already have: ok, banned or gone |
| `chaff report`  | Writes a review manifest (table, JSON, CSV or markdown)           |
| `chaff leave`   | Leaves the selected chats                                         |
| `chaff journal` | Shows what previous runs did                                      |
| `chaff doctor`  | Checks the local setup: paths, file modes, and config             |
| `chaff logout`  | Deletes the local session file                                    |
| `chaff tui`     | Prints a note: the full-screen interface is **not in this build** |

`chaff --help` prints every filter and option; the help is rendered from the same tables
the parser uses, so it cannot drift from what the CLI accepts.

The full reference, with every flag, exit code, environment variable and worked recipe, is
in [`docs/commands.md`](docs/commands.md).

## Filters and selection

Filters worth knowing: `--muted`, `--inactive-days <n>`, `--members
0-50`, `--scam`, `--fake`, `--type`, `-k/--keyword`, `-r/--regex`, `--archived`,
`--read`. Two more are Telegram availability, not heuristics: `--banned` (the chat came back
forbidden) and `--unavailable` (wider: also groups you left). A banned chat is usually
deleted from your list, which is what `chaff check` is for.

Selection: `--max-leave <n>` (default 50), `--delay <ms>` (default 1200), `--clear`,
`--select`, `--from`, `--exclude` (wins over everything), `--include`.

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
| 4    | Some leaves failed. The journal has the details                 |
| 5    | Stopped because of a flood wait longer than the allowed maximum |

## Safety

**The session file is the whole account.** Anyone who has it can act as you without a
password, a code, or two-factor. Treat it like a private key.

- Stored at `~/.local/share/chaff-tg/<name>.session`, directory `700`, file `600`,
  created with those modes rather than fixed up afterwards.
- Never written to stdout, never printed under `--verbose`, never in a report or a
  manifest, never in an error message.
- `chaff logout` removes it, including the `-wal` and `-shm` side files, and the journal.

`chaff login` also writes `~/.config/chaff-tg/config.json` with your `api_id` and
`api_hash`, file mode `600` in a `700` directory. That file holds your _app_ credentials,
not your account: on its own it cannot act as you. `chaff doctor` reports each half as
present or absent without printing either. Keep it out of git anyway, especially if you
version-control your dotfiles.

**Telegram's side of the risk**: bulk leaving is unusual account behaviour. Telegram
flood-limits nearly every method, and leaving many chats quickly can trigger `FLOOD_WAIT`
and, in the worst case, `PEER_FLOOD`, a temporary restriction on contacting peers. The
mitigations are pacing and patience: 1200 ms base delay with ±400 ms jitter, every flood
wait respected, `PEER_FLOOD` treated as a hard stop rather than retried, and a run capped
at 50.

The real fix for the root cause is a privacy setting, not this tool: set **"Who can add me
to groups"** to _My Contacts_ or _Nobody_ in Telegram's privacy settings, so the problem
stops growing while you clean up.

### What it will never do

| Never                                                   | Why                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Report chats to Telegram                                | Outward-facing, affects other people's channels, v2 at the earliest             |
| Delete one-to-one chats                                 | They cannot be left, only deleted, which is more destructive and harder to undo |
| Act without `--yes`                                     | Dry run is the default; there is no quiet mode                                  |
| Leave a chat listed in `--exclude`                      | Applied last and wins over the checklist                                        |
| Exceed `--max-leave` silently                           | Above the cap needs a fresh, explicit confirmation                              |
| Send anything about your chats anywhere except Telegram | No telemetry, no analytics, no update check                                     |
| Retry a flood wait forever                              | A long flood wait stops the run; ignoring it is how accounts get limited        |

## Development

```bash
bun run test              # the suite, plus a guard that fails when zero tests are found
bun run typecheck         # bunx tsc --noEmit
bunx prettier --write .   # format (or: bun run format)
bun run build             # all eight release binaries (or: bun scripts/build.ts --target <name>)
bun scripts/build.ts --version 0.2.0   # stamp a version instead of reading package.json
bun run src/cli/index.ts list --muted   # run the CLI straight from source, no `bun link`
```

The last one is the source-run form of every `chaff` command in this README: the arguments
are identical. Add `CHAFF_FAKE=1 CHAFF_FIXTURE=test/fixtures` in front of it to run against
the fixture client instead of Telegram.

Three rules hold the design together, and the test suite enforces them:

1. **Core purity.** `src/core` never imports from `src/cli` or `src/tui`, and never prints
   to stdout. Progress travels through a callback, which is what makes the front ends
   replaceable.
2. **One Telegram seam.** Only `src/core/telegram.ts` imports `@mtcute/*`. Everything else
   talks to our own types, so a library change is a one-file patch.
3. **No network in tests.** The suite runs offline with no Telegram account, against a fake
   client selected by `CHAFF_FAKE=1`. A compiled binary is exercised the same way.

The layering is on purpose: a core library that knows nothing about terminals, with thin
front ends on top.

## Testing

```bash
bun run test
```

528 tests across 19 files, all offline. `bun run test` is `bun test` plus
`scripts/check-tests.ts`, a guard that fails the run when it discovers zero test files. It
is there because a suite that passes without running anything is worse than no suite.

The fake client is how the suite and CI run without an account. `CHAFF_FAKE=1` uses it
from the CLI, `CHAFF_FIXTURE` points it at a directory of fixtures, and
`CHAFF_FAKE_FAILURES` scripts failures (`chatId:error[:times]`, comma separated) so the
flood and skip paths can be tested without Telegram.

## Project layout

| Path           | What lives there                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`    | The library: types, filters, plan, manifest, journal, session, telegram, pacing, errors. It knows nothing about terminals. |
| `src/cli/`     | Argument parsing, the commands, the renderers, and the checklist.                                                          |
| `src/fakes/`   | The offline fake client used by the tests and by `CHAFF_FAKE=1` runs.                                                      |
| `test/`        | 18 files, 507 tests, no network, fixtures in place of an account.                                                          |
| `scripts/`     | The test-discovery guard, the release build, and the checksum writer.                                                      |
| `.github/`     | CI, and the release workflow that publishes on a tag.                                                                      |
| `install.sh`   | The release installer: detects the platform, verifies sha256, installs to `~/.local/bin`.                                  |
| `.env.example` | The template for `.env`, which holds your app credentials.                                                                 |
| `docs/`        | The banner and the [command reference](docs/commands.md).                                                                  |

## Status

Built and working: the core library, nine commands (`login`, `whoami`, `list`, `check`,
`report`, `leave`, `journal`, `doctor`, `logout`), the review manifest, the resumable
journal, the filter set, and the flood rules. 528 tests pass with no network and no
account.

Not done yet, and not pretended otherwise: `chaff tui`, where the command prints a note
instead of opening the full-screen OpenTUI interface.

The packaging is written and shipped: `scripts/build.ts` compiles all eight targets,
`install.sh` verifies sha256 before it writes anything executable, and
`.github/workflows/release.yml` publishes on a `v*` tag. The first release, `v0.1.0`,
shipped all eight binaries, so the seven targets other than Linux x64 are real release
builds and not a local promise.

The published release is `v0.1.1`. This tree is `0.2.0`: it adds `chaff check` and the
`--banned` and `--unavailable` filters, and it removes `--never-posted`, which could never
match a real account. Archived chats are now listed rather than silently hidden, so a bare
`chaff list` shows more than it did in `v0.1.1`. Check any saved manifest with
`chaff check --from` before replaying it.

This is `0.x` until the filter set stops changing. The manifest has its own `version`
field, independent of the binary.

## Troubleshooting

- **`not logged in` (exit 3).** Run `chaff login`. If you only want to try the commands,
  `CHAFF_FAKE=1` runs them offline against the fake client.
- **`this session is not signed in, and there is no terminal to sign in on` (exit 1).** The
  session file exists but was never signed in, and stdin is not a terminal, so `chaff`
  refuses to ask for a phone number and a code it could never receive. Run `chaff login` in
  a terminal, where the prompts work.
- **`no api id and api hash are configured` (exit 3).** Set `CHAFF_API_ID` and
  `CHAFF_API_HASH`, or put them in `~/.config/chaff-tg/config.json`.
- **`my.telegram.org` answers with a bare "ERROR" instead of creating the app.** Telegram
  refuses the form without saying why. Check the short name first, then make the title and
  the short name less ordinary, because a plain dictionary word is a common rejection. A
  private window with content blockers off helps sometimes, and it often clears up on its
  own within a day. This is a known failure that people have been reporting for years with
  no answer from Telegram, so it may just be closed to you for now. Two things that work
  around it: use an app id you already have, and remember the id does not have to come
  from the number you log in with.
- **The run stopped on a flood wait (exit 5).** Telegram asked for a wait longer than the
  60 seconds chaff-tg is willing to sleep. Wait it out, then run the same command again;
  the journal resumes the unfinished run.
- **`a machine output format (--json, --csv or --md) cannot ask which chats to leave`
  (exit 2).** Name the set with `--select <ids>`, or replay a reviewed manifest with
  `--from <file>`. Without either, drop the format flag and answer the checklist.
- **`chaff tui` prints a note and exits.** That is all it does in this build.
- **Where are my files?** Sessions and the journal live in `~/.local/share/chaff-tg/`, and
  the optional config is `~/.config/chaff-tg/config.json`. Both follow `XDG_DATA_HOME` and
  `XDG_CONFIG_HOME` when those are set to absolute paths.
- **Anything else.** Run `chaff doctor`. It reports the resolved paths, the file modes, and
  whether the config and the credentials are present.

## Contributing

Read `AGENTS.md` first. It is the working agreement for the repository, and it applies to
agents as much as to people. Before every commit:

```bash
bun run test
bun run typecheck
bunx prettier --write .
```

Keep `@mtcute/*` inside `src/core/telegram.ts`, keep `src/core` free of front-end imports,
and never open a socket from `test/`.

## Documentation

| Document                               | What it holds                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`docs/commands.md`](docs/commands.md) | The command reference: every command, every flag, every exit code, the environment variables, and recipes you can copy. |
| `plan/` (local, untracked)             | The design record: `cli.md`, `architecture.md`, `safety.md`, `notes.md`.                                                |

The doc comments are the documentation for the code itself. Every file in `src/core/` opens
with the decision it embodies, in plain sentences, next to the code that makes it. Start
with `src/core/errors.ts` for the error rules and `src/cli/commands/leave.ts` for the safety
gates.

## License

MIT. See [LICENSE](LICENSE). It touches your account, so the code should be readable.

[badge-bun]: https://img.shields.io/badge/bun-%E2%89%A51.4.0-000?style=flat-square
[badge-license]: https://img.shields.io/badge/license-MIT-blue?style=flat-square
[badge-local]: https://img.shields.io/badge/session-stays%20local-2ea043?style=flat-square
[badge-tests]: https://img.shields.io/badge/tests-507%20passing-2ea043?style=flat-square
[bun]: https://bun.com
[license]: LICENSE
