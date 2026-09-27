---
name: learn-organize
description: >
  Review the repo's agent files (CLAUDE.md, AGENTS.md, .claude/ rules) and docs
  for coherency and clean organization. Use when the user invokes
  /learn-organize or says "organize the agent files", "clean up CLAUDE.md",
  "the docs are a patchwork", "reconcile the agent files".
---

Review the agent files and docs in this repo for coherency and clean organization. They've been somewhat of a patchwork effort from various worktrees.

## What Claude Code loads

Establish this before judging size, placement, or duplication. Claude Code's loader is not Codex's:
there is no override file, no fallback filename, and no byte budget.

- At launch, a session loads the managed policy file, `~/.claude/CLAUDE.md`, and `~/.claude/rules/`,
  then — from the filesystem root down to its working directory — each level's `CLAUDE.md`,
  `.claude/CLAUDE.md`, `.claude/rules/` files without `paths:` frontmatter, and `CLAUDE.local.md`, in
  that order. Every file found loads, nearest level last, unless a `claudeMdExcludes` pattern in
  settings drops it. That is the launch chain, and this session's is already in your context: every
  instruction file it loaded, under its path.
- A worktree nested inside its main checkout skips the `CLAUDE.md`, `.claude/CLAUDE.md`, and rules
  files from the checkout root down to the worktree's parent directory, but still loads
  `CLAUDE.local.md` from those directories.
- `AGENTS.md` loads only when a loaded file imports it (`@AGENTS.md`) or a `CLAUDE.md` is a symlink
  to it. An `AGENTS.md` nothing reaches is invisible to Claude Code: wire it in with an `@AGENTS.md`
  line in the `CLAUDE.md` beside it, creating that file if needed, and say so when you say what
  changed.
- `@path` imports expand in place whenever the importing file loads, up to four hops deep, relative to
  the importing file; an `@` inside backticks or a code block stays literal. Splitting a file into
  imports saves no context.
- `CLAUDE.md`, `CLAUDE.local.md`, and `.claude/rules/` in directories below the working directory
  load once Claude reads a file anywhere under that directory, and rules with `paths:` frontmatter
  once it reads a file their globs match. They sit outside the launch chain but still count when
  looking for duplicates and conflicts.
- User files, managed files, and `CLAUDE.local.md` load too but are not the repo's to change: edit
  only checked-in files, flag a conflict with one of them when you say what changed, and keep a repo
  rule that repeats one — the repo's other readers don't load them.

## Organize

- Fetch before restructuring. Other sessions' learn passes write into the same files, and a
  reorganization collides with theirs wholesale, up to two sessions splitting the same doc the same
  way. `git fetch origin` and read `git log HEAD..origin/main` over the agent files and docs first;
  rebase onto anything there before editing. On a later collision with another restructure, keep one
  structure and port the other side's additions into it rather than resolving hunk by hunk.
- Keep the repo's share of the launch chain under 300 lines: every checked-in file a session at the
  repo root (the worktree root, in a worktree) loads at launch, imports included.
- `AGENTS.md` is Codex's file too. Codex reads the `AGENTS.md` files from the repo root down to its
  working directory and stops at 32 KiB combined by default — keep those under 32 KiB as well.
- When either limit is exceeded, factor out meaningful units into `./docs` — a coherent topic per file
  (a subsystem, a workflow, a toolchain), not an arbitrary tail split to get under the limit.
  Leave behind in the instruction file the one-line claim that transfers plus a plain Markdown link to
  the doc — never an `@` import, which loads the doc along with the file — so an agent knows the topic
  exists and when to open the file. Move sections by script rather than retyping them, then list every
  sentence of the originals that no longer appears anywhere in the agent files and docs: each one must
  be a cut you meant, and a claim dropped in a rewrite leaves no other trace.
- A doc outside the launch chain is a patchwork too once it runs past about 300 lines under one
  heading, whatever the limits say. Split it by subsystem the same way — what a rule-writer needs
  apart from the machinery underneath — even when nothing above is over its limit.
- Simplify as you go. Cut hedging, throat-clearing, and restated rationale; a rule earns its place
  by changing what an agent does, not by explaining itself. Prefer one concrete sentence over a
  paragraph, and drop guidance that has gone stale, that the code now enforces on its own, or that
  explains what any agent already knows, like how git or the language works.
- Remove duplication. When the same rule appears in more than one repo file or section, keep the
  single best statement in the place it belongs and delete the rest — a link where the other location
  still needs to know the topic exists. Near-duplicates that differ in detail are a conflict, not two
  rules: reconcile them into one and say which reading you kept. Date both with `git log -S'<phrase>'`
  over the docs: the later one usually records a measurement or a failure the earlier did not have,
  so keep it unless the earlier one is backed by something the later ignores.
- Extract the sections that are situational — read when working on that area — before the ones that
  apply to every task. What every session needs stays inline.
- Group by where a rule applies, not by when it was added. A patchwork file reads in the order its
  rules were learned; regroup each rule under a heading for the area or task an agent is working on
  when it needs that rule. A doc you create or restructure takes the shape of the clearest existing
  doc of its kind — subsystem, workflow, toolchain. Two shapes mark a patch inside a single doc: a
  later paragraph retracting an earlier one ("the ceiling above was a misreading"), and a sentence
  re-scoping everything after it ("what follows now describes X"). Rewrite the claim, or regroup under
  a heading for X, and drop the history.
- Re-read every file you touched end to end once the edits are in, and fix the seams piecemeal moves
  leave: a rule that contradicts its new neighbor, a point made twice, a link in any file to a heading
  that moved. Update or drop any path or command the touched files name that no longer exists.
- Check the examples the docs cite against the code or config they describe. A doc that says a named
  rule, function or file still has a shape it lost reads as current until someone opens the source,
  and a fresh reader cannot catch it — it has nothing to compare against. Two sweeps are cheap: grep
  every backticked identifier the docs cite against the source, and match every `doc > Heading`
  citation against the target file's headings.
- Check first any recipe that claims a safe way to exercise a write — trip a guard, stub a route,
  post an impossible value. A later change to the code path can turn it into the real write with no
  word changing in the doc, and it is the one stale claim that costs the user something when followed.
- A doc that records a surface's removal ("since removed", "no longer") usually still describes it
  in the present tense elsewhere. Grep the surface's name across the docs and rewrite what remains.
- Before moving or renaming a section, search the whole repo for what points at it: skills and code
  comments reference docs by path and by quoted heading name (`docs/x.md "Heading"`), not only by
  Markdown link, and those break silently. Where what points at it is a record you may not edit —
  another skill's files, a dated plan — keep the old file as an index naming each section and its new
  home, so the path still resolves (a citation lint may require it) and a heading citation can still
  be followed.
- Test the result on a reader with no context before shipping; having read the old files, you can't
  see what the new ones fail to say. Give one fresh subagent 5–10 questions a new session would need
  answered, weighted toward the rules you moved or merged. Have it answer from the agent files and
  docs alone — starting from what a new session loads and following links, searching only when the
  links run out — say how it found each answer, and flag anything ambiguous, contradictory, or
  resting on context the files don't give. Tell it to read every file from disk: its own launch
  context can carry the instruction files as committed rather than your uncommitted edits, and then
  it answers from the old version. A wrong answer, an answer that needed a search, or a flag
  that holds up is a defect: fix it, re-ask every question of a fresh subagent, and name what still
  fails when you say what changed.
- Ship at the end without being asked. Say what changed and where first — the built-in
  working-changes diff takes per-line comments, which is the cheapest way to push back on wording —
  then land it: follow the repo's own ship skill if it has one, and otherwise commit. Do not stop to
  ask; a reorganization is cheap to correct afterwards and expensive to lose to an unanswered question.
- Land the reorganization alone. Never sweep unrelated working-tree changes into the ship — commit
  only the agent files and docs this skill edited, and say what was left behind. Code comments you
  repointed at moved sections are part of it; they put source in the commit, so run the repo's gates
  before landing.
