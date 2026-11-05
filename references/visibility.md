# Site visibility and access control

## Visibility modes

| Mode | Behavior | Plan | When to use |
|---|---|---|---|
| `public` | Anyone with the link can view. Default. | All | Portfolios, docs, demos, anything meant to be shared openly |
| `passcode` | Visitors must enter a passcode to view | **Paid** (Pro/Max) | Client previews, limited-access pages |
| `gated` | Visitors submit a form (email, name, ...) first | **Max** | Lead capture, "leave your email to read" pages |

On the free plan every site is public. Passcode calls fail with a "requires a paid plan" error; offer `upgrade`.

## The `visibility` tool

`visibility(slug, visibility, passcode?, label?, namespace?)` is the only tool that changes who can view a site that is already published. No republish.

- **Make it private:** `visibility(slug, "passcode", passcode: "<code>")`. The code is added first, then the switch, so the site is never locked with zero codes. If the site already has codes, `passcode` can be left out.
- **Make it public again:** `visibility(slug, "public")`. Stored passcodes are kept but not enforced while the site is public. Do not pass `passcode` with `public`; the call is refused.
- **Always report what the tool prints.** The result states the visibility the site has now. Do not tell the user a site is private unless it says `PASSCODE`.
- If the code is added but the switch then fails, the error says so and states the visibility the site still has.

## Setting visibility on publish

```
visibility: "passcode"
passcode: "preview2026"
```

When visibility is `passcode`, `passcode` is **required** on the first publish. Two traps:

- `publish(visibility: "public")` on a site that is already passcode-protected does **not** make it public. Use the `visibility` tool.
- Republishing with `visibility: "passcode"` and a `passcode` adds **another** code labelled `default` each time. Old codes keep working. List them with `passcode_list` and `passcode_revoke` the ones that should stop working.

## Passcodes

A site can have several passcodes, each with a label (`Client A`, `Team B`) so one can be revoked without affecting the rest.

| Tool | Use |
|---|---|
| `passcode_add(slug, code, label?)` | Add a code to a site that is **already** `passcode`. On a public or gated site it refuses and adds nothing, because the code would not be enforced. It points you to `visibility`. |
| `passcode_list(slug)` | Show each code's id, label and creation date |
| `passcode_revoke(slug, id or label)` | Remove one code |

Before revoking a site's only code, check with the user: add a replacement first, or switch the site to `public` with `visibility`.

## Form gate (Max plan)

`gate` collects visitor details before showing the site. Actions: `set` (fields: `email`, `name`, `company`, `phone`), `get`, `remove`, `submissions`, `clear`.

- `gate set` makes the site `gated` and **replaces** passcode protection. Anyone who types an email gets in. The result says when it replaced a passcode. Do not use it as a lock.
- `gate remove` requires `visibility_after: "public"` or `"passcode"`. Without it nothing changes. Ask the user which one they mean: "stop collecting emails" does not necessarily mean "make it public". `"passcode"` needs at least one code already.
- On a gated site, `visibility` succeeds but the gate stops being enforced; its settings and submissions remain until `gate remove`.

## Removing protection: what not to do

- Do not tell the user to republish to go public. It does not work; use `visibility(slug, "public")`.
- Do not call `gate remove` to "make a site public" without `visibility_after: "public"`.

## How passcode protection works

When a visitor hits a passcode-protected site:
1. The Worker serves an HTML passcode form
2. Visitor enters a passcode
3. If correct, an HMAC-signed cookie is set (valid 24 hours)
4. Subsequent visits within 24 hours skip the form

Passcodes are hashed with SHA-256 before storage; neither the API server nor the Worker keeps the plaintext. Changes take up to a minute to reach the edge.

## Choosing the right mode

- Default to `public` unless the user asks for restricted access
- Suggest `passcode` when they mention passwords, restricted access, client previews, or "only people with the code"
- Don't suggest `passcode` for personal projects; it adds friction with little benefit
- Say up front that passcodes need a paid plan
