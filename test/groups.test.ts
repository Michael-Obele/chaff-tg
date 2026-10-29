/**
 * The named filter groups file (`plan/groups.md`). Offline: a temporary
 * directory stands in for the config directory. No command and no client here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGroupName,
  GROUPS_VERSION,
  GroupsError,
  loadGroups,
  parseGroups,
  saveGroups,
  thinGroup,
} from "../src/core/groups";
import { resolvePaths } from "../src/core/session";
import type { Filters } from "../src/core/types";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chaff-groups-"));
  roots.push(dir);
  return dir;
}

describe("resolvePaths().groupsPath", () => {
  test("sits beside config.json in the XDG config directory", () => {
    const root = tempDir();
    expect(resolvePaths({ XDG_CONFIG_HOME: root }).groupsPath()).toBe(
      join(root, "chaff-tg", "groups.json"),
    );
  });
});

describe("parseGroups", () => {
  test("reads the documented shape and keeps insertion order", () => {
    const groups = parseGroups(
      `{"version":${GROUPS_VERSION},"groups":{"dead":{"unavailable":true},"junk":{"keyword":["amazon"],"scam":true}}}`,
      "/tmp/g.json",
    );
    expect(Object.keys(groups)).toEqual(["dead", "junk"]);
    expect(groups.junk).toEqual({ keyword: ["amazon"], scam: true });
  });

  test("validates a field against the manifest's own filter schema", () => {
    expect(() => parseGroups('{"groups":{"a":{"inactiveDays":"365"}}}', "/tmp/g.json")).toThrow(
      GroupsError,
    );
  });

  test("refuses a key a group may not hold, by name", () => {
    let message = "";
    try {
      parseGroups('{"groups":{"a":{"exclude":[-1001]}}}', "/tmp/g.json");
    } catch (error) {
      message = (error as GroupsError).message;
    }
    expect(message).toContain("exclude");
    expect(message).toContain("not allowed in a group");
  });

  test("drops an unknown key rather than rejecting the file", () => {
    const groups = parseGroups(
      '{"groups":{"a":{"keyword":["x"],"future":{"y":1}}}}',
      "/tmp/g.json",
    );
    expect(groups.a).toEqual({ keyword: ["x"] });
  });

  test("treats a missing version as the current one and refuses a newer number", () => {
    expect(parseGroups('{"groups":{"a":{}}}', "/tmp/g.json")).toEqual({ a: {} });
    expect(() => parseGroups('{"version":2,"groups":{}}', "/tmp/g.json")).toThrow(
      /newer version of chaff/,
    );
  });

  test("refuses a non-object root and non-JSON without echoing content", () => {
    expect(() => parseGroups("[1,2]", "/tmp/g.json")).toThrow(/is malformed/);
    let message = "";
    try {
      parseGroups('{"groups": oops', "/tmp/g.json");
    } catch (error) {
      message = (error as GroupsError).message;
    }
    expect(message).toContain("/tmp/g.json");
    expect(message).not.toContain("oops");
  });
});

describe("checkGroupName", () => {
  test("accepts what a user can type back", () => {
    expect(checkGroupName("deals")).toBe("deals");
    expect(checkGroupName("a.b_c-1")).toBe("a.b_c-1");
  });

  test("refuses a space, a slash or an empty name", () => {
    for (const bad of ["not a name", "a/b", "", "-lead"]) {
      expect(() => checkGroupName(bad)).toThrow(/not usable/);
    }
  });
});

describe("thinGroup", () => {
  test("keeps only the fields that are set", () => {
    const full: Filters = {
      types: null,
      keyword: ["amazon"],
      any: [],
      not: [],
      regex: null,
      ids: null,
      muted: null,
      archived: null,
      inactiveDays: null,
      members: null,
      scam: true,
      fake: false,
      banned: false,
      unavailable: false,
      unread: null,
      pinned: null,
      include: [],
      exclude: [],
      limit: null,
    };
    expect(thinGroup(full)).toEqual({ keyword: ["amazon"], scam: true });
  });

  test("keeps a switch that is deliberately off", () => {
    expect(thinGroup({ muted: false, scam: false })).toEqual({ muted: false });
  });
});

describe("loadGroups and saveGroups", () => {
  test("a file that is not there is no groups, not an error", () => {
    expect(loadGroups(join(tempDir(), "absent.json"))).toEqual({});
  });

  test("writes mode 644, creates its directory, and round-trips", () => {
    const path = join(tempDir(), "chaff-tg", "groups.json");
    saveGroups(path, { junk: { keyword: ["amazon"], scam: true } });
    expect((statSync(path).mode & 0o777).toString(8)).toBe("644");
    expect(loadGroups(path)).toEqual({ junk: { keyword: ["amazon"], scam: true } });
  });

  test("an unreadable file says why without quoting it", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "groups.json"), "[]");
    expect(() => loadGroups(join(dir, "groups.json"))).toThrow(/is malformed/);
  });
});
