# Site visibility and access control

## Visibility modes

| Mode | Behavior | When to use |
|---|---|---|
| `public` | Anyone can view. Default. | Portfolios, docs, demos, anything meant to be shared openly |
| `unlisted` | Accessible by direct URL only, excluded from any future directory/listing | Drafts, internal previews, things you share with specific people |
| `passcode` | Visitors must enter a passcode to view | Client previews, paywalled content, limited-access pages |

## Setting visibility on publish

Pass `visibility` and optionally `passcode` to `mcp_upublish_publish`:

```
visibility: "passcode"
passcode: "preview2026"
```

When visibility is `passcode`, the `passcode` parameter is **required** — the tool will error without it.

## Changing visibility after publish

Use the API's PATCH endpoint (not yet exposed as an MCP tool). For now, republish with the new visibility setting.

## How passcode protection works

When a visitor hits a passcode-protected site:
1. The Worker serves an HTML passcode form (styled, not ugly)
2. Visitor enters the passcode
3. If correct, an HMAC-signed cookie is set (valid 24 hours)
4. Subsequent visits within 24 hours skip the form

The passcode is hashed with SHA-256 before storage — neither the API server nor the Worker stores the plaintext passcode.

## Choosing the right mode

- Default to `public` unless the user explicitly asks for restricted access
- Suggest `unlisted` when they say things like "I just want to share this with someone" or "don't make it public"
- Suggest `passcode` when they mention passwords, restricted access, client previews, or "only people with the code"
- Don't suggest `passcode` for personal projects — it adds friction with little benefit
