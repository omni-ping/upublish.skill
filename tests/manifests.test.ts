/**
 * Phase 4: Plugin Manifests + Skill Documents validation tests.
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

// ─── DW-4.1: .claude-plugin/plugin.json ──────────────────────────────────────

describe("DW-4.1 .claude-plugin/plugin.json", () => {
  test("test_DW_4_1_claude_plugin_json_exists_and_valid", () => {
    expect(fileExists(".claude-plugin/plugin.json")).toBe(true);
    const data = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
    expect(typeof data.name).toBe("string");
    expect(typeof data.version).toBe("string");
    expect(typeof data.description).toBe("string");
    // Must have MCP server reference
    expect(data.mcpServers).toBeDefined();
  });

  test("test_DW_4_1_name_is_upublish", () => {
    const data = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
    expect(data.name).toBe("upublish");
  });

  test("test_DW_4_1_mcp_server_references_mcp_index", () => {
    const data = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    expect(upublish).toBeDefined();
    // args must include mcp/index.ts path
    const args = upublish.args as string[];
    const hasIndexTs = args.some((a) => a.includes("mcp") && a.includes("index.ts"));
    expect(hasIndexTs).toBe(true);
  });
});

// ─── DW-4.2: .codex-plugin/plugin.json ───────────────────────────────────────

describe("DW-4.2 .codex-plugin/plugin.json", () => {
  test("test_DW_4_2_codex_plugin_json_exists_and_valid", () => {
    expect(fileExists(".codex-plugin/plugin.json")).toBe(true);
    const data = readJson(".codex-plugin/plugin.json") as Record<string, unknown>;
    expect(typeof data.name).toBe("string");
    expect(typeof data.version).toBe("string");
    expect(typeof data.description).toBe("string");
  });

  test("test_DW_4_2_has_interface_fields", () => {
    const data = readJson(".codex-plugin/plugin.json") as Record<string, unknown>;
    const iface = data.interface as Record<string, unknown>;
    expect(iface).toBeDefined();
    expect(typeof iface.displayName).toBe("string");
    expect(typeof iface.shortDescription).toBe("string");
    expect(typeof iface.developerName).toBe("string");
    expect(typeof iface.category).toBe("string");
  });

  test("test_DW_4_2_has_mcp_servers_reference", () => {
    const data = readJson(".codex-plugin/plugin.json") as Record<string, unknown>;
    expect(data.mcpServers).toBeDefined();
  });
});

// ─── DW-4.3: .mcp.json at repo root ──────────────────────────────────────────

describe("DW-4.3 .mcp.json at repo root", () => {
  test("test_DW_4_3_mcp_json_at_root", () => {
    expect(fileExists(".mcp.json")).toBe(true);
    const data = readJson(".mcp.json") as Record<string, unknown>;
    expect(data.mcpServers).toBeDefined();
  });

  test("test_DW_4_3_points_to_mcp_index_ts", () => {
    const data = readJson(".mcp.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    expect(upublish).toBeDefined();
    const args = upublish.args as string[];
    const hasIndexTs = args.some((a) => a.includes("mcp") && a.includes("index.ts"));
    expect(hasIndexTs).toBe(true);
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

  test("test_DW_4_4_uses_extensionPath_variable", () => {
    const raw = readText("gemini-extension.json");
    expect(raw).toContain("${extensionPath}");
  });

  test("test_DW_4_4_has_context_file_name", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    expect(data.contextFileName).toBe("GEMINI.md");
  });
});

// ─── DW-4.5: SKILL.md updated for new repo structure ─────────────────────────

describe("DW-4.5 SKILL.md uses CLI auth", () => {
  test("test_DW_4_5_ask_skill_exists", () => {
    expect(fileExists("skills/upublish/SKILL.md")).toBe(true);
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("mcp_upublish_publish");
  });

  test("test_DW_4_5_setup_skill_references_cli_auth", () => {
    expect(fileExists("skills/upublish-setup/SKILL.md")).toBe(true);
    const content = readText("skills/upublish-setup/SKILL.md");
    expect(content).toContain("upublish login");
    expect(content).not.toContain("scripts/setup.ts");
  });

  test("test_DW_4_5_skills_have_frontmatter", () => {
    const ask = readText("skills/upublish/SKILL.md");
    expect(ask).toContain("name: upublish");
    expect(ask).toContain("description:");
    const setup = readText("skills/upublish-setup/SKILL.md");
    expect(setup).toContain("name: upublish-setup");
    expect(setup).toContain("description:");
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

  test("test_DW_4_6_references_cli_auth", () => {
    const content = readText("GEMINI.md");
    expect(content).toContain("upublish login");
  });

  test("test_DW_4_6_covers_core_tools", () => {
    const content = readText("GEMINI.md");
    expect(content).toContain("mcp_upublish_publish");
    expect(content).toContain("mcp_upublish_list");
    expect(content).toContain("mcp_upublish_delete");
  });
});

// ─── DW-4.7: references/ has all 5 docs ──────────────────────────────────────

describe("DW-4.7 all 5 reference docs exist", () => {
  const docs = [
    "references/publishing.md",
    "references/managing.md",
    "references/visibility.md",
    "references/generating.md",
    "references/troubleshooting.md",
  ];

  for (const doc of docs) {
    test(`test_DW_4_7_${doc.replace("references/", "").replace(".md", "")}_exists`, () => {
      expect(fileExists(doc)).toBe(true);
      const content = readText(doc);
      expect(content.length).toBeGreaterThan(100);
    });
  }

  test("test_DW_4_7_troubleshooting_uses_cli_auth", () => {
    const content = readText("references/troubleshooting.md");
    // Must not reference old setup script path
    expect(content).not.toContain("scripts/setup.ts");
    // Must reference upublish login
    expect(content).toContain("upublish login");
  });
});

// ─── DW-4.8: No hardcoded absolute paths ─────────────────────────────────────

describe("DW-4.8 no absolute paths in manifests or docs", () => {
  test("test_DW_4_8_no_absolute_paths_in_manifests", () => {
    const manifests = [
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "gemini-extension.json",
    ];
    for (const m of manifests) {
      const content = readText(m);
      // No /Users/ or /home/ paths
      expect(content).not.toMatch(/\/Users\//);
      expect(content).not.toMatch(/\/home\//);
    }
  });

  test("test_DW_4_8_no_absolute_paths_in_docs", () => {
    const docs = ["skills/upublish/SKILL.md", "skills/upublish-setup/SKILL.md", "GEMINI.md"];
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

  test("test_DW_4_9_server_entry_has_cwd", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, Record<string, unknown>>;
    for (const [, server] of Object.entries(servers)) {
      expect(typeof server.cwd).toBe("string");
      // cwd should use extensionPath
      expect(server.cwd as string).toContain("${extensionPath}");
    }
  });
});
