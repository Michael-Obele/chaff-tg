import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/core/index";

describe("scaffold smoke test", () => {
  test("VERSION matches package.json version", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
