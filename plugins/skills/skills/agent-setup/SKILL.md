---
name: agent-setup
description: >
  Scaffold a repo's agent files: AGENTS.md, a CLAUDE.md that imports it, a docs/ folder, and a
  docs index that AGENTS.md points to — the layout the learn skill records into. Use when the user
  invokes /agent-setup or says "set up agent files", "add AGENTS.md", "scaffold CLAUDE.md and docs".
---

Set up the repo root so every agent session loads one instruction file that leads to the docs.

## Files

**`AGENTS.md`** — the single source of truth. Minimal:

```markdown
# <Project name>

<One line: what the project is.>

## Gates

- `<command>` — <what it checks>

## Docs

Topic docs live in `docs/`, indexed in [docs/README.md](docs/README.md) with a one-line claim
each. Read the doc covering an area before changing its code. A new doc gets its line in the
index in the same change.
```

**`CLAUDE.md`** — exactly one line, so Claude Code loads the same instructions Codex reads:

```markdown
@AGENTS.md
```

**`docs/README.md`** — the index:

```markdown
# Docs

One line per doc: the link, then the claim a reader needs before opening it.
```

## Procedure

1. Read what exists first. Never overwrite content:
   - `AGENTS.md` exists: add only the missing Docs section (or correct one that doesn't point at
     the index). Leave the rest.
   - `CLAUDE.md` has content but `AGENTS.md` doesn't exist: move that content into `AGENTS.md`
     below the project line, keeping every rule and its own subheadings (demote a stray H1), then
     reduce `CLAUDE.md` to `@AGENTS.md`.
   - Both have content: fold `CLAUDE.md`'s unique lines into `AGENTS.md`, then reduce `CLAUDE.md`
     to `@AGENTS.md`.
   - `docs/` already has files: list each in the index with a one-line claim read from the file.
2. Fill the project line from the README or manifest (`package.json`, `Cargo.toml`,
   `pyproject.toml`, …).
3. Fill Gates from the repo's real checks — test, lint, typecheck, build scripts in the manifest,
   `Makefile`, or CI config. Only commands that exist, written as a one-shot run that exits
   (`vitest run`, not watch mode) with the repo's package manager. No gates found: drop the
   section.
4. Create `docs/README.md` even when there are no docs yet — it is where `learn` adds new topic
   docs, and the empty index is what AGENTS.md links to.
5. Nothing else: no placeholder docs, no conventions sections, no `.claude/` rules. `learn` grows
   the files from real sessions.
6. Commit only these files when the repo is a git repo, unless the user said not to:
   `Add agent files: AGENTS.md, CLAUDE.md import, docs index`.
