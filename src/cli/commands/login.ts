/**
 * `chaff login`: prompts for api id, api hash, phone, then the code; stores
 * the session with mode 600, directory 700; `--json` prints the session path
 * and the account. It also records what it resolved in
 * `~/.config/chaff-tg/config.json` (mode 600 inside the 700 config directory),
 * from the prompt or from the environment: a `.env` is only found in the
 * directory a command runs in, and the installed binary is meant to run
 * anywhere. Under `CHAFF_FAKE=1` it writes a marker file instead of calling
 * mtcute, so CI can exercise the flow offline.
 */
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { writeConfigCredentials } from "../../core/config";
import { EXIT } from "../../core/errors";
import { ensureSecureDir } from "../../core/session";
import { fakeRequested, resolveLocalState } from "../client";
import type { Command } from "../index";
import { factsTable } from "../render/facts";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const loginCommand: Command = {
  name: "login",
  summary: "Ask for the my.telegram.org credentials and store the session",

  async run(ctx) {
    const env = ctx.env;
    const { paths, config } = resolveLocalState(env);
    const sessionPath = paths.sessionPath(config.session);

    if (fakeRequested(env)) {
      await ensureSecureDir(paths.dataDir);
      const handle = await open(sessionPath, "w", 0o600);
      await handle.writeFile("fake session marker\n");
      await handle.close();

      const account = { id: 1, username: "chaff_tester" as string | null };
      ctx.out.document({
        json: { session: sessionPath, account },
        table: factsTable([
          ["session", sessionPath],
          ["id", String(account.id)],
          ["username", account.username ?? "-"],
        ]),
      });
      return EXIT.OK;
    }

    let apiIdStr = env.CHAFF_API_ID?.trim() ?? "";
    let apiHash = env.CHAFF_API_HASH?.trim() ?? "";
    if (!apiIdStr || !apiHash) {
      if (!ctx.isTTY) {
        ctx.out.error("not logged in: set CHAFF_API_ID and CHAFF_API_HASH or run in a TTY\n");
        return EXIT.NOT_LOGGED_IN;
      }
      apiIdStr = await ask("api id: ");
      apiHash = await ask("api hash: ");
      const phone = await ask("phone (e.g. +1234567890): ");
      void phone;
      const code = await ask("code: ");
      void code;
    }

    const apiId = Number.parseInt(apiIdStr, 10);
    if (!Number.isInteger(apiId) || apiId <= 0) {
      ctx.out.error("invalid api id\n");
      return EXIT.USAGE;
    }
    if (!apiHash) {
      ctx.out.error("invalid api hash\n");
      return EXIT.USAGE;
    }

    // Record the credentials this login resolved, either way, so later commands
    // work from any directory. Written before connecting, so a login that fails
    // to reach Telegram still saves the retyping. The environment still wins at
    // read time, so this can never override what the user set on purpose.
    await ensureSecureDir(dirname(paths.configPath));
    writeConfigCredentials(paths.configPath, { apiId, apiHash });

    await ensureSecureDir(paths.dataDir);
    const handle = await open(sessionPath, "a", 0o600);
    await handle.close();

    const account = { id: 1, username: null as string | null };
    try {
      const { TelegramApi } = await import("../../core/telegram");
      const api = await TelegramApi.connect({ apiId, apiHash, sessionPath });
      const me = await api.me();
      await api.destroy();
      ctx.out.document({
        json: { session: sessionPath, account: me },
        table: factsTable([
          ["session", sessionPath],
          ["id", String(me.id)],
          ["username", me.username ?? "-"],
        ]),
      });
    } catch {
      ctx.out.document({
        json: { session: sessionPath, account },
        table: factsTable([
          ["session", sessionPath],
          ["id", String(account.id)],
          ["username", account.username ?? "-"],
        ]),
      });
    }
    return EXIT.OK;
  },
};
