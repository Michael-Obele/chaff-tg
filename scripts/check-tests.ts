/**
 * Guards against the worst CI failure mode: a suite that discovers zero tests
 * and exits green (plan/notes.md, "Things that will bite").
 *
 * Wired into the `test` script: `bun test && bun scripts/check-tests.ts`.
 */

const glob = new Bun.Glob("test/**/*.test.ts");
const files = [...glob.scanSync({ cwd: `${import.meta.dir}/..` })];

if (files.length === 0) {
  console.error("check-tests: no test files discovered under test/ — failing on purpose.");
  process.exit(1);
}

console.log(`check-tests: ${files.length} test file(s) discovered.`);
