/**
 * `chaff login`: takes the api id and api hash from the environment, or asks for
 * them when there is a terminal to ask, records them in
 * `~/.config/chaff-tg/config.json` (mode 600 inside the 700 config directory),
 * then connects so the session is created mode 600, directory 700. `--json`
 * prints the session path and the account.
 *
 * The credentials are recorded because a `.env` is only found in the directory a
 * command runs in, and the installed binary is meant to run anywhere.
 *
 * The phone number and the code are NOT asked for here: mtcute's Bun client
 * prompts for both, and `connect` is told whether a terminal is attached
 * (`interactive`, src/core/telegram.ts). Under `CHAFF_FAKE=1` this writes a
 * marker file instead of calling mtcute, so CI can exercise the flow offline.
 */
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { writeConfigCredentials } from "../../core/config";
import { EXIT } from "../../core/errors";
import { ensureSecureDir } from "../../core/session";
import { fakeRequested, resolveLocalState } from "../client";
import type { Command } from "../index";
import { factsTable } from "../render/facts";

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

    // `ctx.isTTY` means "both ends are terminals" (`promptable`,
    // src/cli/index.ts), which is what `prompt()` needs: it writes the question to
    // stdout and reads the answer from stdin.
    const canAsk = ctx.isTTY;

    if (!apiIdStr || !apiHash) {
      if (!canAsk) {
        ctx.out.error("not logged in: set CHAFF_API_ID and CHAFF_API_HASH or run in a TTY\n");
        return EXIT.NOT_LOGGED_IN;
      }
      apiIdStr = (prompt("api id: ") ?? "").trim();
      apiHash = (prompt("api hash: ") ?? "").trim();
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

    // No `catch` around this. Swallowing the failure reported an account that
    // does not exist (`id 1`) and exited 0, so a login that never happened looked
    // exactly like one that did. `runCli` already turns a thrown error into its
    // message on stderr and a real exit code, which is the honest answer.
    const { TelegramApi } = await import("../../core/telegram");
    const api = await TelegramApi.connect({
      apiId,
      apiHash,
      sessionPath,
      interactive: canAsk,
    });
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
    return EXIT.OK;
  },
};
