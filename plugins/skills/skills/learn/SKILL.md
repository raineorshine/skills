---
name: learn
description: >
  Add relevant learnings from this session to repo agent files (CLAUDE.md,
  AGENTS.md, .claude/ rules) and repo documentation. Use when the user invokes
  /learn or says "add learnings", "record what we learned", "update the repo's
  agent files with this".
---

Add relevant learnings from this session to repo agent files.

**Sweep the whole conversation before judging any of it.** Recall favours the last stretch, so a
pass that writes what comes to mind records the end of a long session and loses its middle. Walk
the conversation in order, phase by phase — design, planning, building, review, verification,
shipping, and whatever came after — and list every candidate before deciding on one: each
correction the user made, each tool, hook, skill or platform that behaved differently than
assumed, each dead end, each verification technique that worked, each rule another skill had to
be overridden with, each finding a reviewer or a gate raised. Then apply the bars below to the
list. The pass covers the whole conversation even when another skill invoked it as one of its
steps — a ship's tail is not a smaller scope — and another skill's reason for not recording
something (a capture skill finding the code already carries it) is that skill's bar, not this
one's.

- Repo agent files and repo documentation only. Do not modify global agent files, user agent files, or memories.
- Create the agent file when the repo has none. A repo with no root `AGENTS.md` or `CLAUDE.md` gets
  both before anything is recorded: `AGENTS.md` with a line saying what the project is, its gates,
  and a Docs section linking each file or folder under `docs/` with a one-line claim, and `CLAUDE.md`
  containing only `@AGENTS.md`. A learning written only to `docs/` is invisible without it, since no
  session loads `docs/` on its own. Scaffolding skills such as Compound Engineering's never create
  this file; they only add lines to one that already exists.
- Do not overfit or overgeneralize. Try to find the sweet spot.
- Write the claim that transfers, not the incident it came from. Figures that describe one artifact
  — timings, element counts, coordinates, anything that scales with what happened to be on screen —
  belong in that artifact's own comment, and in a shared doc they read as thresholds without being
  any. Keep a number when a later decision turns on it, and say what it is a sample or a floor of.
- The docs and agent files are the source of truth for the agent system. Knowledge that exists only
  in code, a comment, or a commit message has not been recorded: it is immanent in the solution, not
  stated as a claim the next agent can read before touching anything. Do not skip a learning because
  the code "already shows it" — that holds because a rule is read *before* the code is opened, so the
  code demonstrating it arrives too late to be the warning. The duplication to avoid is between docs
  and agent files themselves — one home per claim, the code linking to it.
- Capture the investigation, not only its answer. When the session found its way by trial and error
  — a platform or OS mechanism that behaved differently than assumed, undocumented or private
  behaviour, several approaches that failed before one worked — write a repo doc (`docs/<topic>.md`)
  with: the moving parts as they actually are, the approach that works and its quirks, every dead
  end with the reason it fails so it is not retried, and the techniques that transferred. Link the
  doc from the code it explains and from the agent file, so the next reader finds it before
  reworking the helper. A dead end recorded only in the chat is the most expensive learning to lose.
- Yield the episode to the repo's own solutions store, where it has one. A repo that runs a capture
  skill beside this one — `ce-compound` filing under `docs/solutions/`, or any store of past problems
  kept for search — owns the single solved incident, and this skill's job beside it is the standing
  rule. The bars are not in conflict, because the two are found at different moments: a rule earns
  its place by being read before the file it governs is opened, where code demonstrating it is no
  help, and an episode earns its place only when the final code does not already carry the reasoning.
  Run that skill first at the same checkpoint, then write the one-line claim and a plain link to what
  it filed — never a retelling, and never a `docs/<topic>.md` for a single incident. A topic doc
  describes a mechanism as it actually behaves; a solution doc describes a mistake. The instruction
  files stay this skill's: a capture skill offering to add its own discoverability line is offering
  to edit the file you are about to edit, so decline it and take the tip as input.
- Gotchas of the system, OS, tool, or shell that the repo runs against — a command shadowed by an
  alias, a daemon that stays dead after `killall`, a lint tool with no dialect for a file type — go
  in the agent file when they change how an agent should act in this repo, and in the topic doc
  when they only matter for that one mechanism.
- Prefer correcting an existing section over appending a new one. A learning that contradicts what is
  already written is a correction, not an addition.
- Keep AGENTS.md under 300 lines. At the cap, a new learning earns its place by displacing a weaker
  one or by moving a section's detail into a topic doc that the file links to — not by growing the
  file. **The cap is met, never reported.** If the edit would exceed it, keep cutting until it does
  not: an overage disclosed in the report is the constraint treated as a budget, and it hands the
  user a decision about a file you have already committed.
- A pass covers what happened before it, and a session rarely ends where it shipped. Where a repo's
  ship skill invokes this one, that is mid-session: everything after — a review that found something,
  a hook or a tool that misbehaved, a constraint you failed and fixed — never reaches a pass at all.
  Say at the end of the run which stretch was covered, so a later ask to "record what we learned"
  has a boundary rather than a guess, and treat a second invocation later in the same session as
  ordinary rather than redundant.
- Ship at the end without being asked. Say what changed and where first — the built-in
  working-changes diff takes per-line comments, which is the cheapest way to push back on wording —
  then land it: follow the repo's own ship skill if it has one, and otherwise commit. Do not stop to
  ask; a learning is cheap to correct afterwards and expensive to lose to an unanswered question.
- Land the learnings alone. Never sweep unrelated working-tree changes into the ship — commit only
  the agent files and docs this skill edited, plus whatever a companion capture skill wrote at the
  same checkpoint, and say what was left behind. Those files are the other half of the same
  learnings, not unrelated work; leaving them uncommitted strands them.
- Report only what landed. A learning that was considered and not added — already covered by an
  existing line, filed by a companion capture skill, or shipped in the source under a separate
  change — is not a finding, and listing it pads the report with non-events that crowd out the lines
  that did change. Name the new and updated learnings; say nothing about the rest.
- Lead each learning with `📚 `. The report almost never stands alone — it lands inside a
  larger response, usually a ship's, where an unmarked learning reads as just another commit and the
  reader cannot tell which part of the turn this skill produced. The prefix goes on the learnings
  themselves — what was recorded and why it transfers — and on nothing else: a commit hash, a file
  count, which files were left untracked, and a note about how a learning was worded are the ship
  noise the prefix exists to be distinguished *from*, so marking them too is what makes the marker
  useless. It goes on each learning line, never on a heading above a block: a heading is the thing
  that failed to make it obvious. This is the report prefix, unrelated to any session-title prefix a
  repo's own conventions may set.
