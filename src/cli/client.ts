/**
 * Opening the client: the one place that decides fake or real
 * (`plan/implementation-plan.md`, Task 11; `plan/architecture.md`).
 *
 * Three rules live here, and nowhere else.
 *
 * - **`CHAFF_FAKE` picks the fake, before anything else happens.** CI has no
 *   Telegram account, so a compiled binary is exercised through
 *   `src/fakes/client.ts`. The switch is checked first and the fake path reads
 *   no config, no session and no credential: a fake run must work in an empty
 *   temporary directory, which is exactly what the CI smoke step does. An
 *   optional `CHAFF_FIXTURE` points the fake at a directory holding
 *   `dialogs.json` and `raw-dialogs.json`; without it the fake has no dialogs,
 *   and `chaff list --json` prints `{ "chats": [] }` rather than failing.
 * - **Not being logged in is a sentence, not a stack trace.** No session, a
 *   session with no credentials to open it, or a session file that exists but
 *   cannot be opened are all `NotLoggedInError`: one plain sentence ending in
 *   what to do about it, and exit 3 (`EXIT.NOT_LOGGED_IN`, "Not logged in, or
 *   the session is unreadable"). A *network* failure while connecting is not an
 *   unreadable session, so it stays the unexpected failure it is (exit 1), as
 *   does a `ConfigError` for a config file that cannot be trusted.
 * - **The api hash is an argument, never a message.** It is read from the
 *   environment or the config file (`resolveCredentials`) and handed to
 *   `TelegramApi.connect`; nothing on this path ever formats a credential into
 *   text, so `--verbose` and every error message are safe
 *   (`plan/safety.md`, "Logging").
 */
import { type Config, loadConfig, resolveCredentials } from "../core/config";
import { EXIT, classify } from "../core/errors";
import { type Paths, resolvePaths, sessionExists } from "../core/session";
import { TelegramApi } from "../core/telegram";
import type { Account } from "../core/types";
import { FakeClient, loadFixtures } from "../fakes/client";
import type { CommandContext } from "./index";

/**
 * The clients a command can be handed: the real wrapper, or the shipped fake.
 * Both answer `dialogs()`, `me()`, `leave()` and `destroy()`, which is the
 * surface Tasks 11-14 use; `test/fake-client.ts` carries the library's own
 * method names as well, so the fake is also a drop-in for the seam itself.
 */
export type ChaffClient = TelegramApi | FakeClient;

/** A connected client and the account it is authorized as. */
export interface OpenedClient {
  api: ChaffClient;
  account: Account;
}

/** The local state, resolved: where the files live, and what asked for them. */
export interface LocalState {
  paths: Paths;
  config: Config;
}

/**
 * A local precondition the user can fix: there is nothing to authenticate with.
 * Carries exit 3 (`plan/cli.md`, "Exit codes") so the front end needs no table
 * of its own, and is deliberately not a `ChaffError`: that type means "a
 * Telegram failure, already classified", and nothing here came from Telegram.
 */
export class NotLoggedInError extends Error {
  readonly exitCode: number = EXIT.NOT_LOGGED_IN;

  constructor(message: string) {
    super(message);
    this.name = "NotLoggedInError";
  }
}

/**
 * Whether `CHAFF_FAKE` asks for the fake client.
 *
 * Any value but the usual "no" spellings turns it on, so `CHAFF_FAKE=1` (what
 * the plan documents) works and so does `CHAFF_FAKE=true`; `CHAFF_FAKE=0` and
 * `CHAFF_FAKE=false` are the honest way to say "no" to a variable that is
 * already in the environment.
 */
export function fakeRequested(env: Record<string, string | undefined>): boolean {
  const value = env.CHAFF_FAKE?.trim().toLowerCase();
  if (value === undefined || value === "") return false;
  return value !== "0" && value !== "false" && value !== "no";
}

/**
 * Resolve the local state: the config file, and the paths it decides.
 *
 * The config file's own location cannot depend on the config, so this runs in
 * two steps: `resolvePaths(env)` finds the file, `loadConfig` reads it, and the
 * second `resolvePaths` applies the `sessionDir` it asked for. A config file
 * that is there but unusable throws a `ConfigError` carrying a secret-free
 * message; a missing one is simply the documented defaults.
 */
export function resolveLocalState(env: Record<string, string | undefined>): LocalState {
  const base = resolvePaths(env);
  const config = loadConfig(base.configPath);
  return { paths: resolvePaths(env, config.sessionDir), config };
}

/**
 * Open the client a command acts through: the fake when `CHAFF_FAKE` asks for
 * it, otherwise a real client over the stored session.
 *
 * The session has to exist and the credentials have to resolve before anything
 * connects, so "you are not logged in" is answered without a network round
 * trip, and the message names the file it looked for.
 */
export async function openClient(ctx: CommandContext): Promise<OpenedClient> {
  const env = ctx.env;

  if (fakeRequested(env)) {
    const fixture = env.CHAFF_FIXTURE?.trim();
    const fake = new FakeClient(
      fixture === undefined || fixture === "" ? {} : await loadFixtures(fixture),
    );
    return { api: fake, account: await fake.me() };
  }

  const { paths, config } = resolveLocalState(env);
  const sessionPath = paths.sessionPath(config.session);

  if (!(await sessionExists(paths, config.session))) {
    throw new NotLoggedInError(
      `not logged in: there is no session file at ${sessionPath}. ` +
        "Run `chaff login` to create one, or set CHAFF_FAKE=1 to work offline.",
    );
  }

  const credentials = resolveCredentials(config, env);
  if (credentials === null) {
    throw new NotLoggedInError(
      `not logged in: the session file at ${sessionPath} cannot be opened, because ` +
        "no api id and api hash are configured. Set CHAFF_API_ID and CHAFF_API_HASH, " +
        `or put them in ${paths.configPath}.`,
    );
  }

  // The session exists and its credentials resolve, so a failed connect is the
  // other half of exit 3: "the session is unreadable". The one exception is a
  // network failure, which is retryable and not about the session at all.
  // ponytail: one classified check, no new error type — widen this if a
  // non-network connect failure ever needs an exit code of its own.
  let api: TelegramApi;
  try {
    api = await TelegramApi.connect({
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      sessionPath,
    });
  } catch (error) {
    if (classify(error).kind === "network") throw error;
    throw new NotLoggedInError(
      `not logged in: the session file at ${sessionPath} exists but could not ` +
        "be opened. Run `chaff login` again, or set CHAFF_FAKE=1 to work offline.",
    );
  }
  return { api, account: await api.me() };
}
