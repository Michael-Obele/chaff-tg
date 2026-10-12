/**
 * `chaff leave`: the one command that writes to Telegram
 * (plan/cli.md, "Selection and pacing", "The interactive checklist"; plan/safety.md,
 * "Reviewed before destructive").
 *
 * Everything else in the tool exists to make this one safe, so the order here
 * is fixed and nothing in it is optional: build the plan (from filters, or by
 * replaying a manifest with `--from`), apply `--exclude` last so it wins over
 * everything, then -- only for a live run -- open the journal, walk the
 * checklist, show the final screen naming the count, the pace and the
 * estimate, and hand the confirmed chats to `runLeave` (src/core/leave.ts),
 * which owns the pace, the cap, the retries and every journal write. The exit
 * code is read from the facts the run reports, never guessed here.
 *
 * The gates, each with the rule it enforces:
 *
 * - **No `--yes`, no write.** A dry run is a rehearsal: the same summary,
 *   prefixed `dry run`, and `runLeave`'s own dry path, which touches no chat,
 *   takes no pause, and writes no journal -- not even the data directory is
 *   created.
 * - **No journal, no live run.** A leave with no record is not acceptable, so
 *   a journal that cannot be opened refuses the run with exit 2 instead of
 *   running unrecorded.
 * - **`--exclude` wins.** The plan is exclude-filtered before any selection
 *   sees it (`buildPlan`, or `applyExclude` on the replay path with the
 *   caller's `--delay` threaded through, so the estimate matches the pace the
 *   user asked for), and the selection is filtered once more where the
 *   invariant has its single explicit home.
 * - **The checklist is the review.** Scam-flagged chats arrive pre-ticked and
 *   pinned chats arrive shown but unticked (src/cli/checklist.ts); `--select`
 *   skips it on purpose, and a run that is not attached to a terminal skips it
 *   because a script cannot review anything.
 * - **Above 20, the word is `leave`.** The typed confirmation is the last gate
 *   and, like the checklist, only exists where a person can answer it.
 *
 * The interactive steps read `process.stdin` and write through `ctx.out.line`,
 * the one channel that reaches stdout directly -- which means a machine format
 * (`--json`, `--csv`, `--md`) refuses the checklist rather than interleaving a
 * prompt with a document, and the run stops before anything is touched.
 */
import { EXIT } from "../../core/errors";
import { Journal } from "../../core/journal";
import { runLeave, type LeaveClient, type Progress, type RunResult } from "../../core/leave";
import { ManifestError, parseManifest } from "../../core/manifest";
import { applyExclude, buildPlan, estimateSeconds } from "../../core/plan";
import type { ChatRecord, Plan, PlanChat } from "../../core/types";
import type { Selection } from "../args";
import { runChecklist, runConfirm, type ChecklistItem } from "../checklist";
import { openClient, resolveLocalState, type ChaffClient, type OpenedClient } from "../client";
import type { Command, CommandContext } from "../index";

/** A thrown value as a sentence; the same shape `runCli` prints. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The chats a dry run is handed.
 *
 * `runLeave`'s dry path never calls the client -- it announces the plan and
 * returns -- so this stub is what a rehearsal is given instead of a session's
 * worth of connection, and it fails loudly if the dry path ever grows a call.
 */
const NO_CLIENT: LeaveClient = {
  leaveChat: async () => {
    throw new Error("a dry run must not leave any chat");
  },
};

/**
 * The slice of a client `runLeave` needs: the library's own `leaveChat` name,
 * adapted to the wrapper's `leave` (both front ends talk to `TelegramApi` or
 * the shipped fake, never to mtcute).
 */
function leaveClient(api: ChaffClient): LeaveClient {
  return {
    leaveChat: (chatId, params) => api.leave(Number(chatId), params ?? {}),
  };
}

/** The plan's chats as checklist rows: scam pre-ticked, pinned never. */
export function checklistItems(plan: Plan): ChecklistItem[] {
  return plan.chats.map((chat) => ({
    id: chat.id,
    title: chat.title,
    type: chat.type,
    members: chat.members,
    lastMessageAt: chat.lastMessageAt,
    scam: chat.isScam,
    // Telegram's own scam flag is the one thing worth ticking for the user.
    // A pinned chat is shown but never pre-ticked: pinning is an act of
    // attention, so leaving one is always the user's own tick.
    preselected: chat.isScam,
  }));
}

/** One line of progress, as `-v` prints it. */
function reportProgress(ctx: CommandContext): (p: Progress) => void {
  return (p) => {
    const note = p.error === undefined ? "" : ` (${p.error})`;
    ctx.out.verbose(`${p.state} ${p.chatId} ${p.title}${note}\n`);
  };
}

/** The one summary line: the same facts with or without a run, `dry run` prefixed. */
function summaryLine(result: RunResult, delayMs: number, dry: boolean): string {
  const head = dry
    ? `dry run: would leave ${result.planned} chats`
    : `left ${result.left} of ${result.planned} chats ` +
      `(${result.failed} failed, ${result.skipped} skipped)`;
  return `${head}, about ${estimateSeconds(result.planned, delayMs)}s at a ${delayMs}ms pace\n`;
}

/**
 * The exit code the facts earn (plan/cli.md, "Exit codes"): a flood stop is 5,
 * any failure is 4, and everything else is a clean 0 -- including a cap or an
 * abort, which stopped early but failed nothing.
 *
 * A `PEER_FLOOD` stop carries no wait seconds and records nothing for the chat
 * it stopped on, so "the run stopped before its plan ended, with no failures,
 * and was neither aborted nor capped" is the flood shape and gets 5 too.
 */
function exitCodeOf(result: RunResult): number {
  if (result.floodWaitSeconds !== null) return EXIT.FLOOD;
  if (result.failed > 0) return EXIT.PARTIAL;
  const settled = result.left + result.failed + result.skipped;
  if (!result.aborted && !result.capped && settled < result.planned) return EXIT.FLOOD;
  return EXIT.OK;
}

/** Where the two interactive steps read from and write to. */
function terminalIO(ctx: CommandContext): { input: unknown; output: unknown } {
  return { input: process.stdin, output: { write: (text: string) => ctx.out.line(text) } };
}

export const leaveCommand: Command = {
  name: "leave",
  summary: "Leave the selected chats",

  async run(ctx) {
    const { filters, selection } = ctx.args;
    const delayMs = selection.delayMs;
    let plan: Plan;
    let opened: OpenedClient | null = null;

    try {
      // The plan: live filters, or a manifest replay. Both paths hand the
      // caller's `--delay` to the builder so the estimate tells the truth
      // about this run's pace (the replay path is the binding one: an
      // act-time exclusion recomputed at the default pace would show a wrong
      // estimate immediately before a destructive run).
      if (selection.from === null) {
        opened = await openClient(ctx);
        const limit = filters.limit === null ? {} : { limit: filters.limit };
        const records: ChatRecord[] = [];
        for await (const chat of opened.api.dialogs(limit)) records.push(chat);
        plan = buildPlan(records, filters, opened.account, ctx.now(), delayMs);
      } else {
        let text: string;
        try {
          text = await Bun.file(selection.from).text();
        } catch (error) {
          throw new Error(`cannot read manifest ${selection.from}: ${messageOf(error)}`);
        }
        let manifest: Plan;
        try {
          manifest = parseManifest(text);
        } catch (error) {
          if (error instanceof ManifestError) {
            ctx.out.error(`${error.message}\n`);
            return EXIT.USAGE;
          }
          throw error;
        }
        // `--exclude` is the one filter a replay honours: it is the act-time
        // safety valve, and it wins over everything the manifest recorded.
        plan = applyExclude(manifest, filters.exclude, delayMs);
      }

      // A rehearsal stops here: the same summary, prefixed `dry run`, and
      // nothing touched -- no checklist, no journal, no leave.
      if (!selection.yes) {
        const result = await runLeave(
          NO_CLIENT,
          plan,
          { ...selectionOptions(selection), journal: null },
          reportProgress(ctx),
        );
        ctx.out.note(summaryLine(result, delayMs, true));
        return EXIT.OK;
      }

      // A machine output format cannot host the checklist or the typed
      // confirmation, and the filters-only path has nothing else to choose the
      // set from -- falling through would quietly act on every matching chat.
      // So the combination is a usage error, refused before the journal exists
      // and before anything else can happen. `--select` and `--from` name an
      // explicit set, so they stay scriptable under any format.
      const machine = ctx.args.flags.json || ctx.args.flags.csv || ctx.args.flags.md;
      if (machine && selection.select === null && selection.from === null) {
        ctx.out.error(
          "a machine output format (--json, --csv or --md) cannot ask which " +
            "chats to leave. Name the set with --select <ids>, replay a reviewed " +
            "manifest with --from <file>, or drop the format flag to use the " +
            "checklist.\n",
        );
        return EXIT.USAGE;
      }

      // Live. The journal is not optional: a leave with no record is not
      // acceptable, so a journal that cannot be opened refuses the run.
      const { paths, config } = resolveLocalState(ctx.env);
      let journal: Journal;
      try {
        journal = Journal.open(paths.journalPath());
      } catch (error) {
        ctx.out.error(
          `cannot open the resume journal at ${paths.journalPath()}: ${messageOf(error)}. ` +
            "A leave with no record is not acceptable; free some space or fix the " +
            "directory, then run the command again.\n",
        );
        return EXIT.USAGE;
      }

      try {
        const session = config.session;
        const unfinished = journal.latestUnfinished(session);
        if (unfinished !== null) {
          ctx.out.note(
            `the journal has an unfinished run ${unfinished.id} ` +
              `(${unfinished.left} of ${unfinished.planned} left); ` +
              "this run continues it when the same chats are selected\n",
          );
        }

        // A replay acts through a live session, so the client arrives here if
        // the plan did not need one.
        if (opened === null) opened = await openClient(ctx);

        // The selection: exactly these ids (`--select`), whatever the
        // checklist ticks, or the whole plan when nothing interactive can ask
        // (a script, or a machine format).
        const planIds = new Set(plan.chats.map((chat) => chat.id));
        let chosen: number[];
        if (selection.select !== null) {
          chosen = selection.select.filter((id) => planIds.has(id));
          const dropped = selection.select.length - chosen.length;
          if (dropped > 0) {
            ctx.out.note(`${dropped} selected id(s) are not in this plan and were ignored\n`);
          }
        } else if (ctx.isTTY) {
          const picked = await runChecklist(checklistItems(plan), terminalIO(ctx));
          if (picked === null) {
            ctx.out.note("cancelled; nothing was left\n");
            return EXIT.OK;
          }
          chosen = picked;
        } else {
          chosen = plan.chats.map((chat) => chat.id);
        }

        // `--exclude` wins over everything, including the checklist: the plan
        // was already exclude-filtered before any selection saw it, so this is
        // the invariant's one explicit home, and it holds whatever future
        // selection path grows above it.
        const excluded = new Set(filters.exclude);
        chosen = [...new Set(chosen)].filter((id) => !excluded.has(id));

        // The last gate, where a person can answer it.
        if (ctx.isTTY && chosen.length > 0) {
          const ok = await runConfirm(
            {
              count: chosen.length,
              paceMs: delayMs,
              estimateSeconds: estimateSeconds(chosen.length, delayMs),
            },
            terminalIO(ctx),
          );
          if (!ok) {
            ctx.out.note("cancelled; nothing was left\n");
            return EXIT.OK;
          }
        }

        const byId = new Map(plan.chats.map((chat) => [chat.id, chat]));
        const chats = chosen
          .map((id) => byId.get(id))
          .filter((chat): chat is PlanChat => chat !== undefined);
        if (chats.length === 0) {
          ctx.out.note("no chats selected; nothing was left\n");
          return EXIT.OK;
        }

        const subPlan: Plan = {
          ...plan,
          chats,
          summary: {
            matched: chats.length,
            estimatedSeconds: estimateSeconds(chats.length, delayMs),
          },
        };

        const result = await runLeave(
          leaveClient(opened.api),
          subPlan,
          { ...selectionOptions(selection), journal, session },
          reportProgress(ctx),
        );

        // The facts, then the code. A stop and the failures are worth more
        // than the summary line, so they go to stderr and survive --quiet.
        if (result.floodWaitSeconds !== null) {
          ctx.out.error(
            `stopped: Telegram asked the account to wait ${result.floodWaitSeconds}s. ` +
              "The rest of the run is still pending in the journal\n",
          );
        } else if (exitCodeOf(result) === EXIT.FLOOD) {
          ctx.out.error(
            "stopped: Telegram is limiting this account. The rest of the run is still pending in the journal\n",
          );
        }
        if (result.capped) {
          ctx.out.error(
            `stopped at the --max-leave cap of ${selection.maxLeave}. ` +
              "Run the command again to continue, or raise the cap\n",
          );
        }
        for (const failure of result.failures) {
          ctx.out.error(`failed ${failure.chatId} ${failure.title}: ${failure.error}\n`);
        }

        const exit = exitCodeOf(result);
        ctx.out.note(summaryLine(result, delayMs, false));
        if (exit !== EXIT.OK) ctx.out.error(`journal: ${paths.journalPath()}\n`);
        return exit;
      } finally {
        journal.close();
      }
    } finally {
      await opened?.api.destroy();
    }
  },
};

/** The run's own flags, in the shape `runLeave` takes them. */
function selectionOptions(selection: Selection): {
  yes: boolean;
  maxLeave: number;
  delayMs: number;
  clear: boolean;
  force: boolean;
} {
  return {
    yes: selection.yes,
    maxLeave: selection.maxLeave,
    delayMs: selection.delayMs,
    clear: selection.clear,
    force: selection.force,
  };
}
