/**
 * Structural tests for repo scaffold and package.json.
 *
 * Covers DW-1.1: repo exists with lib/, bin/, mcp/, references/, tests/ directories.
 * Covers DW-1.8: package.json has correct dependencies (no cross-keychain),
 *   Bun test runner configured.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

describe("DW-1.1: repo directory structure", () => {
  it("test_DW_1_1_repo_directories_exist", () => {
    const requiredDirs = ["lib", "bin", "mcp", "references", "tests"];

    for (const dir of requiredDirs) {
      const dirPath = path.join(REPO_ROOT, dir);
      const exists = fs.existsSync(dirPath);
      expect(exists).toBe(true);
    }
  });
});

describe("DW-1.8: package.json", () => {
  const pkgPath = path.join(REPO_ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  it("test_DW_1_8_package_json_dependencies", () => {
    const deps = pkg.dependencies ?? {};
    expect(deps["fflate"]).toBeDefined();
    expect(deps["zod"]).toBeDefined();
    expect(deps["citty"]).toBeDefined();
    expect(deps["@modelcontextprotocol/sdk"]).toBeDefined();
    expect(deps["open"]).toBeDefined();
  });

  it("test_DW_1_8_no_cross_keychain", () => {
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    expect(allDeps["cross-keychain"]).toBeUndefined();
  });

  it("bun test runner configured", () => {
    expect(pkg.scripts?.test).toContain("bun test");
  });
});
