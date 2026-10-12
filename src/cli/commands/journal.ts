/**
 * `chaff journal`: lists past runs (`id`, `started`, `mode`, `planned`, `left`,
 * `failed`) with `--json` support, plus `--run <id>` for a per-chat detail view
 * listing each chat's state.
 */
import { EXIT } from "../../core/errors";
import { Journal } from "../../core/journal";
import { resolveLocalState } from "../client";
import type { Command } from "../index";
import type { Column } from "../render/columns";

interface RunRow {
  id: number;
  started: string;
  mode: string;
  planned: number;
  left: number;
  failed: number;
}

const RUN_COLUMNS: ReadonlyArray<Column<RunRow>> = [
  { key: "id", header: "id", align: "right", value: (r) => String(r.id) },
  { key: "started", header: "started", value: (r) => r.started },
  { key: "mode", header: "mode", value: (r) => r.mode },
  { key: "planned", header: "planned", align: "right", value: (r) => String(r.planned) },
  { key: "left", header: "left", align: "right", value: (r) => String(r.left) },
  { key: "failed", header: "failed", align: "right", value: (r) => String(r.failed) },
];

interface ChatRow {
  id: number;
  title: string;
  state: string;
  error: string;
}

const CHAT_COLUMNS: ReadonlyArray<Column<ChatRow>> = [
  { key: "id", header: "id", align: "right", value: (r) => String(r.id) },
  { key: "title", header: "title", value: (r) => r.title },
  { key: "state", header: "state", value: (r) => r.state },
  { key: "error", header: "error", value: (r) => r.error || "-" },
];

export const journalCommand: Command = {
  name: "journal",
  summary: "Show what previous runs did",

  async run(ctx) {
    const { paths } = resolveLocalState(ctx.env);
    const journalPath = paths.journalPath();

    let journal: Journal;
    try {
      journal = Journal.open(journalPath);
    } catch {
      ctx.out.document({
        json: { runs: [] },
        table: { columns: RUN_COLUMNS, rows: [] },
      });
      return EXIT.OK;
    }

    try {
      const runId = ctx.args.runId ?? null;

      if (runId !== null) {
        const actions = journal.actions(runId);
        if (actions.length === 0) {
          ctx.out.error(`no run ${runId}\n`);
          return EXIT.USAGE;
        }
        const runRow = journal.listRuns().find((r) => r.id === runId);
        const chats: ChatRow[] = actions.map((a) => ({
          id: a.id,
          title: a.title,
          state: a.state,
          error: a.error ?? "",
        }));
        const runInfo = runRow
          ? { id: runRow.id, started: runRow.startedAt, mode: runRow.mode }
          : { id: runId };
        ctx.out.document({
          json: {
            run: runInfo,
            chats: chats.map((c) => ({
              id: c.id,
              title: c.title,
              state: c.state,
              error: c.error || null,
            })),
          },
          table: { columns: CHAT_COLUMNS, rows: chats },
        });
        return EXIT.OK;
      }

      const runs = journal.listRuns();
      const rows: RunRow[] = runs.map((r) => ({
        id: r.id,
        started: r.startedAt,
        mode: r.mode,
        planned: r.planned,
        left: r.left,
        failed: r.failed,
      }));
      const jsonRuns = rows.map((r) => ({
        id: r.id,
        started: r.started,
        mode: r.mode,
        planned: r.planned,
        left: r.left,
        failed: r.failed,
      }));
      ctx.out.document({
        json: { runs: jsonRuns },
        table: { columns: RUN_COLUMNS, rows },
      });
      return EXIT.OK;
    } finally {
      journal.close();
    }
  },
};
