/**
 * Plugin Manifests + Skill Documents validation tests.
 *
 * These tests validate that all static manifests and documents
 * exist with correct structure, required fields, and no hardcoded
 * absolute paths.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Root of the skill repo (one level up from tests/)
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

// ─── DW-4.3: .mcp.json at repo root ──────────────────────────────────────────

describe("DW-4.3 .mcp.json at repo root", () => {
  test("test_DW_4_3_mcp_json_at_root", () => {
    expect(fileExists(".mcp.json")).toBe(true);
    const data = readJson(".mcp.json") as Record<string, unknown>;
    expect(data.mcpServers).toBeDefined();
  });

  test("test_DW_4_3_points_to_mcp_bundle", () => {
    const data = readJson(".mcp.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    expect(upublish).toBeDefined();
    const args = upublish.args as string[];
    const hasMcpJs = args.some((a) => a.includes("mcp.js"));
    expect(hasMcpJs).toBe(true);
  });
});

describe("Codex native plugin packaging", () => {
  test("manifest paths are relative to the plugin root", () => {
    const data = readJson(".codex-plugin/plugin.json") as Record<string, unknown>;
    expect(data.skills).toBe("./skills/");
    // Codex gets its OWN mcpServers file, not Claude's .mcp.json — the latter
    // launches via ${CLAUDE_PLUGIN_ROOT}, a var Codex never sets (it would
    // expand to empty → `bun run /dist/mcp.js` → Module not found).
    expect(data.mcpServers).toBe("./codex-mcp.json");
  });

  test("codex-mcp.json launches the bundle without a host-specific path var", () => {
    expect(fileExists("codex-mcp.json")).toBe(true);
    const data = readJson("codex-mcp.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    expect(upublish).toBeDefined();
    // Codex resolves the bundle via cwd="." (the plugin root) + a relative path,
    // matching the native openai-developers plugin pattern.
    expect(upublish.cwd).toBe(".");
    expect(upublish.command).toBe("bun");
    const args = upublish.args as string[];
    expect(args.some((a) => a.includes("dist/mcp.js"))).toBe(true);
    // No Claude/Gemini/Antigravity path token may leak into the Codex launch.
    const blob = JSON.stringify(data);
    expect(blob).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(blob).not.toContain("extensionPath");
  });

  test("marketplace installs the complete Git-backed plugin", () => {
    expect(fileExists(".agents/plugins/marketplace.json")).toBe(true);
    const marketplace = readJson(".agents/plugins/marketplace.json") as {
      name: string;
      plugins: Array<Record<string, unknown>>;
    };
    expect(marketplace.name).toBe("upublish");
    const plugin = marketplace.plugins[0];
    expect(plugin.name).toBe("upublish");
    expect(plugin.category).toBe("Productivity");
    expect(plugin.policy).toEqual({
      installation: "AVAILABLE",
      authentication: "ON_USE",
    });
    expect(plugin.source).toEqual({
      source: "url",
      url: "https://github.com/omni-ping/upublish.skill.git",
      ref: "main",
    });
  });

  test("README uses native Codex plugin installation", () => {
    const content = readText("README.md");
    expect(content).toContain("codex plugin marketplace add omni-ping/upublish.skill");
    expect(content).toContain("codex plugin add upublish@upublish");
    expect(content).not.toContain("npx skills add");
  });
});

// ─── DW-4.4: gemini-extension.json ───────────────────────────────────────────

describe("DW-4.4 gemini-extension.json", () => {
  test("test_DW_4_4_gemini_extension_json_valid", () => {
    expect(fileExists("gemini-extension.json")).toBe(true);
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    expect(typeof data.name).toBe("string");
    expect(typeof data.version).toBe("string");
    expect(typeof data.description).toBe("string");
    expect(data.mcpServers).toBeDefined();
  });

  test("test_DW_4_4_version_matches_package_json", () => {
    const gemini = readJson("gemini-extension.json") as Record<string, unknown>;
    const pkg = readJson("package.json") as Record<string, unknown>;
    expect(gemini.version).toBe(pkg.version);
  });

  test("test_DW_4_4_has_context_file_name", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    expect(data.contextFileName).toBe("GEMINI.md");
  });

  test("test_DW_4_4_uses_bun_with_extension_path", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.upublish.command).toBe("bun");
    const args = servers.upublish.args as string[];
    expect(args).toContain("run");
    const hasExtPath = args.some((a) => a.includes("${extensionPath}"));
    expect(hasExtPath).toBe(true);
  });
});

// ─── DW-4.5: SKILL.md uses MCP-only bootstrap ──────────────────────────────

describe("DW-4.5 SKILL.md MCP-only bootstrap", () => {
  test("test_DW_4_5_skill_exists", () => {
    expect(fileExists("skills/upublish/SKILL.md")).toBe(true);
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("mcp_upublish_publish");
  });

  test("test_DW_4_5_skill_uses_mcp_auth", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("login");
    expect(content).toContain("status");
    expect(content).not.toContain("scripts/setup.ts");
  });

  test("test_DW_4_5_skill_has_frontmatter", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("name: upublish");
    expect(content).toContain("description:");
  });

  test("test_DW_4_5_skill_routes_to_packaged_root_references", () => {
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("../../references/publishing.md");
    expect(content).toContain("../../references/pre-publish-checklist.md");
    expect(content).not.toMatch(/(?<!\.\.\/\.\.\/)`references\/publishing\.md`/);
  });
});

// ─── DW-4.6: GEMINI.md ───────────────────────────────────────────────────────

describe("DW-4.6 GEMINI.md complete context", () => {
  test("test_DW_4_6_gemini_md_exists_and_complete", () => {
    expect(fileExists("GEMINI.md")).toBe(true);
    const content = readText("GEMINI.md");
    // Must have meaningful content
    expect(content.length).toBeGreaterThan(500);
  });

  test("test_DW_4_6_references_mcp_login", () => {
    const content = readText("GEMINI.md");
    expect(content).toContain("mcp_upublish_login");
  });

  test("test_DW_4_6_covers_core_tools", () => {
    const content = readText("GEMINI.md");
    expect(content).toContain("mcp_upublish_publish");
    expect(content).toContain("mcp_upublish_list");
    expect(content).toContain("mcp_upublish_delete");
  });
});

// ─── DW-4.7: references/ has all reference docs ─────────────────────────────

describe("DW-4.7 all reference docs exist", () => {
  const docs = [
    "references/publishing.md",
    "references/managing.md",
    "references/visibility.md",
    "references/troubleshooting.md",
  ];

  for (const doc of docs) {
    test(`test_DW_4_7_${doc.replace("references/", "").replace(".md", "")}_exists`, () => {
      expect(fileExists(doc)).toBe(true);
      const content = readText(doc);
      expect(content.length).toBeGreaterThan(100);
    });
  }

  test("test_DW_4_7_troubleshooting_uses_mcp_login", () => {
    const content = readText("references/troubleshooting.md");
    // Must not reference old setup script path
    expect(content).not.toContain("scripts/setup.ts");
    // Must reference login tool, not CLI command
    expect(content).toContain("login");
    expect(content).not.toContain("upublish login");
  });
});

// ─── DW-4.8: No hardcoded absolute paths ─────────────────────────────────────

describe("DW-4.8 no absolute paths in manifests or docs", () => {
  test("test_DW_4_8_no_absolute_paths_in_manifests", () => {
    const manifests = [
      ".codex-plugin/plugin.json",
      "codex-mcp.json",
      ".mcp.json",
      "gemini-extension.json",
      "plugin.json",
      "mcp_config.json",
    ];
    for (const m of manifests) {
      const content = readText(m);
      // No /Users/ or /home/ paths
      expect(content).not.toMatch(/\/Users\//);
      expect(content).not.toMatch(/\/home\//);
    }
  });

  test("test_DW_4_8_no_absolute_paths_in_docs", () => {
    const docs = ["skills/upublish/SKILL.md", "GEMINI.md"];
    for (const doc of docs) {
      const content = readText(doc);
      expect(content).not.toMatch(/\/Users\/[a-z]+\//);
    }
  });
});

// ─── DW-4.9: gemini-extension.json schema compliance ─────────────────────────

describe("DW-4.9 gemini-extension.json schema compliance", () => {
  test("test_DW_4_9_gemini_extension_schema_compliance", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    // Required top-level fields per Gemini extension spec
    expect(typeof data.name).toBe("string");
    expect(typeof data.version).toBe("string");
    expect(typeof data.description).toBe("string");
    expect(typeof data.mcpServers).toBe("object");
    expect(data.mcpServers).not.toBeNull();
    // Each server entry must have command and args
    const servers = data.mcpServers as Record<string, Record<string, unknown>>;
    for (const [, server] of Object.entries(servers)) {
      expect(typeof server.command).toBe("string");
      expect(Array.isArray(server.args)).toBe(true);
    }
    // contextFileName should point to GEMINI.md
    expect(data.contextFileName).toBe("GEMINI.md");
  });
});

describe("Antigravity plugin.json", () => {
  test("plugin.json exists and is valid", () => {
    expect(fileExists("plugin.json")).toBe(true);
    const data = readJson("plugin.json") as Record<string, unknown>;
    expect(data.name).toBe("upublish");
    expect(typeof data.version).toBe("string");
    expect(typeof data.description).toBe("string");
  });

  test("plugin.json version matches package.json", () => {
    const plugin = readJson("plugin.json") as Record<string, unknown>;
    const pkg = readJson("package.json") as Record<string, unknown>;
    expect(plugin.version).toBe(pkg.version);
  });
});

describe("Antigravity mcp_config.json", () => {
  test("mcp_config.json exists and is valid", () => {
    expect(fileExists("mcp_config.json")).toBe(true);
    const data = readJson("mcp_config.json") as Record<string, unknown>;
    expect(data.mcpServers).toBeDefined();
    const servers = data.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.upublish).toBeDefined();
    // Antigravity (`agy`) copies mcp_config.json verbatim and does NOT expand
    // ${extensionPath}, injects no plugin-dir env var, and launches the server
    // with cwd = the workspace (not the plugin dir). So the path must be
    // resolved by the shell at runtime, anchored on agy's deterministic staging
    // location ($HOME/.gemini/config/plugins/upublish). A bare `bun run
    // ${extensionPath}/...` reaches bun literally and fails with "Module not found".
    expect(servers.upublish.command).toBe("sh");
    const args = servers.upublish.args as string[];
    expect(args).toContain("-c");
    const script = args.find((a) => a.includes("dist/mcp.js")) ?? "";
    expect(script).toContain("$HOME/.gemini/config/plugins/upublish/dist/mcp.js");
    expect(script).not.toContain("${extensionPath}");
  });
});
