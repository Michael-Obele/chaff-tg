/**
 * The test-side fake client: the shipped implementation
 * (`src/fakes/client.ts`), with the Task 2 fixtures wired in as its defaults.
 *
 * The implementation is shipped code because `CHAFF_FAKE` is how CI runs a
 * compiled binary (implementation-plan.md, Task 11), and a binary built from
 * `src/` cannot resolve anything under `test/`. The one thing that is
 * test-only is *which* fixture files the default client reads; everything else
 * is re-exported unchanged, so this module is the same import it always was.
 */
import { FakeClient as ShippedFakeClient, loadFixtures } from "../src/fakes/client";
import type { FakeClientOptions } from "../src/fakes/client";

export { FakeRpcError, fakeRpcError, loadFixtures } from "../src/fakes/client";
export type { FakeClientOptions, FakeFailure, FakeFixtures } from "../src/fakes/client";

const fixtures = await loadFixtures(new URL("./fixtures/", import.meta.url));

/**
 * The shipped fake, defaulting to the Task 2 fixtures.
 *
 * An explicit option wins; an explicitly `undefined` one still falls back to
 * the fixture, exactly as this fake behaved when it lived here.
 */
export class FakeClient extends ShippedFakeClient {
  constructor(opts: FakeClientOptions = {}) {
    super({
      ...opts,
      dialogs: opts.dialogs ?? fixtures.dialogs,
      rawDialogs: opts.rawDialogs ?? fixtures.rawDialogs,
    });
  }
}
