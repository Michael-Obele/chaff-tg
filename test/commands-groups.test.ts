/**
 * `chaff groups` and `--group` end to end, through `runCli` (`plan/groups.md`).
 * The fake client and the Task 2 fixtures keep this offline; the groups file
 * lives in a temporary XDG config directory, so no real `~/.config` is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../src/core/errors";
import { type Groups, loadGroups, saveGroups } from "../src/core/groups";
import { resolvePaths } from "../src/core/session";
import { fakeEnv, run } from "./harness";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A sandbox whose groups file holds `groups`. */
function withGroups(groups: Groups) {
  const { root, env } = fakeEnv();
  roots.push(root);
  const path = resolvePaths(env).groupsPath();
  saveGroups(path, groups);
  return { root, env, path };
}

describe("--group", () => {
  test("produces the same plan as typing the same flags", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal", "airdrop"] } });
    const viaGroup = await run(["list", "--group", "junk"], env);
    const typed = await run(["list", "--keyword", "signal,airdrop"], env);
    expect(viaGroup.code).toBe(EXIT.OK);
    expect(viaGroup.stdout.text()).toBe(typed.stdout.text());
  });

  test("a group's switch has the same effect as typing it", async () => {
    const { env } = withGroups({ scams: { scam: true } });
    const viaGroup = await run(["list", "--group", "scams", "--json"], env);
    const typed = await run(["list", "--scam", "--json"], env);
    expect(viaGroup.stdout.text()).toBe(typed.stdout.text());
  });

  test("a typed flag beats the group's value", async () => {
    const { env } = withGroups({ quiet: { muted: true } });
    const result = await run(["list", "--group", "quiet", "--not-muted", "--json"], env);
    const typed = await run(["list", "--not-muted", "--json"], env);
    expect(result.stdout.text()).toBe(typed.stdout.text());
  });

  test("a typed flag beats the group through its negated spelling", async () => {
    const { env } = withGroups({ quiet: { muted: true } });
    const viaGroup = await run(["list", "--group", "quiet", "--json"], env);
    const typed = await run(["list", "--muted", "--json"], env);
    const unmuted = await run(["list", "--group", "quiet", "--not-muted", "--json"], env);
    expect(viaGroup.stdout.text()).toBe(typed.stdout.text());
    expect(unmuted.code).toBe(EXIT.OK);
    expect(unmuted.stdout.text()).not.toBe(viaGroup.stdout.text());
  });

  test("two groups that disagree are refused", async () => {
    const { env } = withGroups({ a: { inactiveDays: 30 }, b: { inactiveDays: 365 } });
    const result = await run(["list", "--group", "a,b"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("both set --inactive-days");
  });

  test("a name that is not there lists what is, instead of filtering nothing", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal"] } });
    const result = await run(["list", "--group", "missing"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain('no group named "missing"');
    expect(result.stderr.text()).toContain("junk");
  });

  test("reads no file at all when the flag is absent", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal"] } });
    const path = resolvePaths(env).groupsPath();
    writeFileSync(path, "{ not json");
    const result = await run(["list"], env);
    expect(result.code).toBe(EXIT.OK);
  });

  test("a broken file is exit 2 and names the path", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal"] } });
    writeFileSync(resolvePaths(env).groupsPath(), "{ not json");
    const result = await run(["list", "--group", "junk"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups file at");
  });

  test("is ignored under --from, like every other filter flag", async () => {
    const { env, root } = withGroups({ junk: { keyword: ["signal"] } });
    const manifest = join(root, "m.json");
    const report = await run(["report", "--keyword", "rust", "--out", manifest], env);
    expect(report.code).toBe(EXIT.OK);
    const replay = await run(["report", "--from", manifest, "--group", "no-such-group"], env);
    expect(replay.code).toBe(EXIT.OK);
  });
});

describe("chaff groups (read)", () => {
  test("says how to create the first one", async () => {
    const { root, env } = fakeEnv();
    roots.push(root);
    const result = await run(["groups"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout.text()).toContain("no groups yet");
    expect(result.stdout.text()).toContain("chaff groups add");
  });

  test("prints every group and the fields it sets", async () => {
    const { env } = withGroups({
      junk: { keyword: ["amazon", "voucher"], scam: true },
      dead: { unavailable: true, inactiveDays: 365 },
    });
    const result = await run(["groups"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout.text()).toContain("junk");
    expect(result.stdout.text()).toContain("keyword:amazon|voucher");
    expect(result.stdout.text()).toContain("scam");
    expect(result.stdout.text()).toContain("inactiveDays:365");
  });

  test("--json prints the fragments, not the rendering", async () => {
    const { env } = withGroups({ junk: { keyword: ["amazon"], scam: true } });
    const result = await run(["groups", "--json"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout.text())).toEqual({
      groups: [{ name: "junk", filter: { keyword: ["amazon"], scam: true } }],
    });
  });

  test("show prints one group, one field per line", async () => {
    const { env } = withGroups({ junk: { keyword: ["amazon"], scam: true }, other: {} });
    const result = await run(["groups", "show", "junk"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout.text()).toContain("keyword");
    expect(result.stdout.text()).toContain("amazon");
    expect(result.stdout.text()).not.toContain("other");
  });

  test("show --json prints the fragment", async () => {
    const { env } = withGroups({ junk: { keyword: ["amazon"] } });
    const result = await run(["groups", "show", "junk", "--json"], env);
    expect(JSON.parse(result.stdout.text())).toEqual({
      name: "junk",
      filter: { keyword: ["amazon"] },
    });
  });

  test("show of a name that is not there is exit 2 and lists what is", async () => {
    const { env } = withGroups({ junk: { keyword: ["amazon"] } });
    const result = await run(["groups", "show", "nope"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("junk");
  });

  test("show without a name is exit 2", async () => {
    const { env } = withGroups({ junk: {} });
    const result = await run(["groups", "show"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("needs a group name");
  });

  test("an unknown verb is exit 2 and says what the verbs are", async () => {
    const { env } = withGroups({ junk: {} });
    const result = await run(["groups", "frobnicate", "junk"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("show, add, remove, set, unset, drop");
  });

  test("needs no client, no session and no CHAFF_FAKE", async () => {
    const { root, env } = fakeEnv({ CHAFF_FAKE: undefined, CHAFF_FIXTURE: undefined });
    roots.push(root);
    const result = await run(["groups"], env);
    expect(result.code).toBe(EXIT.OK);
  });
});
