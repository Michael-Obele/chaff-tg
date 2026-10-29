/**
 * `chaff report`: the review step that makes the tool safe
 * (`plan/cli.md`, "The review manifest"; `plan/architecture.md`, "Nothing
 * leaves memory until the plan is confirmed").
 *
 * This command is the only writer of the manifest, and it writes nothing else
 * and does nothing else: it builds a plan from the live (or fake) dialogs,
 * serializes it with `serializeManifest` and prints a summary. No chat leaves
 * anything here — that is `chaff leave`'s job, one confirmation later, against
 * exactly this file.
 *
 * Two modes share one output path:
 *
 * - **Build.** With no `--from`, the filters on the command line become a plan
 *   (`buildPlan`, the same engine `list` runs), and `--out` receives the
 *   manifest. The caller's `--delay` is passed through so
 *   `summary.estimatedSeconds` tells the truth about the pace the user asked
 *   for, not the default one.
 * - **Replay.** With `--from <file>`, the manifest is read back through
 *   `parseManifest` and printed. No client is opened and no network is
 *   touched, so a user can validate a manifest anywhere. A `ManifestError`
 *   means the file cannot be trusted, which is the user's answer to give and
 *   exits 2 (`EXIT.USAGE`), not 1: the message is the whole diagnosis.
 *
 * The format flags choose the bytes, on stdout and on disk, and the manifest
 * is the JSON those bytes are:
 *
 * - default (table): stdout is the table a person reads; `--out` receives the
 *   manifest, because a manifest is what this command exists to write;
 * - `--json`: stdout and `--out` both receive the manifest, byte for byte —
 *   the JSON document IS the plan (`document.json` is the manifest parsed
 *   back, so the renderer's stable key order reproduces `serializeManifest`'s
 *   canonical form exactly, and `chaff report --json > cleanup.json` gives a
 *   replayable file);
 * - `--md` / `--csv`: stdout and `--out` both receive the rendered table — a
 *   manifest is JSON, so a markdown or CSV file is for reading and pasting,
 *   not for `--from`.
 *
 * Two safety properties are worth naming because tests pin them: the
 * manifest carries the account and the chats and nothing else — never the api
 * hash and never the session path (`plan/safety.md`) — and `--out` inside a
 * git repository earns a warning on stderr, never a failure: a manifest
 * records chat titles, and titles in a commit are the kind of thing a user
 * only thinks about afterwards.
 */
import { dirname, resolve } from "node:path";
import { EXIT } from "../../core/errors";
import { ManifestError, parseManifest, serializeManifest } from "../../core/manifest";
import { applyGroups } from "../groups";
import { buildPlan } from "../../core/plan";
import type { ChatRecord, Plan } from "../../core/types";
import type { Command } from "../index";
import { openClient } from "../client";
import { outputFormat } from "../output";
import { gitRepositoryOf } from "./doctor";
import { chatTable } from "./list";

/** A thrown value as a sentence; the same shape `runCli` prints. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const reportCommand: Command = {
  name: "report",
  summary: "Write a review manifest (table, JSON, CSV or markdown)",

  async run(ctx) {
    const from = ctx.args.selection.from;
    let plan: Plan;

    if (from === null) {
      // Resolved before the client opens, as in `list`: a run that will refuse
      // should not connect first.
      const filters = applyGroups(ctx);
      const { api, account } = await openClient(ctx);
      try {
        // The cap belongs at the source, as in `list`: the client stops asking
        // Telegram once it has `--limit` dialogs.
        const limit = filters.limit === null ? {} : { limit: filters.limit };
        const records: ChatRecord[] = [];
        for await (const chat of api.dialogs(limit)) records.push(chat);

        // The caller's pace, so the estimate in the manifest is the estimate
        // for the run this user asked for.
        plan = buildPlan(records, filters, account, ctx.now(), ctx.args.selection.delayMs);
      } finally {
        await api.destroy();
      }
    } else {
      let text: string;
      try {
        text = await Bun.file(from).text();
      } catch (error) {
        throw new Error(`cannot read manifest ${from}: ${messageOf(error)}`);
      }
      try {
        plan = parseManifest(text);
      } catch (error) {
        // A manifest this build cannot trust is the user's answer to give:
        // the message is the whole diagnosis, and it exits 2, not 1.
        if (error instanceof ManifestError) {
          ctx.out.error(`${error.message}\n`);
          return EXIT.USAGE;
        }
        throw error;
      }
    }

    // A manifest records chat titles and usernames, which is fine in a file
    // and less fine in a commit: warn, name the repository, and carry on.
    const out = ctx.args.flags.out;
    if (out !== null) {
      const repo = gitRepositoryOf(dirname(resolve(out)));
      if (repo.inside) {
        ctx.out.error(
          `warning: --out ${out} is inside the git repository ${repo.root}; ` +
            "a manifest records chat titles, so keep it out of commits\n",
        );
      }
    }

    // The canonical bytes. Under `--json` these are also the stdout document
    // (parsed back, so the renderer reproduces them exactly), and under the
    // default table format they are what `--out` holds.
    const manifest = serializeManifest(plan);

    for (const chat of plan.chats) {
      ctx.out.verbose(`keep ${chat.id} ${chat.title}\n`);
    }
    ctx.out.note(`Found ${plan.summary.matched} chats, about ${plan.summary.estimatedSeconds}s\n`);
    const format = outputFormat(ctx.args.flags);
    if (out !== null) {
      // Only the default table format and `--json` put a replayable manifest in
      // `--out`; `--md` and `--csv` put the rendered table there. Saying
      // "manifest" about a markdown file is how a user ends up handing the
      // wrong file to `leave --from`.
      const what = format === "md" || format === "csv" ? "Table" : "Manifest";
      ctx.out.note(`${what} written to ${out}\n`);
    }

    ctx.out.document({
      json: JSON.parse(manifest) as unknown,
      table: chatTable(plan.chats),
    });

    // The sink wrote the same bytes stdout got to `--out`; under the default
    // table format those are the table, and this command's file is the
    // manifest. One overwrite, last write wins, stdout untouched.
    if (out !== null && format === "table") {
      await Bun.write(out, manifest);
    }

    return EXIT.OK;
  },
};
