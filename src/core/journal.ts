/**
 * The resume journal: one SQLite database per chaff-tg data directory that
 * records every planned leave as it happens, so an interrupted run can be
 * continued without leaving the same chat twice
 * (plan/architecture.md, "Session and journal").
 *
 * Two tables, exactly as the architecture pins them: `runs` (one row per
 * invocation) and `actions` (one row per chat, `primary key (run_id,
 * chat_id)`). The primary key plus an upsert is what makes marking idempotent:
 * a chat can be marked `pending`, then `left`, then retried as `left` again,
 * and there is still exactly one row. `runs.left` and `runs.failed` are
 * denormalized counters maintained by recomputing them from `actions` inside
 * the same transaction as the write, so a repeated mark cannot double count.
 *
 * `runs.filters` holds the manifest filters as JSON text. The journal never
 * parses them: `startRun` takes the already-serialized string and stores it
 * verbatim, so the one place that owns the manifest format stays the one place
 * that owns it.
 *
 * Core rules hold (plan/architecture.md, "Repo layout"): this module never
 * imports from `src/cli` or `src/tui`, and it never writes to stdout/stderr.
 * Progress is the caller's to report.
 *
 * Clock: the instance is handed a clock by `open` and only ever asks *it* for
 * the time. The `() => new Date()` default lives at the factory boundary, so
 * tests inject a fixed clock and every recorded `started_at`, `at` and
 * `finished_at` is deterministic. Nothing in the class calls `Date.now()`.
 *
 * Files (plan/safety.md, "Local privileges and files"): the journal sits next
 * to the session file and records chat titles and ids, so `open` creates the
 * parent directory mode 700 and the database file mode 600. Both are created
 * *with* those modes rather than chmod-ed afterwards; an existing directory is
 * left exactly as the user made it.
 */
import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** The state of one chat in one run (architecture, the `actions` table). */
export type ActionState = "pending" | "left" | "failed" | "skipped";

/** What a run does: a rehearsal (`dry-run`) or real leaves (`leave`). */
export type RunMode = "dry-run" | "leave";

/** One run as the front ends read it (`chaff journal`, plan/cli.md). */
export interface RunRow {
  id: number;
  /** ISO 8601 UTC, from the injected clock. */
  startedAt: string;
  /** ISO 8601 UTC, or `null` while the run is unfinished. */
  finishedAt: string | null;
  mode: RunMode;
  /** How many chats the run set out to touch. */
  planned: number;
  /** Derived from `actions`: rows currently marked `left`. */
  left: number;
  /** Derived from `actions`: rows currently marked `failed`. */
  failed: number;
}

/** One chat still to act on, in plan order. */
export interface PendingChat {
  id: number;
  title: string;
}

/** The `runs` and `actions` tables, verbatim from plan/architecture.md. */
const SCHEMA = `
create table if not exists runs (
  id            integer primary key,
  started_at    text not null,
  finished_at   text,
  mode          text not null,        -- dry-run | leave
  filters       text not null,        -- the manifest filters, as json
  planned       integer not null,
  left          integer not null default 0,
  failed        integer not null default 0
);

create table if not exists actions (
  run_id        integer not null references runs(id),
  chat_id       integer not null,
  title         text not null,
  state         text not null,        -- pending | left | failed | skipped
  error         text,
  at            text,
  primary key (run_id, chat_id)
);
`;

/** One `runs` row as SQLite returns it. */
interface RunDbRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  mode: string;
  planned: number;
  left: number;
  failed: number;
}

/** Rename the snake_case columns into the shape the front ends read. */
function toRunRow(row: RunDbRow): RunRow {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    mode: row.mode as RunMode,
    planned: row.planned,
    left: row.left,
    failed: row.failed,
  };
}

/**
 * Create `dir` (and any missing parent) mode 700.
 *
 * `recursive` + `mode` means only the directories this call actually creates
 * get 700 -- a directory that already exists is never re-chmod-ed, which keeps
 * "created with those modes" true instead of "fixed up afterwards".
 */
function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Create the database file mode 600 if it is not there yet.
 *
 * Flag `"a"` (not `"w"`) is load-bearing: it creates a missing file but never
 * truncates an existing journal. When the file is created, mode 600 is
 * requested at creation time; when it already exists its mode is untouched.
 */
function ensureSecureFile(path: string): void {
  closeSync(openSync(path, "a", 0o600));
}

/** The shape of one recorded action, as the transaction wrapper takes it. */
type RecordAction = (
  runId: number,
  chatId: number,
  title: string,
  state: ActionState,
  error: string | null,
  at: string,
) => void;

/** The resume log. One instance per process; one row per planned chat. */
export class Journal {
  readonly #db: Database;
  readonly #now: () => Date;
  readonly #upsertAction: ReturnType<Database["query"]>;
  readonly #recount: ReturnType<Database["query"]>;
  readonly #listRuns: ReturnType<Database["query"]>;
  readonly #latestUnfinished: ReturnType<Database["query"]>;
  readonly #pending: ReturnType<Database["query"]>;
  /** The upsert and its counter refresh, committed as one unit of work. */
  readonly #record: RecordAction;
  #closed = false;

  private constructor(db: Database, now: () => Date) {
    this.#db = db;
    this.#now = now;

    this.#upsertAction = db.query(
      `insert into actions (run_id, chat_id, title, state, error, at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (run_id, chat_id) do update set
         title = excluded.title,
         state = excluded.state,
         error = excluded.error,
         at    = excluded.at`,
    );

    // Recomputed from `actions`, never incremented: that is what makes a
    // repeated mark idempotent instead of a double count.
    this.#recount = db.query(
      `update runs set
         left   = (select count(*) from actions where run_id = ? and state = 'left'),
         failed = (select count(*) from actions where run_id = ? and state = 'failed')
       where id = ?`,
    );

    this.#listRuns = db.query(
      `select id, started_at, finished_at, mode, planned, left, failed
       from runs order by id`,
    );

    this.#latestUnfinished = db.query(
      `select id, started_at, finished_at, mode, planned, left, failed
       from runs where finished_at is null order by id desc limit 1`,
    );

    this.#pending = db.query(
      `select chat_id as id, title from actions
       where run_id = ? and state = 'pending' order by rowid`,
    );

    const record: RecordAction = (runId, chatId, title, state, error, at) => {
      this.#upsertAction.run(runId, chatId, title, state, error, at);
      this.#recount.run(runId, runId, runId);
    };
    this.#record = this.#db.transaction(record);
  }

  /**
   * Open (or create) the journal at `path` and bring the schema up.
   *
   * Creates the parent directory mode 700 and the file mode 600 before SQLite
   * touches either. `now` is the injected clock; the default is the only place
   * a real clock is read, and it lives here at the boundary. Reopening an
   * existing journal is safe and loses nothing (`create table if not exists`
   * plus a non-truncating file create), which is exactly the resume path.
   */
  static open(path: string, now: () => Date = () => new Date()): Journal {
    ensureSecureDir(dirname(path));
    ensureSecureFile(path);

    const db = new Database(path, { create: true });
    // The schema declares `actions.run_id references runs(id)`; enforce it so a
    // typo cannot attach an action to a run that never existed.
    db.exec("pragma foreign_keys = on");
    db.exec(SCHEMA);

    return new Journal(db, now);
  }

  /**
   * Record the start of a run and return its id.
   *
   * `filtersJson` is the manifest filters already serialized; the journal
   * stores the string verbatim and never re-interprets it.
   */
  startRun(mode: RunMode, filtersJson: string, planned: number): number {
    const info = this.#db
      .query(`insert into runs (started_at, mode, filters, planned) values (?, ?, ?, ?)`)
      .run(this.#now().toISOString(), mode, filtersJson, planned);
    return Number(info.lastInsertRowid);
  }

  /**
   * Record one chat's state, at the moment it happens.
   *
   * Idempotent by construction: the `(run_id, chat_id)` primary key plus the
   * upsert means marking the same chat twice updates the one row, never
   * inserts a second, and the run's `left`/`failed` counters are recomputed
   * from `actions` in the same transaction so they cannot drift or double
   * count. `state` therefore always reflects the *last* thing that happened --
   * a failed chat that is then retried successfully reads `left`.
   *
   * Seeding the planned chats as `pending` is the caller's job: `startRun`
   * knows only how many there are (its signature is pinned by
   * plan/implementation-plan.md, Task 5), so the orchestrator marks each chat
   * `pending` before it acts and `pending()` can then hand back the untouched
   * remainder.
   */
  mark(
    runId: number,
    chat: { id: number; title: string },
    state: ActionState,
    error?: string,
  ): void {
    this.#record(runId, chat.id, chat.title, state, error ?? null, this.#now().toISOString());
  }

  /**
   * The chats of `runId` still marked `pending`, in plan order, each once.
   *
   * Anything already `left`, `failed` or `skipped` is absent: that absence is
   * what stops a resumed run from leaving a chat twice.
   */
  pending(runId: number): PendingChat[] {
    return this.#pending.all(runId) as PendingChat[];
  }

  /**
   * The newest run that has not been finished, or `null` when there is none.
   *
   * `chaff leave` offers to continue exactly this run. Finished runs are
   * invisible here even if they still have `pending` rows: the user ended that
   * run, so resuming it is not what they asked for.
   */
  latestUnfinished(): RunRow | null {
    const row = this.#latestUnfinished.get() as RunDbRow | null;
    return row === null ? null : toRunRow(row);
  }

  /** Mark the run done by stamping `finished_at` from the injected clock. */
  finishRun(runId: number): void {
    this.#db
      .query(`update runs set finished_at = ? where id = ?`)
      .run(this.#now().toISOString(), runId);
  }

  /** Every run, oldest first (a log reads in the order it was written). */
  listRuns(): RunRow[] {
    return (this.#listRuns.all() as RunDbRow[]).map(toRunRow);
  }

  /** Release the database handle. Saving is the caller's job; this only closes. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
