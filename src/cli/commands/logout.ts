/**
 * `chaff logout`: deletes the session file and the journal, prints what was
 * removed, and asks for confirmation unless `--yes`.
 *
 * Confirmation uses the same injectable-input approach as `src/cli/checklist.ts`
 * so it is testable without a TTY.
 */
import { createInterface } from "node:readline";
import { EXIT } from "../../core/errors";
import { removeSession, sessionExists } from "../../core/session";
import { resolveLocalState } from "../client";
import type { Command } from "../index";

async function confirm(
  question: string,
  isTTY: boolean,
  input?: unknown,
  output?: unknown,
): Promise<boolean> {
  const out = output as { write(s: string): unknown } | undefined;
  out?.write(question);
  if (input !== undefined && input !== null) {
    const rl = createInterface({ input: input as Parameters<typeof createInterface>[0]["input"] });
    for await (const line of rl) {
      rl.close();
      const answer = line.trim().toLowerCase();
      return answer === "y" || answer === "yes";
    }
    rl.close();
    return false;
  }
  if (isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        resolve(a === "y" || a === "yes");
      });
    });
  }
  return false;
}

export const logoutCommand: Command = {
  name: "logout",
  summary: "Delete the local session file",

  async run(ctx) {
    const { paths, config } = resolveLocalState(ctx.env);
    const sessionName = config.session;
    const sessionPath = paths.sessionPath(sessionName);
    const journalPath = paths.journalPath();

    const hasSession = await sessionExists(paths, sessionName);
    // `Bun.file().exists()` answers for a file, and the journal is one. It says
    // `false` for a directory, which is why `doctor`'s `.git` probe cannot use it.
    const hasJournal = await Bun.file(journalPath).exists();

    if (!hasSession && !hasJournal) {
      ctx.out.note("nothing to remove\n");
      return EXIT.OK;
    }

    const yes = ctx.args.selection.yes;
    if (!yes) {
      const input = (ctx as unknown as { input?: unknown }).input;
      const ok = await confirm(
        `remove ${sessionPath} and ${journalPath}? (y/N) `,
        ctx.isTTY,
        input,
        { write: (t: string) => ctx.out.note(t) },
      );
      if (!ok) {
        ctx.out.note("cancelled; nothing was removed\n");
        return EXIT.OK;
      }
    }

    let removedSession = false;
    let removedJournal = false;
    if (hasSession) removedSession = await removeSession(paths, sessionName);
    if (hasJournal) {
      try {
        // The same ENOENT `unlink` throws, so the one forgiven failure stands.
        await Bun.file(journalPath).delete();
        removedJournal = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try {
          await Bun.file(`${journalPath}${suffix}`).delete();
        } catch {
          // ignore
        }
      }
    }

    if (!removedSession && !removedJournal) {
      ctx.out.note("nothing to remove\n");
      return EXIT.OK;
    }
    const removed: string[] = [];
    if (removedSession) removed.push(sessionPath);
    if (removedJournal) removed.push(journalPath);
    ctx.out.note(`removed ${removed.join(", ")}\n`);
    return EXIT.OK;
  },
};
