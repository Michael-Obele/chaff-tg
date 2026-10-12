/**
 * `chaff whoami`: the account this session belongs to, and where that session
 * lives (`plan/cli.md`, "Commands").
 *
 * It answers the two questions a user has after `chaff login`, and the second
 * one is why the command exists at all: the session file is the whole account
 * (`plan/safety.md`), so knowing which file is in play is the difference
 * between cleaning up one machine and wondering why another still lists chats.
 *
 * The api hash is not part of the answer and cannot become one: it is never
 * read on this path (`openClient` hands it straight to the client), so there is
 * nothing here to leak it.
 */
import { EXIT } from "../../core/errors";
import type { Command } from "../index";
import { openClient, resolveLocalState } from "../client";
import { factsTable } from "../render/facts";

export const whoamiCommand: Command = {
  name: "whoami",
  summary: "Show the logged in account and where the session file lives",

  async run(ctx) {
    const { api, account } = await openClient(ctx);
    try {
      // Resolved from the same config the client used, so the path printed is
      // the path that was opened.
      const { paths, config } = resolveLocalState(ctx.env);
      const session = paths.sessionPath(config.session);

      ctx.out.document({
        json: { id: account.id, username: account.username, session },
        table: factsTable([
          ["id", String(account.id)],
          ["username", account.username ?? "-"],
          ["session", session],
        ]),
      });
      return EXIT.OK;
    } finally {
      await api.destroy();
    }
  },
};
