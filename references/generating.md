# Generating diagrams

## Overview

The `mcp_upublish_generate` tool sends context text to the upubli.sh server, which generates an Excalidraw diagram and publishes it as a static site. The result is a public URL you can share immediately.

Use this when the user wants to visualize a concept, workflow, system architecture, or process as a diagram — without managing any files locally.

## Tool parameters

| Parameter | Required | Description |
|---|---|---|
| `context` | yes | Description of what to visualize (architecture, workflow, process, etc.) |
| `diagramType` | no | `flowchart`, `sequence`, or `architecture` — server auto-selects if not provided |
| `slug` | no | URL-safe slug for the published site (auto-generated if not provided) |

## Diagram types

| Type | Best for |
|---|---|
| `flowchart` | Decision trees, process flows, step-by-step logic |
| `sequence` | Interactions between components over time, request/response flows |
| `architecture` | System components and their relationships |

If you don't specify `diagramType`, the server analyzes the context and chooses the most appropriate type automatically.

## What happens

1. The tool sends `context` (and optionally `diagramType` and `slug`) to `POST /api/generate`
2. The server generates Excalidraw diagram content using AI
3. The diagram is packaged as a static HTML page and published to upubli.sh
4. A public URL is returned

## Output

The tool returns:
- The public URL of the published diagram page
- The slug assigned to the site

Always share the URL with the user.

## Example workflow

1. User says "make a diagram of our auth flow"
2. Call `mcp_upublish_generate` with a context description of the auth flow
3. Optionally pass `diagramType: "sequence"` if the flow is request/response
4. Share the returned URL with the user

## Note on availability

The generate endpoint requires the `/api/generate` server-side feature. If it returns a 404 or "not found" error, the feature may not be enabled on the server yet.
