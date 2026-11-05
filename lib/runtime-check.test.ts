/** DW-4.1: checkBunRuntime table tests. */
import { describe, test, expect } from "bun:test";
import { checkBunRuntime, MIN_BUN_VERSION } from "./core.ts";

describe("checkBunRuntime", () => {
  test("test_DW_4_1_1_4_3_is_too_old_and_note_names_version_minimum_and_upgrade", () => {
    const note = checkBunRuntime("1.4.3");
    expect(note).not.toBeNull();
    expect(note).toContain("1.4.3");
    expect(note).toContain("1.4.4");
    expect(note).toContain("bun upgrade");
    expect(note).not.toContain("\n");
  });

  test.each(["1.4.4", "1.5.0", "2.0.0", "1.10.0", "1.4.10", "v1.4.4"])("test_DW_4_1_%s_is_supported", (v) => {
    expect(checkBunRuntime(v)).toBeNull();
  });

  test.each(["0.9.9", "1.3.99", "1.4.0", "0.0.1"])("%s is too old", (v) => {
    expect(checkBunRuntime(v)).toContain(v);
  });

  test("test_DW_4_1_undefined_version_gives_no_note", () => {
    expect(checkBunRuntime(undefined)).toBeNull();
  });

  test("test_DW_4_1_prerelease_of_minimum_counts_as_the_base_version", () => {
    expect(checkBunRuntime("1.4.4-canary.1")).toBeNull();
    expect(checkBunRuntime("1.4.4+abc123")).toBeNull();
    expect(checkBunRuntime("1.4.3-canary.1")).not.toBeNull(); // base is still below
  });

  test.each(["abc", "", "1.4", "1", "x.y.z"])("test_DW_4_1_malformed_%p_gives_no_note", (v) => {
    expect(checkBunRuntime(v)).toBeNull();
  });

  test("MIN_BUN_VERSION matches package.json engines and .bun-version", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { engines: { bun: string } };
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
    expect((await Bun.file(new URL("../.bun-version", import.meta.url)).text()).trim()).toBe(MIN_BUN_VERSION);
  });
});
