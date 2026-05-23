/**
 * Phase 2: Remove CLI + npm infra, update manifests and docs.
 *
 * These tests validate that CLI artifacts are deleted, package.json
 * is cleaned, manifests are updated, and docs are MCP-only.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function readJson(relPath: string): unknown {
  const full = join(ROOT, relPath);
  const raw = readFileSync(full, "utf-8");
  return JSON.parse(raw);
}

function readText(relPath: string): string {
  const full = join(ROOT, relPath);
  return readFileSync(full, "utf-8");
}

function fileExists(relPath: string): boolean {
  return existsSync(join(ROOT, relPath));
}

// ─── DW-2.1: CLI files deleted ──────────────────────────────────────────────

describe("DW-2.1 CLI files deleted", () => {
  test("test_DW_2_1_bin_upublish_deleted", () => {
    expect(fileExists("bin/upublish.ts")).toBe(false);
  });

  test("test_DW_2_1_dist_cli_cjs_deleted", () => {
    expect(fileExists("dist/cli.cjs")).toBe(false);
  });

  test("test_DW_2_1_install_sh_deleted", () => {
    expect(fileExists("install.sh")).toBe(false);
  });

  test("test_DW_2_1_scripts_publish_sh_deleted", () => {
    expect(fileExists("scripts/publish.sh")).toBe(false);
  });
});

// ─── DW-2.2: CLI test files deleted ─────────────────────────────────────────

describe("DW-2.2 CLI test files deleted", () => {
  test("test_DW_2_2_cli_test_deleted", () => {
    expect(fileExists("tests/cli.test.ts")).toBe(false);
  });

  test("test_DW_2_2_install_test_deleted", () => {
    expect(fileExists("tests/install.test.ts")).toBe(false);
  });
});

// ─── DW-2.3: Stale artifacts deleted ────────────────────────────────────────

describe("DW-2.3 stale artifacts deleted", () => {
  test("test_DW_2_3_building_dir_deleted", () => {
    expect(fileExists(".claude/code-foundations/building")).toBe(false);
  });

  test("test_DW_2_3_phase6_review_deleted", () => {
    expect(fileExists(".claude/phase6-review.sh")).toBe(false);
  });
});

// ─── DW-2.4: package.json cleaned ──────────────────────────────────────────

describe("DW-2.4 package.json no CLI artifacts", () => {
  test("test_DW_2_4_no_bin_field", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    expect(pkg.bin).toBeUndefined();
  });

  test("test_DW_2_4_no_citty_dependency", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    const deps = pkg.dependencies as Record<string, unknown>;
    expect(deps.citty).toBeUndefined();
  });

  test("test_DW_2_4_dist_in_files", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    const files = pkg.files as string[];
    expect(files).toContain("dist/");
  });

  test("test_DW_2_4_no_bin_in_files", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    const files = pkg.files as string[];
    expect(files).not.toContain("bin/");
  });

  test("test_DW_2_4_no_install_sh_in_files", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    const files = pkg.files as string[];
    expect(files).not.toContain("install.sh");
  });
});

// ─── DW-2.5: gemini-extension.json updated ──────────────────────────────────

describe("DW-2.5 gemini-extension.json uses extensionPath and correct version", () => {
  test("test_DW_2_5_uses_bun_command", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.upublish.command).toBe("bun");
  });

  test("test_DW_2_5_uses_extension_path_in_args", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, Record<string, unknown>>;
    const args = servers.upublish.args as string[];
    expect(args).toContain("run");
    const hasExtPath = args.some((a) => a.includes("${extensionPath}"));
    expect(hasExtPath).toBe(true);
  });

  test("test_DW_2_5_no_cwd_field", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.upublish.cwd).toBeUndefined();
  });

  test("test_DW_2_5_version_matches_package_json", () => {
    const gemini = readJson("gemini-extension.json") as Record<string, unknown>;
    const pkg = readJson("package.json") as Record<string, unknown>;
    expect(gemini.version).toBe(pkg.version);
  });
});

// ─── DW-2.6: CI workflow updated ────────────────────────────────────────────

describe("DW-2.6 CI workflow no npm publish, has gemini version bump", () => {
  test("test_DW_2_6_no_npm_publish_job", () => {
    const content = readText(".github/workflows/ci.yml");
    expect(content).not.toContain("npm publish");
    expect(content).not.toContain("NPM_TOKEN");
  });

  test("test_DW_2_6_gemini_version_bump_in_sed_step", () => {
    const content = readText(".github/workflows/ci.yml");
    expect(content).toContain("gemini-extension.json");
  });

  test("test_DW_2_6_gemini_in_git_add", () => {
    const content = readText(".github/workflows/ci.yml");
    // The git add line should include gemini-extension.json
    const gitAddMatch = content.match(/git add.*gemini-extension\.json/);
    expect(gitAddMatch).not.toBeNull();
  });
});

// ─── DW-2.7: SKILL.md MCP-only ─────────────────────────────────────────────

describe("DW-2.7 SKILL.md no CLI commands", () => {
  test("test_DW_2_7_no_upublish_login_command", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).not.toContain("upublish login");
  });

  test("test_DW_2_7_no_upublish_configure_command", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).not.toContain("upublish configure");
  });

  test("test_DW_2_7_no_upublish_status_command", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).not.toContain("upublish status");
  });

  test("test_DW_2_7_no_upublish_hello_command", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).not.toContain("upublish hello");
  });

  test("test_DW_2_7_no_npm_install_command", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).not.toContain("npm install");
  });

  test("test_DW_2_7_no_which_upublish", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).not.toContain("which upublish");
  });

  test("test_DW_2_7_no_cli_fallback_table", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).not.toContain("CLI fallback");
  });

  test("test_DW_2_7_has_mcp_status_tool", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("status");
  });

  test("test_DW_2_7_has_mcp_login_tool", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("login");
  });

  test("test_DW_2_7_has_mcp_publish_tool", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("mcp_upublish_publish");
  });
});

// ─── DW-2.8: GEMINI.md MCP-only ────────────────────────────────────────────

describe("DW-2.8 GEMINI.md no CLI commands", () => {
  test("test_DW_2_8_no_upublish_login_command", () => {
    const content = readText("GEMINI.md");
    expect(content).not.toContain("upublish login");
  });

  test("test_DW_2_8_no_bin_upublish_reference", () => {
    const content = readText("GEMINI.md");
    expect(content).not.toContain("bin/upublish");
  });

  test("test_DW_2_8_no_bun_install_step", () => {
    const content = readText("GEMINI.md");
    expect(content).not.toContain("bun install");
  });

  test("test_DW_2_8_has_login_tool", () => {
    const content = readText("GEMINI.md");
    expect(content).toContain("mcp_upublish_login");
  });

  test("test_DW_2_8_has_status_tool", () => {
    const content = readText("GEMINI.md");
    expect(content).toContain("mcp_upublish_status");
  });

  test("test_DW_2_8_has_passcode_tools", () => {
    const content = readText("GEMINI.md");
    expect(content).toContain("mcp_upublish_passcode");
  });
});

// ─── DW-2.9: troubleshooting.md no CLI ──────────────────────────────────────

describe("DW-2.9 troubleshooting.md no CLI references", () => {
  test("test_DW_2_9_no_upublish_login", () => {
    const content = readText("references/troubleshooting.md");
    expect(content).not.toContain("upublish login");
  });

  test("test_DW_2_9_no_upublish_status", () => {
    const content = readText("references/troubleshooting.md");
    expect(content).not.toContain("upublish status");
  });

  test("test_DW_2_9_uses_mcp_tool_references", () => {
    const content = readText("references/troubleshooting.md");
    // Should reference MCP login tool instead of CLI
    expect(content).toContain("login");
  });
});

// ─── DW-2.10: CLAUDE.md updated ────────────────────────────────────────────

describe("DW-2.10 CLAUDE.md no CLI references, current version", () => {
  test("test_DW_2_10_no_bin_upublish", () => {
    const content = readText("CLAUDE.md");
    expect(content).not.toContain("bin/upublish.ts");
  });

  test("test_DW_2_10_no_cli_cjs", () => {
    const content = readText("CLAUDE.md");
    expect(content).not.toContain("cli.cjs");
  });

  test("test_DW_2_10_no_citty", () => {
    const content = readText("CLAUDE.md");
    expect(content).not.toContain("citty");
  });

  test("test_DW_2_10_no_stale_version", () => {
    const content = readText("CLAUDE.md");
    expect(content).not.toContain("0.4.0");
  });

  test("test_DW_2_10_no_npm_publish", () => {
    const content = readText("CLAUDE.md");
    expect(content).not.toContain("Publishing to npm");
    expect(content).not.toContain("scripts/publish.sh");
  });

  test("test_DW_2_10_mentions_gemini_version_sync", () => {
    const content = readText("CLAUDE.md");
    expect(content).toContain("gemini-extension.json");
  });
});

// ─── DW-2.11: README.md no CLI install ──────────────────────────────────────

describe("DW-2.11 README.md no CLI install instructions", () => {
  test("test_DW_2_11_no_npm_install", () => {
    const content = readText("README.md");
    expect(content).not.toContain("npm install");
  });

  test("test_DW_2_11_no_install_sh", () => {
    const content = readText("README.md");
    expect(content).not.toContain("install.sh");
  });

  test("test_DW_2_11_no_upublish_cli_command", () => {
    const content = readText("README.md");
    // Should not reference CLI commands like "upublish login" outside of MCP context
    expect(content).not.toContain("upublish login");
  });

  test("test_DW_2_11_has_plugin_install", () => {
    const content = readText("README.md");
    // Should still have plugin install instructions
    expect(content).toContain("plugin");
  });
});

// ─── DW-2.12: manifests.test.ts no CLI assertions ──────────────────────────

describe("DW-2.12 manifests.test.ts cleaned of CLI assertions", () => {
  test("test_DW_2_12_no_install_sh_tests", () => {
    const content = readText("tests/manifests.test.ts");
    expect(content).not.toContain("install.sh");
  });

  test("test_DW_2_12_no_npx_assertion", () => {
    const content = readText("tests/manifests.test.ts");
    expect(content).not.toContain("uses_npx_command");
  });

  test("test_DW_2_12_no_cli_cjs_assertion", () => {
    const content = readText("tests/manifests.test.ts");
    expect(content).not.toContain("cli.cjs");
  });

  test("test_DW_2_12_no_bin_upublish_assertion", () => {
    const content = readText("tests/manifests.test.ts");
    expect(content).not.toContain("bin/upublish");
  });
});

// ─── DW-2.13: No citty in lockfile ──────────────────────────────────────────

describe("DW-2.13 no citty in lockfile", () => {
  test("test_DW_2_13_no_citty_in_lockfile", () => {
    const content = readText("bun.lock");
    expect(content).not.toContain("citty");
  });
});
