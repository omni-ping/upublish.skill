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

  test("test_DW_4_4_uses_npx_command", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    expect(upublish.command).toBe("npx");
    const args = upublish.args as string[];
    const hasPackage = args.some((a) => a.includes("@omniping/upublish"));
    expect(hasPackage).toBe(true);
  });

  test("test_DW_4_4_version_is_0_3_0", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    expect(data.version).toBe("0.3.0");
  });

  test("test_DW_4_4_keeps_cwd_with_extensionPath", () => {
    const data = readJson("gemini-extension.json") as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown>;
    const upublish = servers.upublish as Record<string, unknown>;
    expect(upublish.cwd).toBe("${extensionPath}");
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

  test("test_DW_4_5_root_skill_references_cli_auth", () => {
    // Setup consolidated into root skill bootstrap flow
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("upublish login");
    expect(content).not.toContain("scripts/setup.ts");
  });

  test("test_DW_4_5_root_skill_references_configure", () => {
    // Root skill uses upublish configure for platform plugin install
    const content = readText("skills/upublish/SKILL.md");
    expect(content).toContain("upublish configure");
    // Platform detection covers gemini
    expect(content.toLowerCase()).toContain("gemini");
  });

  test("test_DW_4_5_root_skill_has_frontmatter", () => {
    const ask = readText("skills/upublish/SKILL.md");
    expect(ask).toContain("name: upublish");
    expect(ask).toContain("description:");
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
    const docs = ["skills/upublish/SKILL.md", "GEMINI.md"];
    for (const doc of docs) {
      const content = readText(doc);
      expect(content).not.toMatch(/\/Users\/[a-z]+\//);
    }
  });
});

// ─── DW-1.7: install.sh uses npm install ────────────────────────────────────

describe("DW-1.7 install.sh uses npm install", () => {
  test("test_DW_1_7_install_sh_uses_npm_install", () => {
    expect(fileExists("install.sh")).toBe(true);
    const content = readText("install.sh");
    expect(content).toContain("npm install -g @omniping/upublish");
  });

  test("test_DW_1_7_install_sh_no_git_clone", () => {
    const content = readText("install.sh");
    expect(content).not.toContain("git clone");
  });

  test("test_DW_1_7_install_sh_no_bun_install", () => {
    const content = readText("install.sh");
    expect(content).not.toContain("bun install");
  });

  test("test_DW_1_7_install_sh_checks_os", () => {
    const content = readText("install.sh");
    expect(content).toContain("uname");
  });

  test("test_DW_1_7_install_sh_runs_login", () => {
    const content = readText("install.sh");
    expect(content).toContain("upublish login");
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
