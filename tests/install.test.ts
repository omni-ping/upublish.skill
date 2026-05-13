/**
 * Phase 5: Install Script + npm Package + Integration Test validation tests.
 *
 * These tests validate the install.sh structure (POSIX compatibility, correct
 * flow), package.json npm publish configuration, and Node.js shim for npx
 * fallback. DW-5.6 and DW-5.7 are manual tests — here we verify their
 * structural prerequisites are in place.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Root of the skill repo (one level up from tests/)
const ROOT = resolve(import.meta.dir, "..");

function readText(relPath: string): string {
  const full = join(ROOT, relPath);
  return readFileSync(full, "utf-8");
}

function fileExists(relPath: string): boolean {
  return existsSync(join(ROOT, relPath));
}

function readJson(relPath: string): unknown {
  const full = join(ROOT, relPath);
  const raw = readFileSync(full, "utf-8");
  return JSON.parse(raw);
}

// ─── DW-5.1: install.sh installs CLI ─────────────────────────────────────────

describe("DW-5.1 install.sh installs CLI", () => {
  test("test_DW_5_1_install_sh_exists", () => {
    expect(fileExists("install.sh")).toBe(true);
  });

  test("test_DW_5_1_install_sh_posix_compatible", () => {
    const content = readText("install.sh");
    // Must use #!/bin/sh (not #!/bin/bash)
    expect(content).toMatch(/^#!\/bin\/sh/);
    // Must not use bash-specific [[ ]]
    expect(content).not.toContain("[[");
    // Must not use bash-specific ${var,,} (lowercase expansion)
    expect(content).not.toMatch(/\$\{[^}]+,,\}/);
    // Must not use bash-specific arrays (declare -a)
    expect(content).not.toContain("declare -a");
  });

  test("test_DW_5_1_install_sh_installs_bun_if_missing", () => {
    const content = readText("install.sh");
    // Must check for bun and install if missing
    expect(content).toContain("bun");
    expect(content).toContain("bun.sh/install");
  });

  test("test_DW_5_1_install_sh_clones_repo", () => {
    const content = readText("install.sh");
    // Must clone the repo
    expect(content).toContain("omni-ping/upublish.skill");
    // Must use git clone
    expect(content).toContain("git clone");
  });

  test("test_DW_5_1_install_sh_adds_to_path", () => {
    const content = readText("install.sh");
    // Must add to PATH
    expect(content).toContain("PATH");
    // Must reference a bin directory
    expect(content).toContain("bin");
  });

  test("test_DW_5_1_install_sh_exits_nonzero_on_failure", () => {
    const content = readText("install.sh");
    // Must use set -e or explicit exit 1 on errors
    const hasSete = content.includes("set -e");
    const hasExitOne = content.includes("exit 1");
    expect(hasSete || hasExitOne).toBe(true);
  });

  test("test_DW_5_1_install_sh_runs_login", () => {
    const content = readText("install.sh");
    // Must run upublish login after install
    expect(content).toContain("upublish login");
  });
});

// ─── DW-5.2: npx skills add omni-ping/upublish.skill ─────────────────────────

describe("DW-5.2 npx skills add omni-ping/upublish.skill", () => {
  test("test_DW_5_2_skills_valid_for_skills_add", () => {
    // skills/ must exist with ask and setup
    expect(fileExists("skills/upublish/SKILL.md")).toBe(true);
    expect(fileExists("skills/upublish-setup/SKILL.md")).toBe(true);
    const ask = readText("skills/upublish/SKILL.md");
    expect(ask).toMatch(/^---\n/);
    expect(ask).toContain("name: upublish");
    expect(ask).toContain("description:");
    const setup = readText("skills/upublish-setup/SKILL.md");
    expect(setup).toMatch(/^---\n/);
    expect(setup).toContain("name: upublish-setup");
  });

  test("test_DW_5_2_repo_name_matches_install_command", () => {
    // install.sh must reference the correct GitHub repo name
    const installContent = readText("install.sh");
    expect(installContent).toContain("omni-ping/upublish.skill");
  });
});

// ─── DW-5.3: MCP tools appear in Claude Code after session restart ────────────

describe("DW-5.3 MCP tools appear in Claude Code", () => {
  test("test_DW_5_3_claude_plugin_json_has_mcp_config", () => {
    const data = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
    // Must have mcpServers config that enables MCP tool registration
    expect(data.mcpServers).toBeDefined();
    const servers = data.mcpServers as Record<string, unknown>;
    expect(servers.upublish).toBeDefined();
  });

  test("test_DW_5_3_mcp_json_enables_mcp_tools", () => {
    const data = readJson(".mcp.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    // Must have command and args to start MCP server
    expect(upublish.command).toBe("bun");
    expect(Array.isArray(upublish.args)).toBe(true);
    const args = upublish.args as string[];
    expect(args.some((a) => a.includes("mcp") && a.includes("index.ts"))).toBe(true);
  });

  test("test_DW_5_3_setup_skill_mentions_restart", () => {
    const content = readText("skills/upublish-setup/SKILL.md");
    expect(content.toLowerCase()).toContain("restart");
  });
});

// ─── DW-5.4: Codex plugin installs and MCP tools available ───────────────────

describe("DW-5.4 Codex plugin install checklist", () => {
  test("test_DW_5_4_codex_install_files_complete", () => {
    // All files required for Codex plugin installation must exist
    expect(fileExists(".codex-plugin/plugin.json")).toBe(true);
    expect(fileExists(".mcp.json")).toBe(true);
    // Codex plugin.json must reference .mcp.json
    const data = readJson(".codex-plugin/plugin.json") as Record<string, unknown>;
    expect(data.mcpServers).toBeDefined();
    // Should reference the .mcp.json file
    const mcpServersRef = data.mcpServers as string;
    expect(mcpServersRef).toContain(".mcp.json");
  });

  test("test_DW_5_4_codex_plugin_has_required_interface_fields", () => {
    const data = readJson(".codex-plugin/plugin.json") as Record<string, unknown>;
    const iface = data.interface as Record<string, unknown>;
    expect(typeof iface.displayName).toBe("string");
    expect(typeof iface.shortDescription).toBe("string");
    expect(typeof iface.developerName).toBe("string");
    expect(typeof iface.category).toBe("string");
  });

  test("test_DW_5_4_mcp_json_uses_bun_to_start_server", () => {
    const data = readJson(".mcp.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    // Codex will use bun to start the MCP server
    expect(upublish.command).toBe("bun");
  });
});

// ─── DW-5.5: npm install -g @omniping/upublish && upublish login ──────────────────

describe("DW-5.5 npm global install works as npx fallback", () => {
  test("test_DW_5_5_package_name_is_upublish_cli", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    expect(pkg.name).toBe("@omniping/upublish");
  });

  test("test_DW_5_5_bin_entry_exists", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    const bin = pkg.bin as Record<string, string>;
    expect(bin).toBeDefined();
    expect(typeof bin.upublish).toBe("string");
  });

  test("test_DW_5_5_node_shim_file_exists", () => {
    // dist/cli.cjs must exist as a Node.js-compatible entry point
    expect(fileExists("dist/cli.cjs")).toBe(true);
  });

  test("test_DW_5_5_node_shim_uses_child_process", () => {
    // The Node.js shim must use child_process to delegate to bun
    expect(fileExists("dist/cli.cjs")).toBe(true);
    const content = readText("dist/cli.cjs");
    expect(content).toContain("child_process");
  });

  test("test_DW_5_5_node_shim_uses_safe_subprocess_call", () => {
    // The shim must use execFileSync or spawnSync (not shell exec with string interpolation)
    const content = readText("dist/cli.cjs");
    const hasSafeCall =
      content.includes("execFileSync") ||
      content.includes("spawnSync") ||
      content.includes("execFile(");
    expect(hasSafeCall).toBe(true);
  });

  test("test_DW_5_5_npm_publish_config_correct", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    // Must have publishConfig with public access (scoped packages default to private)
    const publishConfig = pkg.publishConfig as Record<string, unknown> | undefined;
    expect(publishConfig).toBeDefined();
    expect(publishConfig!.access).toBe("public");
  });

  test("test_DW_5_5_files_field_whitelists_published_content", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    // Must have files field to control what's published
    const files = pkg.files as string[] | undefined;
    expect(Array.isArray(files)).toBe(true);
    expect(files!.length).toBeGreaterThan(0);
    // Must include bin, mcp, and dist directories
    const hasBin = files!.some((f) => f.includes("bin") || f === "bin/");
    const hasMcp = files!.some((f) => f.includes("mcp") || f === "mcp/");
    const hasDist = files!.some((f) => f.includes("dist") || f === "dist/");
    expect(hasBin).toBe(true);
    expect(hasMcp).toBe(true);
    expect(hasDist).toBe(true);
  });
});

// ─── DW-5.6: [manual] End-to-end install → login → publish → site live ───────

describe("DW-5.6 manual end-to-end prerequisites", () => {
  test("test_DW_5_6_manual_checklist_all_components_present", () => {
    // Verify all components required for a successful end-to-end test exist:
    // 1. install.sh for bootstrapping
    expect(fileExists("install.sh")).toBe(true);
    // 2. bin/upublish.ts for the CLI
    expect(fileExists("bin/upublish.ts")).toBe(true);
    // 3. mcp/index.ts for the MCP server
    expect(fileExists("mcp/index.ts")).toBe(true);
    // 4. lib/auth.ts for OAuth login
    expect(fileExists("lib/auth.ts")).toBe(true);
    // 5. lib/publish.ts for publishing
    expect(fileExists("lib/publish.ts")).toBe(true);
    // 6. Skills for agent activation
    expect(fileExists("skills/upublish/SKILL.md")).toBe(true);
    expect(fileExists("skills/upublish-setup/SKILL.md")).toBe(true);
  });
});

// ─── DW-5.7: [manual] Tested on macOS with real Google OAuth ─────────────────

describe("DW-5.7 macOS OAuth flow code paths", () => {
  test("test_DW_5_7_oauth_flow_code_paths_present", () => {
    // lib/auth.ts must have the OAuth PKCE flow
    expect(fileExists("lib/auth.ts")).toBe(true);
    const authContent = readText("lib/auth.ts");
    // Must have PKCE code verifier
    expect(authContent).toContain("code_verifier");
    // Must open browser
    expect(authContent).toContain("openBrowser");
    // Must handle callback
    expect(authContent).toContain("callback");
  });

  test("test_DW_5_7_credentials_stored_at_correct_path", () => {
    const authContent = readText("lib/auth.ts");
    // Must store credentials at ~/.upublish/credentials
    expect(authContent).toContain(".upublish");
    expect(authContent).toContain("credentials");
  });
});

// ─── DW-5.8: Repo ready to push to omni-ping/upublish.skill ──────────────────

describe("DW-5.8 repo ready to push to GitHub", () => {
  test("test_DW_5_8_repo_has_github_remote_config", () => {
    // package.json should have a repository field pointing to omni-ping/upublish.skill
    const pkg = readJson("package.json") as Record<string, unknown>;
    const repo = pkg.repository as Record<string, unknown> | string | undefined;
    if (repo) {
      const repoStr = typeof repo === "string" ? repo : (repo.url as string);
      expect(repoStr).toContain("omni-ping/upublish.skill");
    } else {
      // If no repository field, check install.sh references the correct org/repo
      const installContent = readText("install.sh");
      expect(installContent).toContain("omni-ping/upublish.skill");
    }
  });

  test("test_DW_5_8_package_version_is_valid_semver", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    expect(typeof pkg.version).toBe("string");
    // Must be valid semver
    expect(pkg.version as string).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("test_DW_5_8_not_private_for_publishing", () => {
    const pkg = readJson("package.json") as Record<string, unknown>;
    // Must not be private (or private: false) to allow npm publish
    expect(pkg.private).not.toBe(true);
  });
});
