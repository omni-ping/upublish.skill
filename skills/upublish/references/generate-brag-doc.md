# Generate: Brag Doc

Portfolio-grade showcase document for the current project. Not a README — a document that communicates craftsmanship.

## Process

### 1. Discover

Scan the current repository to understand what was built:

- **Identity**: package.json, Cargo.toml, pyproject.toml, go.mod — name, description, deps
- **Purpose**: README if it exists, CLAUDE.md, any docs/
- **Shape**: entry points, core modules, directory structure
- **Patterns**: dependency injection, clean layering, clever abstractions, hard problems solved simply
- **Scale**: file count, line count, test coverage presence

Read the key source files — not just manifests. Understand the actual architecture.

### 2. Identify what's impressive

Before writing anything, reason through these questions:

- What hard problem does this solve, and what's the non-obvious part?
- What architecture decisions show craft? Not "it has modules" — what SPECIFIC choices were made and why are they good?
- What would a senior engineer notice and respect?
- What tradeoffs were made, and why were they the right ones?
- What's the delta between how this works and the naive approach?

If the project is simple, acknowledge that. Don't inflate.

### 3. Compose

Write the brag doc in markdown using this structure. Each section builds on the last — the reader should feel pulled through.

**Hero** (H1) — Project name + one bold sentence that captures what it does and why it's impressive. This is the dominant visual element. No badges. No boilerplate. Leave whitespace after it.

**The Problem** — What this solves, framed so the reader feels the pain. 2-3 sentences max. Make them care before showing the solution.

**Key Decisions** — The 2-4 architecture or design decisions that show craft. For each:
- What was decided
- What the alternatives were
- Why this choice was better

Use a blockquote to pull out the core insight from each decision — the "aha" moment.

**How It Works** — A concise architecture narrative. Not a file listing — show how the pieces fit together and WHY they're organized this way. A reader should understand the system's shape in under 60 seconds.

**What Makes It Different** — 1-2 paragraphs on what sets this apart from the obvious approach. This is where you show the gap between "works" and "well-crafted."

### 4. Present

Print the full brag doc to the conversation. Then ask the user if they want to save it — suggest `BRAG.md` in the project root.

## Craft

These rules prevent the output from reading like AI-generated slop.

**Lurch.** Vary sentence length. Short sentences hit hard. Then let a longer one unspool to carry the reader through a more complex idea before snapping back. Three consecutive sentences within five words of each other? Rewrite.

**Spike.** Vary information density across paragraphs. Pack one tight with technical detail. Let the next breathe — one idea, stated simply. Uniform density is a machine tell.

**Shift register.** Move between precise and casual within the piece. Technical for a sentence, then conversational. Follow a careful argument with something wry. One tone sustained throughout is a costume, not a voice. Have opinions when the context calls for them.

**Get specific.** Never write for everyone. Reference the particular pattern, the particular tradeoff, the particular file where the clever thing lives. "Credentials are read fresh from disk on every call" beats "the system avoids stale state." Unglamorous details are more convincing than dramatic ones.

### Self-check (run before finalizing)

1. Sentence length — shortest vs longest gap at least 20 words?
2. Three consecutive same-length sentences? Break one.
3. Register — did you shift at least twice?
4. Density — every paragraph the same density? Compress one, stretch another.
5. Specificity — at least one concrete detail a generic model wouldn't produce?

## Voice

Confident, specific, technical. Like explaining your work to a smart peer over coffee. Show don't tell — instead of saying "elegant architecture," describe the specific pattern and let the reader conclude it's elegant. No marketing language. No superlatives. The craft speaks.

## Constraints

- Every claim grounded in something specific in the codebase — no generic praise
- If the project is simple, the brag doc is short. Don't inflate.
- No badges, shields, or install instructions — this isn't a README
- No git history analysis — work from the code as it stands
