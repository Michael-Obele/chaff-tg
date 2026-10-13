import { describe, expect, test } from "bun:test";
import { CLI_VERSION } from "../src/cli/index";
import pkg from "../package.json";

/**
 * The version has exactly one home, `package.json`, and this is what keeps it that way.
 *
 * There used to be a second copy in `src/core/index.ts`, guarded by a test asserting the
 * two agreed. That test only existed because the duplicate existed; with one source there
 * is nothing left to drift. What is worth pinning now is that the number actually reaches
 * the CLI, which is a real failure mode: a wrong relative path in the JSON import would
 * report `undefined` instead of a version.
 */
describe("version", () => {
  test("a from-source run reports the version in package.json", () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  test("package.json holds a version a release tag can use", () => {
    // The release workflow tags `v${version}`, so a value the tag cannot carry is a
    // release that cannot be cut.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
