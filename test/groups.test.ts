/**
 * The named filter groups file (`plan/groups.md`). Offline: a temporary
 * directory stands in for the config directory. No command and no client here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWords,
  checkGroupName,
  dropGroup,
  GROUPS_VERSION,
  GroupsError,
  loadGroups,
  mergeGroups,
  parseGroups,
  removeWords,
  saveGroups,
  setFields,
  thinGroup,
  unsetFields,
  type GroupFilter,
  type Groups,
} from "../src/core/groups";
import { emptyFilters } from "../src/cli/args";
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

/** A complete `Filters` at "nothing set", from the parser's own defaults. */
function unset(overrides: Partial<Filters> = {}): Filters {
  return { ...emptyFilters(), ...overrides };
}

/** The flag spellings a typed `Filters` carries, as `provided` would. */
function provided(...flags: string[]): Set<string> {
  return new Set(flags);
}

describe("mergeGroups", () => {
  const groups: Groups = {
    deals: { keyword: ["amazon"], inactiveDays: 30 },
    betting: { keyword: ["bet"], types: ["channel"] },
    wide: { inactiveDays: 365 },
  };

  test("a group's fields land in the filter set as if typed", () => {
    expect(mergeGroups(groups, ["deals"], unset(), provided())).toEqual(
      unset({ keyword: ["amazon"], inactiveDays: 30 }),
    );
  });

  test("two groups union their lists", () => {
    const merged = mergeGroups(groups, ["deals", "betting"], unset(), provided());
    expect(merged.keyword).toEqual(["amazon", "bet"]);
    expect(merged.types).toEqual(["channel"]);
  });

  test("typed words append after the group's, deduped case-insensitively", () => {
    const merged = mergeGroups(
      { a: { keyword: ["Amazon"] } },
      ["a"],
      unset({ keyword: ["amazon", "vip"] }),
      provided("keyword"),
    );
    expect(merged.keyword).toEqual(["Amazon", "vip"]);
  });

  test("a typed flag beats the group's value", () => {
    const merged = mergeGroups(
      groups,
      ["deals"],
      unset({ inactiveDays: 7 }),
      provided("inactive-days"),
    );
    expect(merged.inactiveDays).toBe(7);
  });

  test("a group beats the unset default", () => {
    const merged = mergeGroups(groups, ["deals"], unset(), provided());
    expect(merged.inactiveDays).toBe(30);
  });

  test("two groups that disagree on a scalar are an error naming both", () => {
    let message = "";
    try {
      mergeGroups(
        { ...groups, wide: { inactiveDays: 365 } },
        ["deals", "wide"],
        unset(),
        provided(),
      );
    } catch (error) {
      message = (error as GroupsError).message;
    }
    expect(message).toContain("inactive-days");
    expect(message).toContain("deals");
    expect(message).toContain("wide");
    expect(message).toContain("30");
    expect(message).toContain("365");
  });

  test("two groups that agree are not a disagreement", () => {
    const same = { a: { inactiveDays: 30 }, b: { inactiveDays: 30 } };
    expect(mergeGroups(same, ["a", "b"], unset(), provided()).inactiveDays).toBe(30);
  });

  test("two groups that agree on a members range are not a disagreement", () => {
    const pair = {
      a: { members: { min: 10, max: 100 } },
      b: { members: { min: 10, max: 100 } },
    };
    expect(mergeGroups(pair, ["a", "b"], unset(), provided()).members).toEqual({
      min: 10,
      max: 100,
    });
  });

  test("a boolean left false by a second group does not conflict", () => {
    const pair = { a: { scam: true }, b: { scam: false } };
    expect(mergeGroups(pair, ["a", "b"], unset(), provided()).scam).toBe(true);
  });

  test("a negated spelling counts as the command line speaking for the field", () => {
    const merged = mergeGroups(groups, ["deals"], unset({ muted: false }), provided("not-muted"));
    expect(merged.muted).toBe(false);
  });

  test("an unknown name is an error that lists what exists", () => {
    let message = "";
    try {
      mergeGroups(groups, ["nope"], unset(), provided());
    } catch (error) {
      message = (error as GroupsError).message;
    }
    expect(message).toContain('no group named "nope"');
    expect(message).toContain("deals, betting, wide");
  });

  test("no names returns the typed filters untouched", () => {
    const typed = unset({ keyword: ["x"] });
    expect(mergeGroups(groups, [], typed, provided("keyword"))).toBe(typed);
  });
});

describe("mutations", () => {
  test("addWords unions into keyword and creates the group", () => {
    expect(addWords({}, "deals", ["amazon", "Amazon"])).toEqual({ deals: { keyword: ["amazon"] } });
  });

  test("removeWords drops words and leaves the group behind", () => {
    expect(removeWords({ deals: { keyword: ["amazon", "deal"] } }, "deals", ["amazon"])).toEqual({
      deals: { keyword: ["deal"] },
    });
    expect(removeWords({ deals: { keyword: ["amazon"] } }, "deals", ["amazon"])).toEqual({
      deals: { keyword: [] },
    });
  });

  test("removeWords refuses a name that is not there", () => {
    expect(() => removeWords({}, "typosome", ["word"])).toThrow(/no group named "typosome"/);
    expect(() => removeWords({ deals: { keyword: ["amazon"] } }, "typosome", ["word"])).toThrow(
      /no group named "typosome"/,
    );
  });

  test("setFields replaces only the fields given", () => {
    const next = setFields({ deals: { keyword: ["amazon"], scam: true } }, "deals", {
      keyword: ["voucher"],
    });
    expect(next.deals).toEqual({ scam: true, keyword: ["voucher"] });
  });

  test("setFields refuses a forbidden key by name", () => {
    expect(() => setFields({}, "deals", { exclude: [-1] } as GroupFilter)).toThrow(
      /not allowed in a group/,
    );
  });

  test("setFields refuses an empty fragment", () => {
    expect(() => setFields({}, "deals", {})).toThrow(/needs at least one filter flag/);
    expect(() => setFields({}, "deals", { keyword: [], scam: false })).toThrow(
      /needs at least one filter flag/,
    );
  });

  test("unsetFields drops named keys and refuses a name that is not a field", () => {
    expect(unsetFields({ deals: { keyword: ["amazon"], scam: true } }, "deals", ["scam"])).toEqual({
      deals: { keyword: ["amazon"] },
    });
    expect(() => unsetFields({ deals: { keyword: ["amazon"] } }, "deals", ["scams"])).toThrow(
      /unknown field/,
    );
  });

  test("unsetFields refuses a name that is not there", () => {
    expect(() => unsetFields({}, "typosome", ["scam"])).toThrow(/no group named "typosome"/);
  });

  test("remove and unset report a bad name before a missing group", () => {
    expect(() => removeWords({}, "bad name", ["x"])).toThrow(/not usable/);
    expect(() => unsetFields({}, "bad name", ["scam"])).toThrow(/not usable/);
  });

  test("dropGroup deletes the name and refuses a typo", () => {
    expect(dropGroup({ a: {}, b: {} }, "a")).toEqual({ b: {} });
    expect(() => dropGroup({ a: {} }, "z")).toThrow(/no group named/);
  });

  test("no mutation touches the map it was handed", () => {
    const before: Groups = { deals: { keyword: ["amazon"] } };
    addWords(before, "deals", ["voucher"]);
    setFields(before, "deals", { scam: true });
    expect(before).toEqual({ deals: { keyword: ["amazon"] } });
  });
});
