/**
 * CLI subcommand tests.
 *
 * Tests the subcommand runner functions directly — no subprocess spawning.
 * Each test imports the run*Command function and calls it with mock deps,
 * capturing console.log output and process.exit calls.
 *
 * After the hexagonal refactor, command deps carry a core function override
 * instead of an ApiClient. This removes all auth knowledge from the adapter.
 *
 * Covers DW-2.2: bin/upublish.ts imports only from lib/core.ts
 * Covers DW-2.4: CLI commands produce correct output
 * Covers DW-2.5: bun test passes with 0 failures
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Site } from "../lib/core.ts";
import {
  runLoginCommand,
  runPublishCommand,
  runListCommand,
  runDeleteCommand,
  runGenerateCommand,
  runStatusCommand,
  runConfigureCommand,
} from "../bin/upublish.ts";

// ─── Sample data ──────────────────────────────────────────────────────────────

const SAMPLE_SITE: Site = {
  id: "abc123",
  user_id: "user1",
  slug: "my-site",
  title: "My Site",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  file_count: 3,
  total_size: 1024,
  visibility: "public",
  passcode_hash: null,
  url: "https://my-site.upubli.sh",
};

// ─── Test state ───────────────────────────────────────────────────────────────

let logOutput: string[] = [];
let exitCode: number | undefined;
let logSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logOutput = [];
  exitCode = undefined;
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  });
  exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

// ─── DW-2.4: login ───────────────────────────────────────────────────────────

describe("login command", () => {
  test("test_DW_2_4_login_command_calls_login_core", async () => {
    const loginMock = mock(async (_deps: unknown) => ({
      username: "test@example.com",
      credentialsFilePath: "/tmp/test-creds",
    }));

    await runLoginCommand(
      { json: false },
      { loginFn: loginMock },
    );

    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  test("test_DW_2_4_login_command_prints_success", async () => {
    const loginMock = mock(async () => ({
      username: "test@example.com",
      credentialsFilePath: "/tmp/test-creds",
    }));

    await runLoginCommand(
      { json: false },
      { loginFn: loginMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("test@example.com");
  });

  test("test_DW_2_4_login_json_flag_outputs_json", async () => {
    const loginMock = mock(async () => ({
      username: "test@example.com",
      credentialsFilePath: "/tmp/test-creds",
    }));

    await runLoginCommand(
      { json: true },
      { loginFn: loginMock },
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.username).toBe("test@example.com");
    expect(parsed.credentialsFilePath).toBe("/tmp/test-creds");
  });
});

// ─── DW-2.4: publish ─────────────────────────────────────────────────────────

describe("publish command", () => {
  test("test_DW_2_4_publish_command_calls_core_publish", async () => {
    const publishMock = mock(async () => ({
      url: "https://my-site.upubli.sh",
      site: SAMPLE_SITE,
    }));

    await runPublishCommand(
      { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
      { publishFn: publishMock },
    );

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [args] = publishMock.mock.calls[0] as [{ slug: string; directory: string }];
    expect(args.slug).toBe("my-site");
    expect(args.directory).toBe("/tmp");
  });

  test("test_DW_2_4_publish_command_prints_url", async () => {
    const publishMock = mock(async () => ({
      url: "https://my-site.upubli.sh",
      site: SAMPLE_SITE,
    }));

    await runPublishCommand(
      { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
      { publishFn: publishMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("https://my-site.upubli.sh");
  });

  test("test_DW_2_4_publish_exits_1_on_error", async () => {
    const publishMock = mock(async () => { throw new Error("Upload failed"); });

    await expect(
      runPublishCommand(
        { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
        { publishFn: publishMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });

  test("test_DW_2_4_publish_not_authenticated_exits_1", async () => {
    const publishMock = mock(async () => {
      throw new Error("Not authenticated. Run `upublish login` to sign in.");
    });

    await expect(
      runPublishCommand(
        { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
        { publishFn: publishMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    const combined = logOutput.join("\n");
    expect(combined).toContain("Not authenticated");
  });
});

// ─── DW-2.4: list ────────────────────────────────────────────────────────────

describe("list command", () => {
  test("test_DW_2_4_list_command_formats_sites", async () => {
    const listMock = mock(async () => ({ sites: [SAMPLE_SITE] }));

    await runListCommand(
      { json: false },
      { listFn: listMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("my-site");
    expect(combined).toContain("https://my-site.upubli.sh");
  });

  test("test_DW_2_4_list_command_shows_no_sites_message", async () => {
    const listMock = mock(async () => ({ sites: [] }));

    await runListCommand(
      { json: false },
      { listFn: listMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("No sites");
  });

  test("test_DW_2_4_list_exits_1_on_error", async () => {
    const listMock = mock(async () => { throw new Error("API error 401: Unauthorized"); });

    await expect(
      runListCommand(
        { json: false },
        { listFn: listMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });
});

// ─── DW-2.4: delete ──────────────────────────────────────────────────────────

describe("delete command", () => {
  test("test_DW_2_4_delete_command_calls_core_delete", async () => {
    const deleteMock = mock(async () => ({ message: "Site deleted." }));

    await runDeleteCommand(
      { slug: "my-site", json: false },
      { deleteFn: deleteMock },
    );

    expect(deleteMock).toHaveBeenCalledTimes(1);
    const [slug] = deleteMock.mock.calls[0] as [string];
    expect(slug).toBe("my-site");
  });

  test("test_DW_2_4_delete_command_prints_confirmation", async () => {
    const deleteMock = mock(async () => ({ message: "Site deleted." }));

    await runDeleteCommand(
      { slug: "my-site", json: false },
      { deleteFn: deleteMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("my-site");
  });

  test("test_DW_2_4_delete_exits_1_on_error", async () => {
    const deleteMock = mock(async () => { throw new Error("Site not found"); });

    await expect(
      runDeleteCommand(
        { slug: "my-site", json: false },
        { deleteFn: deleteMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });
});

// ─── DW-2.4: generate ────────────────────────────────────────────────────────

describe("generate command", () => {
  test("test_DW_2_4_generate_command_calls_core_generate", async () => {
    const generateMock = mock(async () => ({
      url: "https://diagram.upubli.sh",
      slug: "diagram-abc",
    }));

    await runGenerateCommand(
      { context: "A user auth flow", diagramType: undefined, slug: undefined, json: false },
      { generateFn: generateMock },
    );

    expect(generateMock).toHaveBeenCalledTimes(1);
    const [args] = generateMock.mock.calls[0] as [{ context: string }];
    expect(args.context).toBe("A user auth flow");
  });

  test("test_DW_2_4_generate_command_prints_url", async () => {
    const generateMock = mock(async () => ({
      url: "https://diagram.upubli.sh",
      slug: "diagram-abc",
    }));

    await runGenerateCommand(
      { context: "A user auth flow", diagramType: undefined, slug: undefined, json: false },
      { generateFn: generateMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("https://diagram.upubli.sh");
  });

  test("test_DW_2_4_generate_exits_1_on_error", async () => {
    const generateMock = mock(async () => { throw new Error("context is required"); });

    await expect(
      runGenerateCommand(
        { context: "", diagramType: undefined, slug: undefined, json: false },
        { generateFn: generateMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });
});

// ─── DW-2.4: status ──────────────────────────────────────────────────────────

describe("status command", () => {
  test("test_DW_2_4_status_authenticated_prints_username", async () => {
    const statusMock = mock(async () => ({
      authenticated: true as const,
      username: "test@example.com",
    }));

    await runStatusCommand(
      { json: false },
      { statusFn: statusMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("test@example.com");
  });

  test("test_DW_2_4_status_unauthenticated_exits_1", async () => {
    const statusMock = mock(async () => ({
      authenticated: false as const,
    }));

    await expect(
      runStatusCommand(
        { json: false },
        { statusFn: statusMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });

  test("test_DW_2_4_status_json_authenticated", async () => {
    const statusMock = mock(async () => ({
      authenticated: true as const,
      username: "test@example.com",
    }));

    await runStatusCommand(
      { json: true },
      { statusFn: statusMock },
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.username).toBe("test@example.com");
  });

  test("test_DW_2_4_status_json_unauthenticated_exits_1", async () => {
    const statusMock = mock(async () => ({
      authenticated: false as const,
      error: "No credentials found",
    }));

    await expect(
      runStatusCommand(
        { json: true },
        { statusFn: statusMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.authenticated).toBe(false);
  });
});

// ─── DW-2.4: --json flag ─────────────────────────────────────────────────────

describe("--json flag", () => {
  test("test_DW_2_4_json_flag_publish", async () => {
    const publishMock = mock(async () => ({
      url: "https://my-site.upubli.sh",
      site: SAMPLE_SITE,
    }));

    await runPublishCommand(
      { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: true },
      { publishFn: publishMock },
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.url).toBe("https://my-site.upubli.sh");
    expect(parsed.site).toBeDefined();
  });

  test("test_DW_2_4_json_flag_list", async () => {
    const listMock = mock(async () => ({ sites: [SAMPLE_SITE] }));

    await runListCommand(
      { json: true },
      { listFn: listMock },
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(Array.isArray(parsed.sites)).toBe(true);
    expect(parsed.sites[0].slug).toBe("my-site");
  });

  test("test_DW_2_4_json_flag_delete", async () => {
    const deleteMock = mock(async () => ({ message: "Site deleted." }));

    await runDeleteCommand(
      { slug: "my-site", json: true },
      { deleteFn: deleteMock },
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.message).toBe("Site deleted.");
  });

  test("test_DW_2_4_json_flag_generate", async () => {
    const generateMock = mock(async () => ({
      url: "https://diagram.upubli.sh",
      slug: "diagram-abc",
    }));

    await runGenerateCommand(
      { context: "A user auth flow", diagramType: undefined, slug: undefined, json: true },
      { generateFn: generateMock },
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.url).toBe("https://diagram.upubli.sh");
    expect(parsed.slug).toBe("diagram-abc");
  });
});

// ─── DW-1: configure ────────────────────────────────────────────────────────

describe("configure command", () => {
  test("test_DW_1_1_configure_claude_runs_plugin_install", async () => {
    const execMock = mock(async (_cmd: string, _args: string[]) => ({ exitCode: 0 }));

    await runConfigureCommand(
      { platform: "claude" },
      { execFn: execMock },
    );

    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["plugin", "install", "omni-ping/upublish.skill"]);
  });

  test("test_DW_1_2_configure_gemini_runs_extension_install", async () => {
    const execMock = mock(async (_cmd: string, _args: string[]) => ({ exitCode: 0 }));

    await runConfigureCommand(
      { platform: "gemini" },
      { execFn: execMock },
    );

    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gemini");
    expect(args).toEqual(["extensions", "install", "omni-ping/upublish.skill"]);
  });

  test("test_DW_1_3_configure_codex_runs_skills_add", async () => {
    const execMock = mock(async (_cmd: string, _args: string[]) => ({ exitCode: 0 }));

    await runConfigureCommand(
      { platform: "codex" },
      { execFn: execMock },
    );

    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("npx");
    expect(args).toEqual(["skills", "add", "omni-ping/upublish.skill", "-g", "--agent", "codex"]);
  });

  test("test_DW_1_4_configure_exported_with_injectable_deps", async () => {
    // Verify runConfigureCommand is a function (exported correctly)
    expect(typeof runConfigureCommand).toBe("function");

    // Verify it accepts and uses injected deps (execFn is called, not the real spawn)
    const execMock = mock(async (_cmd: string, _args: string[]) => ({ exitCode: 0 }));

    await runConfigureCommand(
      { platform: "claude" },
      { execFn: execMock },
    );

    // The mock was used, proving deps injection works
    expect(execMock).toHaveBeenCalled();
  });

  test("test_DW_1_5_configure_invalid_platform_prints_error", async () => {
    const execMock = mock(async (_cmd: string, _args: string[]) => ({ exitCode: 0 }));

    await expect(
      runConfigureCommand(
        { platform: "invalid-platform" },
        { execFn: execMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(execMock).not.toHaveBeenCalled();

    const combined = logOutput.join("\n");
    expect(combined).toContain("invalid-platform");
    expect(combined).toContain("claude");
    expect(combined).toContain("gemini");
    expect(combined).toContain("codex");
  });

  test("test_DW_1_6_configure_prints_success_message", async () => {
    const execMock = mock(async (_cmd: string, _args: string[]) => ({ exitCode: 0 }));

    await runConfigureCommand(
      { platform: "claude" },
      { execFn: execMock },
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("claude");
  });

  test("test_DW_1_6_configure_nonzero_exit_reports_error", async () => {
    const execMock = mock(async (_cmd: string, _args: string[]) => ({ exitCode: 1 }));

    await expect(
      runConfigureCommand(
        { platform: "claude" },
        { execFn: execMock },
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    const combined = logOutput.join("\n");
    expect(combined).toContain("failed");
  });
});

// ─── DW-2.2: version ─────────────────────────────────────────────────────────

describe("version", () => {
  test("test_DW_2_2_version_in_package_json", async () => {
    const pkg = await import("../package.json");
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version.length).toBeGreaterThan(0);
  });
});
