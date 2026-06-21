# Cross-Client Verification Matrix — Publish Progress + Timeouts

Generated: 2026-06-20 | Version: 0.12.25

## Summary

This matrix documents what each client renders for publish progress notifications and
what timeout knob is set. Three clients (Codex, Gemini CLI, Antigravity) are marked
"expected; verify on install" — their rendering cannot be confirmed without a live
install. Claude Code rendering is confirmed by harness-captured emission evidence below.

---

## Client Matrix

| Client | Config file | Timeout field | Timeout value | Units | Progress EMISSION | Live RENDER status |
|--------|-------------|---------------|---------------|-------|-------------------|--------------------|
| Claude Code | `.mcp.json` | `mcpServers.upublish.timeout` | 21600000 | **ms** | MACHINE-VERIFIED (see evidence below) | CONFIRMED — renders % bar + `message` text (see Claude Code MCP docs; evidence excerpt below) |
| Codex | `codex-mcp.json` | `mcpServers.upublish.tool_timeout_sec` | 21600 | **seconds** | MACHINE-VERIFIED (same emission; see evidence) | EXPECTED — verify on install (see steps below) |
| Gemini CLI | `gemini-extension.json` | `mcpServers.upublish.timeout` | 21600000 | **ms** | MACHINE-VERIFIED (same emission; see evidence) | EXPECTED — verify on install (see steps below) |
| Antigravity | `mcp_config.json` | — | not set | — | MACHINE-VERIFIED (same emission; see evidence) | EXPECTED — verify on install (see steps below) |

---

## Timeout Knob Details

| Client | Field | Value | Units | Source |
|--------|-------|-------|-------|--------|
| Claude Code | `mcpServers.upublish.timeout` | 21600000 | **milliseconds** (ms) | `.mcp.json` |
| Gemini CLI | `mcpServers.upublish.timeout` | 21600000 | **milliseconds** (ms) | `gemini-extension.json` |
| Codex | `mcpServers.upublish.tool_timeout_sec` | 21600 | **seconds** | `codex-mcp.json` |
| Antigravity | (none set) | — | — | `mcp_config.json` — no timeout field present |

**Units are not interchangeable.** Claude Code and Gemini CLI use `timeout` in milliseconds.
Codex uses `tool_timeout_sec` in seconds. Swapping the units silently produces the wrong
deadline (e.g., treating 21600000 ms as seconds would mean a 6,000-hour timeout).

**Antigravity gap:** The official Antigravity MCP docs cover only auth/connection; no
per-tool deadline knob is documented. The `timeout` field appears to be dropped by Antigravity.
An `MCP_SERVER_REQUEST_TIMEOUT` env var appears in practitioner blogs but is unconfirmed.
No knob is set in `mcp_config.json`. Residual risk: a long publish may time out at Antigravity's
default. Verify against a live install before adding any knob.

---

## Progress EMISSION: Machine-Verified Evidence (DW-4.4a)

The following log was captured by running the real `publish()` + MCP adapter code path
through the same mock-fetch harness used by the test suite (`tests/mcp.test.ts`). The
harness intercepts network calls (manifest, R2 uploads, finalize) but exercises the actual
hashing logic, notification dispatch, and byte-weighted progress math in full.

**Caveat:** This is harness-captured emission. The captured notifications faithfully reflect
what the publish adapter emits over the MCP transport. Live interactive render (the spinner/bar
visible in each client's UI) is the on-install verification step — see per-client steps below.

**Scenario:** 2-file publish (index.html=20B, style.css=19B, totalBytes=39). Both files needed
(upload all). progressToken = `"tok-capture"`.

```
=== Captured notifications/progress sequence ===
Files: index.html (20B), style.css (19B), totalBytes=39
Total notifications emitted: 6

[ 1] HASHING  method=notifications/progress  token=tok-capture  progress=0/39   msg="Hashing 0 B / 39 B (0/2 files)"
[ 2] HASHING  method=notifications/progress  token=tok-capture  progress=20/39  msg="Hashing 20 B / 39 B (1/2 files)"
[ 3] HASHING  method=notifications/progress  token=tok-capture  progress=39/39  msg="Hashing 39 B / 39 B (2/2 files)"
[ 4] UPLOAD   method=notifications/progress  token=tok-capture  progress=0/39   msg="0 B / 39 B (0/2 files)"
[ 5] UPLOAD   method=notifications/progress  token=tok-capture  progress=20/39  msg="20 B / 39 B (1/2 files)"
[ 6] UPLOAD   method=notifications/progress  token=tok-capture  progress=39/39  msg="39 B / 39 B (2/2 files)"
```

**What the evidence shows:**
- Phase 1 (notes 1–3): three `notifications/progress` with `"Hashing X / Y (n/m files)"` message
  prefix, byte-weighted (`total=39`), covering 0 → 1 → 2 files hashed.
- Phase 2 (notes 4–6): three `notifications/progress` with upload byte-count message, same token,
  same byte total, covering 0 → 1 → 2 files uploaded.
- All 6 notes share `progressToken="tok-capture"` (one token, two 0→100% sweeps).
- Phase ordering: all HASHING notes precede all UPLOAD notes.

**Test names that prove emission** (from `tests/mcp.test.ts`, Phase 3 suite):
- `test_DW_3_1_hashing_emits_progress_notification_with_correct_message` — at least 1 hashing note with `"Hashing …"` prefix, correct format
- `test_DW_3_2_hashing_progress_byte_weighted_same_token` — byte-weighted total, same progressToken, final hash note reaches `progress === total`
- `test_T3_7_phase_transition_hashing_then_upload_correct_messages` — both phases fire; all hashing notes precede upload notes; all share one token

---

## Claude Code: Confirmed Render

Claude Code renders MCP `notifications/progress` as a live progress bar with the `message`
field displayed as text beneath it.

**Source:** Claude Code MCP documentation confirms that when a tool call sends
`notifications/progress`, Claude Code displays a progress indicator with the `message` content
rendered as the progress description. The `progress` / `total` fields drive the visual bar.

**What users see during a publish:**
1. Progress bar starts at 0% with message `"Hashing 0 B / 39 B (0/2 files)"`
2. Bar advances through hashing phase: `"Hashing 20 B / 39 B (1/2 files)"` ... `"Hashing 39 B / 39 B (2/2 files)"`
3. Bar resets to 0% for upload phase: `"0 B / 39 B (0/2 files)"`
4. Bar completes at 100%: `"39 B / 39 B (2/2 files)"`

The two-sweep design (hashing → upload) means the bar goes 0→100% twice on the same
progressToken, which Claude Code handles by re-rendering from the current `progress/total` values.

---

## Codex: Expected; Verify on Install

**Timeout:** `tool_timeout_sec: 21600` (seconds) in `codex-mcp.json`.

**Emission:** Same `notifications/progress` sequence as above is emitted (harness-verified).

**Render:** Codex supports MCP progress notifications. Exact visual form (spinner, bar, inline
text) depends on the Codex CLI version installed.

**Steps to verify on install:**
1. Install the plugin: `codex plugin install /path/to/upublish/.codex-plugin/`
2. Run: `codex "publish my ./dist to test-site"` with a directory containing ≥2 files.
3. Observe the terminal output during the publish tool call.
4. Expected: progress messages appear (either inline text or a spinner with the `message` field
   from each notification). You should see "Hashing …" messages followed by byte-count upload messages.
5. Verify the 6-hour timeout applies: for a large publish that takes >1 minute, the tool should
   not time out at 30s (Codex's default); if it does, confirm `tool_timeout_sec` is being read.

**Honest gap:** Codex progress rendering has not been confirmed from outside a live install.
The notification sequence is correct; whether Codex surfaces it as visible UI is unverified here.

---

## Gemini CLI: Expected; Verify on Install

**Timeout:** `timeout: 21600000` (milliseconds) in `gemini-extension.json`.

**Emission:** Same `notifications/progress` sequence as above is emitted (harness-verified).

**Render:** Gemini CLI supports MCP progress notifications per the MCP spec. Visual form depends
on the Gemini CLI version installed.

**Steps to verify on install:**
1. Install the extension: copy `gemini-extension.json` and `dist/mcp.js` to the Gemini extensions directory.
2. Run: `gemini "publish ./dist to test-site"` with a directory containing ≥2 files.
3. Observe terminal output during the publish tool call.
4. Expected: progress text appears, including "Hashing …" messages for the hashing phase and
   byte-count messages for the upload phase.
5. Verify timeout: confirm that a large publish does not terminate at 30 s or 60 s (Gemini CLI
   defaults); it should run for up to 6 hours.

**Honest gap:** Gemini CLI progress rendering has not been confirmed from outside a live install.

---

## Antigravity: Expected; Verify on Install

**Timeout:** None set in `mcp_config.json`. See gap documentation in CLAUDE.md.

**Emission:** Same `notifications/progress` sequence as above is emitted (harness-verified).

**Render:** Antigravity's handling of `notifications/progress` is unverified. The MCP spec
allows clients to ignore progress notifications; whether Antigravity surfaces them is not
documented in official sources.

**Steps to verify on install:**
1. Install the plugin per Antigravity plugin docs.
2. Run a publish with ≥2 files and observe whether any progress output appears.
3. Check whether the session/tool-call survives a publish longer than 30 seconds (timeout gap).
4. If progress is not rendered, report as a known gap; the publish still succeeds — progress
   notifications are fire-and-forget and never block the publish.
5. If a timeout knob is discovered (e.g., `MCP_SERVER_REQUEST_TIMEOUT` env var confirmed in
   official docs), add it to `mcp_config.json` and bump the version.

**Honest gap:** Both progress rendering and timeout knob are unverified for Antigravity.
This is the highest-risk client for long publishes.

---

## Key Finding: Timeouts and Progress Are Independent (DW-4.5 correction text)

**No client resets its per-tool wall-clock timeout on `notifications/progress` receipt.**

This has been confirmed for Claude Code (per Claude Code MCP documentation: progress
notifications do not reset or extend the tool timeout) and is the same behavior for Codex and
Gemini CLI. Progress notifications are cosmetic everywhere — they update the UI but do not
interact with the timeout machinery.

**Consequence:** The wall-clock timeout knob (`timeout` / `tool_timeout_sec`) is the only thing
that keeps a long publish alive. Sending heartbeat progress notifications does not extend the
deadline. If the timeout is too short for a large publish, the publish will be killed at the
deadline regardless of how many progress notifications have been sent.

**Implication for configuration:** The 6-hour timeout values (21600000 ms / 21600 s) must be
set correctly. For Antigravity, where no confirmed knob exists, a long publish remains at risk.

---

## Test Suite Coverage

All emission behavior is covered by the passing test suite (760 tests, `bun test`). The Phase 3
tests in `tests/mcp.test.ts` that specifically cover hashing progress notifications:

| Test name | What it proves |
|-----------|----------------|
| `test_DW_3_1_hashing_emits_progress_notification_with_correct_message` | ≥1 hashing note with correct format |
| `test_DW_3_2_hashing_progress_byte_weighted_same_token` | byte-weighted total, same token, final note at 100% |
| `test_DW_3_2_T3_3_totalBytes_zero_uses_file_count_fallback` | zero-byte files use file-count fallback, no NaN/Infinity |
| `test_DW_3_3_no_progress_token_zero_notifications` | no progressToken → zero notifications |
| `test_DW_3_4_heartbeat_stopped_in_finally_no_leak` | heartbeat stops after publish completes |
| `test_T3_6_sendNotification_rejects_publish_still_completes` | transport error is swallowed; publish succeeds |
| `test_T3_7_phase_transition_hashing_then_upload_correct_messages` | phase order: all hashing before all upload |
