/**
 * CLI subcommand tests.
 *
 * Tests the subcommand runner functions directly — no subprocess spawning.
 * Each test imports the run() function for a subcommand and calls it with
 * mock deps, capturing console.log output and process.exit calls.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Site } from "../lib/types.ts";
import {
  runLoginCommand,
  runPublishCommand,
  runListCommand,
  runDeleteCommand,
  runGenerateCommand,
} from "../bin/upublish.ts";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/** Creates a mock ApiClient with all methods as stubs. */
function makeMockApiClient() {
  return {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    postForm: mock(async () => ({})),
    delete: mock(async () => ({})),
  };
}

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

// ─── DW-2.1: login ───────────────────────────────────────────────────────────

describe("login command", () => {
  test("test_DW_2_1_login_command_calls_login_lib", async () => {
    const loginMock = mock(async (_deps: unknown) => ({
      username: "test@example.com",
      credentialsFilePath: "/tmp/test-creds",
    }));

    await runLoginCommand(
      { json: false },
      { loginFn: loginMock }
    );

    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  test("test_DW_2_1_login_command_prints_success", async () => {
    const loginMock = mock(async () => ({
      username: "test@example.com",
      credentialsFilePath: "/tmp/test-creds",
    }));

    await runLoginCommand(
      { json: false },
      { loginFn: loginMock }
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("test@example.com");
  });

  test("test_DW_2_1_login_json_flag_outputs_json", async () => {
    const loginMock = mock(async () => ({
      username: "test@example.com",
      credentialsFilePath: "/tmp/test-creds",
    }));

    await runLoginCommand(
      { json: true },
      { loginFn: loginMock }
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

// ─── DW-2.2: publish ─────────────────────────────────────────────────────────

describe("publish command", () => {
  test("test_DW_2_2_publish_command_calls_publish_lib", async () => {
    const mockApiClient = makeMockApiClient();
    const publishMock = mock(async () => ({
      url: "https://my-site.upubli.sh",
      site: SAMPLE_SITE,
    }));

    await runPublishCommand(
      { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
      { apiClient: mockApiClient as never, publishFn: publishMock }
    );

    expect(publishMock).toHaveBeenCalledTimes(1);
    const callArg = publishMock.mock.calls[0][0] as { slug: string; directory: string };
    expect(callArg.slug).toBe("my-site");
    expect(callArg.directory).toBe("/tmp");
  });

  test("test_DW_2_2_publish_command_prints_url", async () => {
    const mockApiClient = makeMockApiClient();
    const publishMock = mock(async () => ({
      url: "https://my-site.upubli.sh",
      site: SAMPLE_SITE,
    }));

    await runPublishCommand(
      { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
      { apiClient: mockApiClient as never, publishFn: publishMock }
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("https://my-site.upubli.sh");
  });

  test("test_DW_2_2_publish_exits_1_on_error", async () => {
    const mockApiClient = makeMockApiClient();
    const publishMock = mock(async () => { throw new Error("Upload failed"); });

    await expect(
      runPublishCommand(
        { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
        { apiClient: mockApiClient as never, publishFn: publishMock }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });
});

// ─── DW-2.3: list ────────────────────────────────────────────────────────────

describe("list command", () => {
  test("test_DW_2_3_list_command_formats_sites", async () => {
    const mockApiClient = makeMockApiClient();
    const listMock = mock(async () => ({ sites: [SAMPLE_SITE] }));

    await runListCommand(
      { json: false },
      { apiClient: mockApiClient as never, listFn: listMock }
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("my-site");
    expect(combined).toContain("https://my-site.upubli.sh");
  });

  test("test_DW_2_3_list_command_shows_no_sites_message", async () => {
    const mockApiClient = makeMockApiClient();
    const listMock = mock(async () => ({ sites: [] }));

    await runListCommand(
      { json: false },
      { apiClient: mockApiClient as never, listFn: listMock }
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("No sites");
  });

  test("test_DW_2_3_list_exits_1_on_error", async () => {
    const mockApiClient = makeMockApiClient();
    const listMock = mock(async () => { throw new Error("API error 401: Unauthorized"); });

    await expect(
      runListCommand(
        { json: false },
        { apiClient: mockApiClient as never, listFn: listMock }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });
});

// ─── DW-2.4: delete ──────────────────────────────────────────────────────────

describe("delete command", () => {
  test("test_DW_2_4_delete_command_calls_delete_lib", async () => {
    const mockApiClient = makeMockApiClient();
    const deleteMock = mock(async () => ({ message: "Site deleted." }));

    await runDeleteCommand(
      { slug: "my-site", json: false },
      { apiClient: mockApiClient as never, deleteFn: deleteMock }
    );

    expect(deleteMock).toHaveBeenCalledTimes(1);
    const [, slug] = deleteMock.mock.calls[0] as [unknown, string];
    expect(slug).toBe("my-site");
  });

  test("test_DW_2_4_delete_command_prints_confirmation", async () => {
    const mockApiClient = makeMockApiClient();
    const deleteMock = mock(async () => ({ message: "Site deleted." }));

    await runDeleteCommand(
      { slug: "my-site", json: false },
      { apiClient: mockApiClient as never, deleteFn: deleteMock }
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("my-site");
  });

  test("test_DW_2_4_delete_exits_1_on_error", async () => {
    const mockApiClient = makeMockApiClient();
    const deleteMock = mock(async () => { throw new Error("Site not found"); });

    await expect(
      runDeleteCommand(
        { slug: "my-site", json: false },
        { apiClient: mockApiClient as never, deleteFn: deleteMock }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });
});

// ─── DW-2.5: generate ────────────────────────────────────────────────────────

describe("generate command", () => {
  test("test_DW_2_5_generate_command_calls_generate_lib", async () => {
    const mockApiClient = makeMockApiClient();
    const generateMock = mock(async () => ({
      url: "https://diagram.upubli.sh",
      slug: "diagram-abc",
    }));

    await runGenerateCommand(
      { context: "A user auth flow", diagramType: undefined, slug: undefined, json: false },
      { apiClient: mockApiClient as never, generateFn: generateMock }
    );

    expect(generateMock).toHaveBeenCalledTimes(1);
    const callArg = generateMock.mock.calls[0][0] as { context: string };
    expect(callArg.context).toBe("A user auth flow");
  });

  test("test_DW_2_5_generate_command_prints_url", async () => {
    const mockApiClient = makeMockApiClient();
    const generateMock = mock(async () => ({
      url: "https://diagram.upubli.sh",
      slug: "diagram-abc",
    }));

    await runGenerateCommand(
      { context: "A user auth flow", diagramType: undefined, slug: undefined, json: false },
      { apiClient: mockApiClient as never, generateFn: generateMock }
    );

    const combined = logOutput.join("\n");
    expect(combined).toContain("https://diagram.upubli.sh");
  });

  test("test_DW_2_5_generate_exits_1_on_error", async () => {
    const mockApiClient = makeMockApiClient();
    const generateMock = mock(async () => { throw new Error("context is required"); });

    await expect(
      runGenerateCommand(
        { context: "", diagramType: undefined, slug: undefined, json: false },
        { apiClient: mockApiClient as never, generateFn: generateMock }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
  });
});

// ─── DW-2.6: --json flag ─────────────────────────────────────────────────────

describe("--json flag", () => {
  test("test_DW_2_6_json_flag_publish", async () => {
    const mockApiClient = makeMockApiClient();
    const publishMock = mock(async () => ({
      url: "https://my-site.upubli.sh",
      site: SAMPLE_SITE,
    }));

    await runPublishCommand(
      { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: true },
      { apiClient: mockApiClient as never, publishFn: publishMock }
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.url).toBe("https://my-site.upubli.sh");
    expect(parsed.site).toBeDefined();
  });

  test("test_DW_2_6_json_flag_list", async () => {
    const mockApiClient = makeMockApiClient();
    const listMock = mock(async () => ({ sites: [SAMPLE_SITE] }));

    await runListCommand(
      { json: true },
      { apiClient: mockApiClient as never, listFn: listMock }
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(Array.isArray(parsed.sites)).toBe(true);
    expect(parsed.sites[0].slug).toBe("my-site");
  });

  test("test_DW_2_6_json_flag_delete", async () => {
    const mockApiClient = makeMockApiClient();
    const deleteMock = mock(async () => ({ message: "Site deleted." }));

    await runDeleteCommand(
      { slug: "my-site", json: true },
      { apiClient: mockApiClient as never, deleteFn: deleteMock }
    );

    const jsonLine = logOutput.find((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.message).toBe("Site deleted.");
  });

  test("test_DW_2_6_json_flag_generate", async () => {
    const mockApiClient = makeMockApiClient();
    const generateMock = mock(async () => ({
      url: "https://diagram.upubli.sh",
      slug: "diagram-abc",
    }));

    await runGenerateCommand(
      { context: "A user auth flow", diagramType: undefined, slug: undefined, json: true },
      { apiClient: mockApiClient as never, generateFn: generateMock }
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

// ─── DW-2.7: unauthenticated ─────────────────────────────────────────────────

describe("unauthenticated commands", () => {
  test("test_DW_2_7_unauthenticated_publish_exits_1", async () => {
    await expect(
      runPublishCommand(
        { dir: "/tmp", slug: "my-site", title: undefined, visibility: undefined, passcode: undefined, json: false },
        { apiClient: null as never, publishFn: mock(async () => ({} as never)) }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    const combined = logOutput.join("\n");
    expect(combined).toContain("Not logged in");
    expect(combined).toContain("upublish login");
  });

  test("test_DW_2_7_unauthenticated_list_exits_1", async () => {
    await expect(
      runListCommand(
        { json: false },
        { apiClient: null as never, listFn: mock(async () => ({} as never)) }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    const combined = logOutput.join("\n");
    expect(combined).toContain("Not logged in");
  });

  test("test_DW_2_7_unauthenticated_delete_exits_1", async () => {
    await expect(
      runDeleteCommand(
        { slug: "my-site", json: false },
        { apiClient: null as never, deleteFn: mock(async () => ({} as never)) }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    const combined = logOutput.join("\n");
    expect(combined).toContain("Not logged in");
  });

  test("test_DW_2_7_unauthenticated_generate_exits_1", async () => {
    await expect(
      runGenerateCommand(
        { context: "test", diagramType: undefined, slug: undefined, json: false },
        { apiClient: null as never, generateFn: mock(async () => ({} as never)) }
      )
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    const combined = logOutput.join("\n");
    expect(combined).toContain("Not logged in");
  });
});

// ─── DW-2.8: version + help ───────────────────────────────────────────────────

describe("version and help", () => {
  test("test_DW_2_8_version_in_package_json", async () => {
    // Version is provided by citty from package.json meta.version
    // We verify the package.json has a non-empty version field
    const pkg = await import("../package.json");
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version.length).toBeGreaterThan(0);
  });
});
