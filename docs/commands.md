# chaff command reference

**Every command, every flag, every exit code, and what each one actually prints.**

> This page is the reference for using `chaff`. For install, credentials and the safety
> model, read [README.md](../README.md) first. `chaff` acts on your real Telegram account,
> and `chaff leave` is the only command that changes anything.

## Contents

- [How to read this page](#how-to-read-this-page)
  - [General options](#general-options)
- [Before the first command](#before-the-first-command)
- [Commands](#commands)
  - [login](#login)
  - [whoami](#whoami)
  - [list](#list)
  - [check](#check)
  - [report](#report)
  - [leave](#leave)
  - [journal](#journal)
  - [doctor](#doctor)
  - [logout](#logout)
  - [tui](#tui)
- [Filters](#filters)
- [Selection and pacing](#selection-and-pacing)
- [Output formats](#output-formats)
- [Exit codes](#exit-codes)
- [Environment variables](#environment-variables)
- [Config file](#config-file)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)
- [What this build does not do](#what-this-build-does-not-do)

## How to read this page

**Two ways to run it.** Once `bun link` has run, the command is `chaff`. From a source
checkout without linking, `bun run src/cli/index.ts` takes identical arguments, so
`chaff list --muted` and `bun run src/cli/index.ts list --muted` mean the same thing. This
page writes `chaff` throughout.

**`chaff --help` is the authority.** The help text is rendered from the same tables the
parser reads, so it cannot drift from what the CLI accepts. If this page and the help
disagree, the help is right.

**Filters are shared.** `list`, `report`, `leave` and `check` all read the same filter
flags. You filter once, the same way, everywhere. Filters combine with AND.

**Comments in examples** are written after `#` only where a line needs explaining. Copy
the command, not the comment.

### General options

These work on every command, before or after the command word.

| Option          | Effect                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-h, --help`    | Print the usage text and exit `0`. The version of the usage text is always the one this build actually accepts.                                                                                                                    |
| `-V, --version` | Print `chaff <version> (<commit>)` and exit `0`. A from-source run prints the version from `package.json` and the commit `dev`; a released binary prints the version of the tag it shipped under and the commit it was built from. |
| `--dry-run`     | Rehearse. This is the default for `leave`; the flag is a way of saying so out loud.                                                                                                                                                |
| `--run <id>`    | Only `journal` reads this: show the per-chat states of one run.                                                                                                                                                                    |

There is one version number in the project, `package.json`, and the git tag has to match
it: the release workflow refuses to build when the two disagree.

## Before the first command

You need one thing from Telegram: an `api_id` and an `api_hash` from
[my.telegram.org](https://my.telegram.org) (the app credentials, not your phone number).
The README's [Setup](../README.md#setup) section walks through creating them.

Then run `chaff login` once. It stores the account in a session file, and every other
command reuses it.

| Path                                      | What it holds                                                        | Mode                       |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| `~/.local/share/chaff-tg/default.session` | The account session. Anyone with this file can use your account.     | `600` in a `700` directory |
| `~/.local/share/chaff-tg/journal.db`      | What each leave run did, per chat: the resume log                    | `600`                      |
| `~/.config/chaff-tg/config.json`          | The credentials and the optional settings. Written by `chaff login`. | `600`                      |

Both paths follow `XDG_DATA_HOME` and `XDG_CONFIG_HOME` when those are set to absolute
paths.

## Commands

### login

```text
chaff login
```

Asks for the `api_id`, the `api_hash`, your phone number, the code Telegram sends you, and
your two-factor password if you have one. It writes the credentials to
`~/.config/chaff-tg/config.json` and the session to the data directory, then reports the
account it ended up with and exits `0`.

| Behaviour                        | Detail                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials from the environment | `CHAFF_API_ID` and `CHAFF_API_HASH` skip those two prompts. Nothing is written to the config file when both come from the environment. |
| Non-interactive shell            | With no terminal on both ends, `login` refuses and exits `3` instead of waiting for input that will never arrive.                      |
| Prompts                          | The phone, code and password prompts come from the Telegram client library, not from `chaff`.                                          |

`login` is the only writer of the config file. Keys already in the file are kept, so a
hand-written `session` or `maxLeave` survives.

### whoami

```text
chaff whoami [--json]
```

The account this session belongs to, and the session file it came from.

```text
item      value
id        1
username  chaff_tester
session   /tmp/chaffdoc/data/chaff-tg/default.session
```

Exits `0`. Under `--json` the document is `{ "id": …, "username": …, "session": … }`.

### list

```text
chaff list [filters] [--json|--csv|--md] [--out FILE] [--limit N] [--quiet] [-v]
```

Lists your dialogs, filtered, as a table. Reads only: nothing is left, nothing is written.

```text
Found 5 chats
   id  type        title               username       members  last        flags
-1001  channel     Signal Room         signalroom        4821  2024-08-02  muted unread:412 scam
-1002  supergroup  Crypto Chat Lounge  cryptolounge     15000  2025-01-15  muted archived verified
-1005  channel     «Крипта 🚀»         kripta             820  2024-12-25  muted unread:5
-1010  channel     Airdrop Alerts      airdropalerts      340  2025-11-01  muted
-1012  supergroup  VIP Signals Elite   vipsignals          99  2023-05-01  muted archived unread:8
```

Columns are always the same seven, in this order: `id`, `type`, `title`, `username`,
`members`, `last`, `flags`.

| Column    | Notes                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `members` | `-` when Telegram does not report a count. A missing count is not zero.                                                                                      |
| `last`    | The date of the last message, `-` when the chat is empty.                                                                                                    |
| `flags`   | `muted`, `archived`, `pinned`, `unread:<n>`, `unread-marked`, `scam`, `fake`, `verified`, `banned`, `unavailable`, separated by spaces. `-` when none apply. |

`--json` prints `{ "chats": [ … ] }` with the same seven keys per row, in the same order,
so a script and your eyes see the same data. `members` stays `null` in JSON, and `last` is
the full ISO timestamp rather than the date.

Private chats and bots are skipped: `chaff` only lists chats it can leave.

`--limit N` caps how many chats are gathered, not how many are printed. Use it on a large
account so the command returns quickly.

### check

```text
chaff check --id IDS | --from MANIFEST [--json|--csv|--md] [--out FILE] [--quiet] [-v]
```

Asks Telegram about chat ids you already have, and tells you which are still alive. Reads
only. Give it ids with `--id` (comma separated, the ids from `chaff list --json`), or point
`--from` at a manifest and it reads the ids out of that. You can pass both; the typed ids
come first.

```text
Checked 3 chats: 2 ok, 0 banned, 0 unavailable, 1 gone
            id  status  title
-1002919634257  ok      TikTok Storage
-1003587289513  ok      Ongoing Station
     -99999999  gone    -
```

| Status        | Meaning                                                                                                                | What to do                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `ok`          | Telegram still answers for the chat and this account can see it.                                                       | Nothing. Leave it if you want to.                           |
| `banned`      | Telegram returned it as forbidden: you are banned from it, or it was removed.                                          | Leave it. You are not a member any more.                    |
| `unavailable` | Telegram's wider judgement: banned, or a group you left, or a private channel you are no longer in.                    | Read the title before acting. This one has false positives. |
| `gone`        | The id cannot be resolved any more, either because the chat is deleted or because this account never had access to it. | Nothing to leave. Drop the id.                              |

`--json` prints `{ "chats": [ { "id", "status", "title" } ] }`, with `title` as `null` for a
gone chat rather than a dash.

Two things to know before you rely on it:

- **One request per id.** `check` is a question you ask about a short list, not something
  to run over a thousand ids. `--limit` does not apply.
- **It is the only way to find a banned chat.** Telegram removes the dialog when you are
  banned, so a banned chat does not appear in `chaff list` at all, and it has no member
  count either. On one 274 chat account, a full archived-inclusive listing contained zero
  banned or unavailable chats. `list --banned` is there for the rare case where Telegram
  still lists a forbidden peer; `check` is for the ids you kept.

Exits `0` for a completed report whatever it found, `2` when you give it no ids or a
manifest it cannot trust, and `1` for anything unexpected.

### report

```text
chaff report [filters] [--out FILE] [--json|--csv|--md]
chaff report --from MANIFEST [--out FILE] [--json|--csv|--md]
```

Builds the review manifest: the list of chats the filters accept, with the reason each one
was accepted. It leaves nothing. This is the step that makes `leave` reviewable.

```text
Found 5 chats, about 6s
Manifest written to /tmp/chaffdoc/cleanup.json
```

With no `--from`, `report` reads your dialogs, applies the filters, and prints the accepted
chats. With `--from` it reads a manifest back and prints it, opening no client at all, so
you can inspect a manifest anywhere.

A manifest looks like this:

```json
{
  "version": 1,
  "createdAt": "2026-10-12T15:33:27.899Z",
  "account": { "id": 1, "username": "chaff_tester" },
  "filters": { "muted": true },
  "summary": { "matched": 5, "estimatedSeconds": 6 },
  "chats": [
    {
      "id": -1001,
      "type": "channel",
      "title": "Signal Room",
      "username": "signalroom",
      "members": 4821,
      "muted": true,
      "archived": false,
      "pinned": false,
      "unread": 412,
      "manuallyUnread": false,
      "isScam": true,
      "isFake": false,
      "isVerified": false,
      "banned": false,
      "unavailable": false,
      "lastMessageAt": "2024-08-02T09:12:00.000Z",
      "why": ["muted"]
    }
  ]
}
```

`why` records which filters matched. That is the difference between a list you trust and a
list you re-check by hand.

**What `--out` receives depends on the format.** This is the one gotcha in the command:

| Format          | What lands in `--out`                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| default (table) | The manifest, and stdout shows the table.                                                    |
| `--json`        | The manifest, byte for byte. `chaff report --json > cleanup.json` is also a replayable file. |
| `--md`, `--csv` | The rendered table, not a manifest. Use these to read and paste, not to feed `--from`.       |

`--out` does not expand `~`. It writes exactly where you point it. A manifest records chat
titles and usernames, so keep it out of commits; when `--out` lands inside a git
repository, `report` says so on stderr and carries on.

A manifest `report` cannot parse exits `2` with the reason, because the file is yours to
fix.

### leave

```text
chaff leave [filters] [--dry-run | --yes] [--select IDS] [--from MANIFEST]
            [--max-leave N] [--delay MS] [--clear] [--force]
```

Leaves chats. This is the only command that changes your account, and the only one that
asks you to confirm.

**Dry run is the default.** Without `--yes`, nothing is left, whatever else you pass.

```text
$ chaff leave --muted --dry-run
dry run: would leave 5 chats, about 6s at a 1200ms pace
```

In a terminal, `--yes` shows the checklist first:

```text
        chat                type        members  last
[x]  1  Signal Room         channel        4821  2024-08-02  SCAM
[ ]  2  Crypto Chat Lounge  supergroup    15000  2025-01-15
[ ]  3  Family Group        group            12  2026-10-10
1 of 3 selected. Enter to confirm, q to quit, a to select all, a number toggles that chat.
```

Then a second gate, and then the work:

```text
About to leave 1 chats, about 1200ms apart, about 1s in total.
Press Enter to confirm, q to cancel:
left 1 of 1 chats (0 failed, 0 skipped), about 1s at a 1200ms pace
```

| Flag            | Effect                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--yes`         | Actually leave. Required for anything to happen.                                                                                                                              |
| `--dry-run`     | Rehearse. This is the default; passing it is a way of saying so out loud.                                                                                                     |
| `--select IDS`  | Skip the checklist and act on exactly these ids. Requires `--yes`.                                                                                                            |
| `--from FILE`   | Take the chats from a manifest written by `chaff report`. Each chat is re-resolved against the live account, so a chat that is gone is reported rather than silently skipped. |
| `--max-leave N` | Hard cap per run, default 50. `0` means no cap.                                                                                                                               |
| `--delay MS`    | Base pause between leaves, default 1200 ms, with jitter of plus or minus 400 ms.                                                                                              |
| `--clear`       | Also clear the chat history when leaving.                                                                                                                                     |
| `--force`       | Continue past the first failure instead of stopping.                                                                                                                          |

Three notes that matter more than the table:

- **Above 20 selected, the confirmation word is `leave`, typed out.** That is the last gate
  before a large run.
- **A machine format cannot host the checklist.** Under `--json`, `--csv` or `--md`, the
  checklist and the typed word are skipped by definition, so `--yes` is the only
  authorisation in play. Run the interactive path for a real review.
- **The pace is slow on purpose.** A fast, perfectly regular pattern is how an account gets
  flood limited. A long flood wait stops the run and exits `5`; the journal has the details
  and the next run continues where this one stopped.

Exit codes: `0` when everything settled, `4` when some leaves failed, `5` when a flood wait
stopped the run, `2` for a usage mistake, `3` when you are not logged in.

### journal

```text
chaff journal [--run ID] [--json|--csv|--md] [--out FILE]
```

What previous runs did.

```text
id  started                   mode   planned  left  failed
 1  2026-10-12T15:40:43.414Z  leave        1     1       0
```

```text
$ chaff journal --run 1
   id  title        state  error
-1001  Signal Room  left   -
```

Per chat, `state` is one of `pending`, `left`, `failed` or `skipped`. A chat is `skipped`
when Telegram says it cannot be left, for example `CHANNEL_PRIVATE` for a chat you are
banned from. Skips are not failures and do not change the exit code.

The journal is how a resumed run avoids leaving the same chat twice: a chat already marked
`left` or `skipped` in the same session is settled, and a later run will not touch it.

### doctor

```text
chaff doctor [--json]
```

What the local setup looks like: the resolved paths, the file modes, and whether the
session directory sits inside a git repository.

```text
item                value
data directory      /home/you/.local/share/chaff-tg
config file         /home/you/.config/chaff-tg/config.json
session file        /home/you/.local/share/chaff-tg/default.session
journal file        /home/you/.local/share/chaff-tg/journal.db
git repository      no
session name        default
session dir         (default)
max leave           50
delay               1200 ms
config api id       present
config api hash     present
env CHAFF_API_ID    absent
env CHAFF_API_HASH  absent
credentials         ready
```

`credentials` says `ready` only when both halves resolve, from the environment or the
config file. Run this first when something says you are not logged in.

`doctor` exits `0` even when it warns. A file mode looser than `600` is a warning, not a
failure, and `--quiet` silences it, which is a known rough edge rather than a design
choice.

### logout

```text
chaff logout [--yes]
```

Deletes the local session, so the machine no longer has access to the account. Asks for
confirmation unless you pass `--yes`.

```text
removed /home/you/.local/share/chaff-tg/default.session
removed /home/you/.local/share/chaff-tg/journal.db
```

It removes the session file, its `-wal` and `-shm` siblings, and the journal. It does not
remove the config file, so the credentials stay behind for the next `login`. Revoking the
session inside Telegram itself is a separate step; this command only removes your copy.

### tui

```text
chaff tui
```

The full screen interface is not in this build. The command prints one line saying so and
exits `0`.

## Filters

Every filter is off unless you pass it. Filters combine with AND; the words inside one flag
combine with OR.

| Flag                          | Matches                                         | Notes                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--type LIST`                 | Chat types                                      | `group` means the whole group family: a legacy group, a supergroup and a broadcast group. Also `supergroup`, `channel`, `gigagroup`, `monoforum`, `community`. Default: all.           |
| `-k, --keyword LIST`          | Title or username contains a word               | Case insensitive. Comma separated.                                                                                                                                                     |
| `-K, --any LIST`              | Same as `--keyword`                             | Kept for readability in scripts. `--keyword a,b` is already OR.                                                                                                                        |
| `--not LIST`                  | Title or username contains none of these        | Applies to title and username.                                                                                                                                                         |
| `-r, --regex PATTERN`         | Title matches a regular expression              | Case insensitive, applied after the keyword filters.                                                                                                                                   |
| `--id LIST`                   | Exactly these ids                               | Use the ids from `chaff list --json`.                                                                                                                                                  |
| `--muted`, `--not-muted`      | Mute state                                      | `--muted` means you muted it. A chat on the account default is neither.                                                                                                                |
| `--archived`, `--no-archived` | Archive state                                   | Archived chats are always gathered, so both directions work.                                                                                                                           |
| `--inactive-days N`           | No message for N days or more                   | An empty chat counts as inactive.                                                                                                                                                      |
| `--members RANGE`             | Member count inside a range, for example `0-50` | A missing count is excluded, never treated as zero. This is why `--members 0-0` cannot find a banned chat.                                                                             |
| `--scam`, `--fake`            | Telegram's own flags                            | Set on the chat by Telegram, not by you.                                                                                                                                               |
| `--banned`                    | Telegram returned the chat as forbidden         | You are banned from it, or it was removed. Rare in a listing: see [`check`](#check).                                                                                                   |
| `--unavailable`               | Telegram no longer lists it as available        | Wider than `--banned`: also a group you left or a channel you are no longer in.                                                                                                        |
| `--unread`, `--read`          | Telegram's own unread rule                      | A chat is unread when it is marked unread, or when it holds more than one unread message. A single unread message does not count, the same way it does not badge a dialog in Telegram. |
| `--pinned`, `--no-pinned`     | Pin state                                       | Pinned chats are shown but not pre-ticked in the checklist.                                                                                                                            |
| `--include LIST`              | Force these ids in                              | Survives every other filter.                                                                                                                                                           |
| `--exclude LIST`              | Never touch these ids                           | Applied last and wins over everything, including `--include` and the checklist.                                                                                                        |
| `--limit N`                   | Stop gathering after N chats                    | A pagination guard for a large account, not a print limit.                                                                                                                             |

Two filters are worth spelling out because they surprise people:

- **`--archived` and `--no-archived` both work**, because archived dialogs are gathered
  rather than hidden. Before you filter, `chaff` asks Telegram for both folders.
- **`--unread` follows Telegram's rule, not yours.** Exactly one unread message means
  Telegram shows the chat as read, and so does `chaff`.

## Selection and pacing

| Flag            | Default | Meaning                                                         |
| --------------- | ------- | --------------------------------------------------------------- |
| `--max-leave N` | 50      | Hard cap per run. `0` means no cap.                             |
| `--delay MS`    | 1200    | Base pause between leaves, with jitter of plus or minus 400 ms. |
| `--clear`       | off     | Also clear history when leaving.                                |
| `--select IDS`  | none    | Act on exactly these ids. Requires `--yes`.                     |
| `--from FILE`   | none    | Replay a manifest. `check` reads its ids instead.               |
| `--yes`         | off     | Actually perform the leaves.                                    |
| `--dry-run`     | implied | Rehearse. `--dry-run` beside `--yes` is a usage error.          |
| `--force`       | off     | Continue past the first failure instead of stopping.            |

## Output formats

| Flag            | Effect                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `--json`        | JSON on stdout, stable key order.                                          |
| `--csv`         | CSV with a header row.                                                     |
| `--md`          | A markdown table, for pasting into a note or an issue.                     |
| `--out FILE`    | Write the primary output to a file as well as stdout. `~` is not expanded. |
| `--quiet`       | Errors only.                                                               |
| `-v, --verbose` | One line per chat as it is processed.                                      |

**Where the notes go.** Under a machine format, the chatter (`Found 5 chats`, `dry run:
would leave …`, the progress lines) goes to stderr and stdout stays parseable. Without a
machine format, the notes and the table both go to stdout.

```bash
chaff list --json > chats.json           # only JSON on stdout
chaff list --json -v > chats.json 2> run.log   # notes and progress land in run.log
```

Nothing prints the `api_hash`, in any format, on any stream, at any verbosity.

## Exit codes

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | Success, including a clean dry run and a report that found nothing.               |
| `1`  | Unexpected error.                                                                 |
| `2`  | Bad usage: unknown flag, conflicting flags, or a manifest that cannot be trusted. |
| `3`  | Not logged in, or the session cannot be read.                                     |
| `4`  | Some leaves failed. The journal has the details.                                  |
| `5`  | Stopped by a flood wait longer than the allowed maximum.                          |

## Environment variables

| Variable              | Effect                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `CHAFF_API_ID`        | The app `api_id`. Wins over the config file for its half.                               |
| `CHAFF_API_HASH`      | The app `api_hash`. Wins over the config file for its half.                             |
| `XDG_DATA_HOME`       | Where the session and the journal live. Must be an absolute path.                       |
| `XDG_CONFIG_HOME`     | Where the config file lives. Must be an absolute path.                                  |
| `CHAFF_FAKE`          | Use the offline fake client instead of Telegram. Any value except `0`, `false` or `no`. |
| `CHAFF_FIXTURE`       | A directory holding `raw-dialogs.json` for the fake client.                             |
| `CHAFF_FAKE_FAILURES` | Script leave failures for the fake client: `chatId:error[:times]`, comma separated.     |

A half that is set but unusable, such as `CHAFF_API_ID=abc`, is an error rather than a
silent fallback.

## Config file

`~/.config/chaff-tg/config.json`, written by `chaff login`.

```json
{
  "apiId": 123456,
  "apiHash": "0123456789abcdef0123456789abcdef",
  "session": "default",
  "maxLeave": 50,
  "delayMs": 1200
}
```

| Key                   | Used for                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `apiId`, `apiHash`    | Opening the session. The environment wins for each half on its own.                                      |
| `session`             | The session file name, so one machine can hold several accounts.                                         |
| `sessionDir`          | Where the data directory lives. Expanded (`~` becomes your home) and used as-is.                         |
| `maxLeave`, `delayMs` | Accepted by the schema, **not applied yet**: the CLI still uses 50 and 1200 ms unless you pass the flag. |

## Recipes

### Take a first look

```bash
chaff list --muted --inactive-days 365
```

Everything you muted that has been quiet for a year. Change the number and run it again;
this command is free and writes nothing.

### Review, then leave, with a file you can read

```bash
chaff report --muted --inactive-days 365 --out cleanup.json   # the manifest
chaff report --from cleanup.json --md --out cleanup.md        # a table to read
$EDITOR cleanup.md                                            # your review
chaff leave --from cleanup.json --dry-run                     # rehearse
chaff leave --from cleanup.json --yes                         # act
```

Two `report` calls on purpose: the manifest is what `leave` eats, and the markdown is what
you read. Keep both out of git.

### Leave by hand-picked ids

```bash
chaff list --json --muted > muted.json
jq -r '.chats[] | select(.flags | index("scam")) | .id' muted.json | paste -sd, - > ids.txt
chaff leave --select "$(cat ids.txt)" --yes
```

`--select` skips the checklist, so `--yes` is doing all the work. Read the id list first.

### Check whether ids are still alive

```bash
chaff check --from cleanup.json
chaff check --from cleanup.json --json | jq -r '.chats[] | select(.status != "ok") | .id'
```

The second line is the one that matters before a replay: everything that is not `ok` is
either unusable or gone.

### Continue after a flood

```bash
chaff journal                 # find the run id and how far it got
chaff journal --run 3         # per chat states for that run
chaff leave --from cleanup.json --yes
```

Running the same manifest again continues the run: chats the journal already settled are
reported with their recorded state, and only the ones still `pending` are attempted.

### Practise without touching Telegram

```bash
CHAFF_FAKE=1 CHAFF_FIXTURE=test/fixtures bun run src/cli/index.ts list --muted
```

The fake client needs no credentials and no session, and every command works against it.
Point `CHAFF_FAKE_FAILURES` at a chat to rehearse the failure and flood paths.

## Troubleshooting

| Symptom                                                 | Cause and fix                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `chaff: command not found`                              | `bun link` has not run. Either run it once, or use `bun run src/cli/index.ts`.                                                           |
| `not logged in: there is no session file at …` (exit 3) | Run `chaff login`, or check `chaff doctor` for the path it looked at.                                                                    |
| `Found 0 chats`                                         | Filters are ANDed, so one narrow flag empties the list. Start from `chaff list` with no filters and add one at a time.                   |
| `--type group` returns nothing                          | It should not: `group` includes supergroups. Check the other filters, and check `--muted`, since most junk is muted rather than unmuted. |
| `list --banned` returns nothing                         | Expected. Telegram removes banned chats from your dialog list. Use `chaff check` with the ids instead.                                   |
| The checklist appears even though `--yes` was passed    | A terminal is attached. `--select` is the way to skip the checklist on purpose.                                                          |
| `--out` wrote markdown where a manifest was expected    | `--md` and `--csv` put the rendered table in `--out`. Only the default table format and `--json` write a manifest there.                 |
| Exit `4`                                                | Some leaves failed. `chaff journal --run ID` shows which, with the error.                                                                |
| Exit `5`                                                | A long flood wait stopped the run. Wait, then run the same command again; it resumes.                                                    |
| A path with `~` was not found                           | `--out` writes exactly where you point it. Only `sessionDir` expands `~`.                                                                |
| `chaff tui` does not open anything                      | The full screen interface is not in this build.                                                                                          |

## What this build does not do

- **No full screen interface.** `chaff tui` prints a note. The seam is in place for it.
- **No Telegram-wide discovery.** `chaff` works on the chats you already joined. Finding
  channels you are not in is a different feature.
- **No reports to Telegram.** Leaving is the only action, and it is never automatic.
- **No `--never-posted`.** It was removed: answering it costs one search request per chat,
  which is the flood risk the tool exists to avoid. `--inactive-days` and `--read` narrow
  the same field for free.
- **No Windows testing.** The session file modes are enforced on Linux and macOS.

## Related documents

| File                      | What it holds                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| [README.md](../README.md) | Install, credentials, the safety model, and the design summary.                                   |
| [AGENTS.md](../AGENTS.md) | The working rules for this repository.                                                            |
| `plan/`                   | The design record: `cli.md`, `architecture.md`, `safety.md`, `notes.md`. Local only, not tracked. |
