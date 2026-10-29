/**
 * `chaff groups` and `--group` end to end, through `runCli` (`plan/groups.md`).
 * The fake client and the Task 2 fixtures keep this offline; the groups file
 * lives in a temporary XDG config directory, so no real `~/.config` is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    // A switch prints bare in the table, so `scam:true` must not appear here.
    expect(result.stdout.text()).toMatch(/scam(?!:)/);
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

describe("chaff groups (write)", () => {
  test("add creates the file and the group", async () => {
    const { root, env } = fakeEnv();
    roots.push(root);
    const path = resolvePaths(env).groupsPath();
    const added = await run(["groups", "add", "deals", "amazon,voucher"], env);
    expect(added.code).toBe(EXIT.OK);
    expect(loadGroups(path)).toEqual({ deals: { keyword: ["amazon", "voucher"] } });
    expect(added.stdout.text()).toContain("keyword:amazon|voucher");
  });

  test("add unions into an existing group and keeps its other fields", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"], scam: true } });
    const result = await run(["groups", "add", "deals", "amazon,voucher"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(loadGroups(path)).toEqual({ deals: { keyword: ["amazon", "voucher"], scam: true } });
  });

  test("add twice changes nothing the second time", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"] } });
    await run(["groups", "add", "deals", "amazon"], env);
    expect(loadGroups(path)).toEqual({ deals: { keyword: ["amazon"] } });
  });

  test("remove drops words and ignores words that are not there", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon", "voucher"] } });
    const result = await run(["groups", "remove", "deals", "voucher,ghost"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(loadGroups(path)).toEqual({ deals: { keyword: ["amazon"] } });
  });

  test("set writes the flags typed and leaves the other fields alone", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"] } });
    const result = await run(["groups", "set", "deals", "--scam", "--inactive-days", "365"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(loadGroups(path)).toEqual({
      deals: { keyword: ["amazon"], scam: true, inactiveDays: 365 },
    });
  });

  test("set replaces a field it is given twice", async () => {
    const { env, path } = withGroups({ deals: { inactiveDays: 30 } });
    await run(["groups", "set", "deals", "--inactive-days", "365"], env);
    expect(loadGroups(path)).toEqual({ deals: { inactiveDays: 365 } });
  });

  test("set with no flags is refused", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "set", "deals"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("at least one filter flag");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("unset removes named fields", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"], scam: true } });
    const result = await run(["groups", "unset", "deals", "scam"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(loadGroups(path)).toEqual({ deals: { keyword: ["amazon"] } });
  });

  test("unset of a field a group cannot hold is exit 2", async () => {
    const { env } = withGroups({ deals: { keyword: ["amazon"] } });
    const result = await run(["groups", "unset", "deals", "exclude"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("unknown field");
  });

  test("drop deletes the group and leaves the others", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"] }, betting: { scam: true } });
    const result = await run(["groups", "drop", "deals"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(loadGroups(path)).toEqual({ betting: { scam: true } });
    expect(result.stdout.text()).toContain("dropped deals");
  });

  test("drop of a name that is not there is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "drop", "nope"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a name that cannot be typed back is exit 2", async () => {
    const { env } = withGroups({});
    const result = await run(["groups", "add", "not a name", "amazon"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("not usable");
  });

  test("add without a word list is exit 2", async () => {
    const { env } = withGroups({});
    const result = await run(["groups", "add", "deals"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("needs a comma separated list");
  });

  test("a broken file is refused before anything is written", async () => {
    const { root, env } = fakeEnv();
    roots.push(root);
    const path = resolvePaths(env).groupsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    const result = await run(["groups", "add", "deals", "amazon"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("is not valid JSON");
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  test("what a write saved is what --group uses", async () => {
    const { env } = withGroups({});
    const added = await run(["groups", "add", "junk", "signal,airdrop"], env);
    expect(added.code).toBe(EXIT.OK);
    const set = await run(["groups", "set", "junk", "--type", "channel"], env);
    expect(set.code).toBe(EXIT.OK);
    const viaGroup = await run(["list", "--group", "junk", "--json"], env);
    const typed = await run(
      ["list", "--keyword", "signal,airdrop", "--type", "channel", "--json"],
      env,
    );
    expect(viaGroup.stdout.text()).toBe(typed.stdout.text());
  });

  test("remove of a name that is not there is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "remove", "typo", "x"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("no group named");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("unset of a name that is not there is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ deals: { keyword: ["amazon"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "unset", "typo", "scam"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("no group named");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("chaff groups (arity)", () => {
  test("list with an extra token is exit 2", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal"] } });
    const result = await run(["groups", "list", "extra"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups list");
    expect(result.stderr.text()).toContain("takes no");
  });

  test("show with an extra token is exit 2", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal"] } });
    const result = await run(["groups", "show", "junk", "extra"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups show");
    expect(result.stderr.text()).toContain("exactly one");
  });

  test("drop with an extra token is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ junk: { keyword: ["signal"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "drop", "junk", "extra"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups drop");
    expect(result.stderr.text()).toContain("exactly one");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("add with an extra token is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ junk: { keyword: ["signal"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "add", "junk", "signal,airdrop", "extra"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups add");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("remove with an extra token is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ junk: { keyword: ["signal", "airdrop"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "remove", "junk", "airdrop", "extra"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups remove");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("unset with an extra token is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ junk: { keyword: ["signal"], scam: true } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "unset", "junk", "scam", "extra"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups unset");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("unset with an empty list is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ junk: { keyword: ["signal"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "unset", "junk", ""], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups unset junk needs at least one word");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("set with an extra token is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({ junk: { keyword: ["signal"] } });
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "set", "junk", "extra", "--scam"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups set takes exactly one");
    expect(result.stderr.text()).toContain("extra");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("add with an empty list is exit 2 and writes nothing", async () => {
    const { env, path } = withGroups({});
    const before = readFileSync(path, "utf8");
    const result = await run(["groups", "add", "junk", ""], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups add junk needs at least one word");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("set refuses a field a group cannot hold, by name, and writes nothing", async () => {
    const { env, path } = withGroups({});
    const result = await run(["groups", "set", "junk", "--scam", "--exclude", "-1001"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain('"exclude" is not allowed in a group');
    expect(loadGroups(path)).toEqual({});
  });

  test("set catches the ids flag even though the field is named ids", async () => {
    const { env, path } = withGroups({});
    const result = await run(["groups", "set", "junk", "--id", "-1001"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain('"ids" is not allowed in a group');
    expect(loadGroups(path)).toEqual({});
  });

  test("set refuses to fold in another group", async () => {
    const { env, path } = withGroups({ other: { scam: true } });
    const result = await run(["groups", "set", "junk", "--group", "other", "--scam"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("does not fold in other groups");
    expect(loadGroups(path)).toEqual({ other: { scam: true } });
  });

  test("a bad group is refused before any client opens", async () => {
    const { root, env } = fakeEnv({ CHAFF_FAKE: undefined, CHAFF_FIXTURE: undefined });
    roots.push(root);
    const path = resolvePaths(env).groupsPath();
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{ not json");
    const result = await run(["list", "--group", "junk"], env);
    // Without the ordering fix this is exit 3 (not logged in): the client opens
    // first and the groups file is never reached.
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups file at");
  });
});

describe("chaff groups check", () => {
  test("counts the group and each of its parts", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal", "airdrop"], scam: true } });
    const result = await run(["groups", "check", "junk"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout.text()).toContain("group");
    expect(result.stdout.text()).toContain("keyword:signal");
    expect(result.stdout.text()).toContain("keyword:airdrop");
    expect(result.stdout.text()).toContain("scam");
  });

  test("a word that matches nothing is called out, which is the whole point", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal", "cryto"] } });
    const result = await run(["groups", "check", "junk"], env);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout.text()).toContain("keyword:cryto");
    expect(result.stdout.text()).toContain("matches nothing on its own: keyword:cryto");
  });

  test("--json carries the counts, not the rendering", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal", "cryto"] } });
    const result = await run(["groups", "check", "junk", "--json"], env);
    expect(result.code).toBe(EXIT.OK);
    const doc = JSON.parse(result.stdout.text()) as {
      name: string;
      total: number;
      parts: { key: string; count: number }[];
    };
    expect(doc.name).toBe("junk");
    expect(typeof doc.total).toBe("number");
    expect(doc.parts).toContainEqual({ key: "keyword:cryto", count: 0 });
  });

  test("needs a group name", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal"] } });
    const result = await run(["groups", "check"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("groups check needs a group name");
  });

  test("refuses a name that is not there, without a Telegram request", async () => {
    const { env } = withGroups({ junk: { keyword: ["signal"] } });
    const result = await run(["groups", "check", "nope"], env);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.text()).toContain("no group named");
  });

  test("is the one groups verb that needs a session", async () => {
    const { env, root } = withGroups({ junk: { keyword: ["signal"] } });
    void root;
    const loggedOut = { ...env, CHAFF_FAKE: undefined, CHAFF_FIXTURE: undefined };
    const result = await run(["groups", "check", "junk"], loggedOut);
    expect(result.code).toBe(EXIT.NOT_LOGGED_IN);
  });
});
