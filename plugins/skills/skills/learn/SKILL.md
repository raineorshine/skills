---
name: learn
description: >
  Add relevant learnings from this session to repo agent files (CLAUDE.md,
  AGENTS.md, .claude/ rules) and repo documentation. Use when the user invokes
  /learn or says "add learnings", "record what we learned", "update the repo's
  agent files with this".
hooks:
  Stop:
    - hooks:
        - type: command
          command: 's="${CLAUDE_PLUGIN_ROOT}/scripts/sweep.mjs"; [ -f "$s" ] || s="${CLAUDE_PLUGIN_ROOT}/skills/learn/scripts/sweep.mjs"; [ -f "$s" ] || { echo "learn: sweep.mjs not found under ${CLAUDE_PLUGIN_ROOT}" >&2; exit 1; }; NODE_USE_SYSTEM_CA=0 exec node "$s" hook'
          timeout: 30
          statusMessage: Learn sweep check
---

Add relevant learnings from this session to repo agent files.

## The sweep

Recall favours the end of a long session: a pass written from what comes to mind records the last
stretch and loses the middle. So the pass works from the transcript, not from memory, and a script
holds it to every line of it. `sweep` below means `node "${CLAUDE_SKILL_DIR}/scripts/sweep.mjs"`; in
Codex the script is `scripts/sweep.mjs` in the folder holding this file. Write the command out in
full each time: zsh will not split a command stored in a variable. Run learn in the main session: a
subagent cannot launch the extractors, and the hook watches the main transcript.

1. **Cut.** `sweep start --session "${CLAUDE_SESSION_ID}"` cuts the transcript into chunks of
   about 80k characters, from where this session's last passing learn run stopped (or the top) to
   this invocation, and prints one prompt per chunk. When the user asks for learnings in plain
   words after a run already passed, `start` opens a new run at their message. Pass `--full` (with
   `--force` once a run has started) when the user asks to look again at what an earlier run
   already swept. If `/learn`'s own arguments call the run off, release it now (below) instead.
2. **Extract.** Launch one fresh subagent per chunk, all in a single message and in the foreground
   (`run_in_background: false`), each given only the prompt `start` printed for it. Each chunk file
   carries its own instructions, and its subagent files the ledger through `sweep ledger`, which
   refuses a ledger that skipped part of the chunk. Never extract a chunk in this context, merge
   chunks into one subagent, or skip one as routine: a fresh context per chunk is what makes the
   recall even. In Codex, spawn one agent per chunk the same way; with no subagent tool, extract the
   chunks one at a time.
3. **Judge.** `sweep candidates` lists every candidate the extractors found. Decide each against
   the bars below: record it, cite where it is already covered, or reject it under a named bar. One
   learning found in two chunks is recorded once, and its twin is covered by that line. A candidate
   scoped `global` is `repo-only` unless the repo's own files are where it belongs.
4. **Write** the learnings, following [Recording](#recording).
5. **Dispose.** Pipe one JSON line per candidate into `sweep dispose --batch -`:

   ```
   {"id": "c001-01", "recorded": "AGENTS.md:42", "report": "<the learning, in one line for the reader>"}
   {"id": "c001-02", "covered": "docs/release.md:10", "quote": "<words on or near that line>"}
   {"id": "c003-04", "rejected": "transient", "reason": "<why>"}
   ```

   A recorded line must be one this pass wrote (not text moved from elsewhere), non-blank, in a
   file this repo's git tracks, and claimed by one candidate only; it needs the `report` line that `sweep report` will print for it; a covered one must quote what the
   file says there; a rejection must name a bar. A relative path is read from the directory `start`
   ran in, then from the repo root. `dispose` checks each line, saves only the ones that hold, and
   says which failed.
6. **Check.** Run `sweep check` until it passes. It fails on a chunk with no valid ledger, a
   candidate with no disposition, and a disposition the files do not bear out.
7. **Report** by printing `sweep report`'s output as it is, and land the change; see
   [Landing](#landing).

The Stop hook in this skill's frontmatter refuses to end a turn while the latest learn run has no
passing check. When three pushes in one turn change nothing (a denied command, say), it tells the user
instead and raises it again next turn. Codex ignores frontmatter hooks, so hold yourself to the same
gate there. If the user calls the run off, `sweep release --quote "<their words>"` closes it; it
accepts only a whole message of theirs, or most of one, sent after the run began.

The sweep covers the whole conversation even when another skill invoked this one as one of its
steps: a ship's tail is not a smaller scope.

## Bars

A candidate is rejected only under one of these ids. `check` refuses any other.

- `repo-only`: it belongs in a global or user agent file, a memory, or another repo. This skill
  writes repo agent files and repo documentation only; do not modify global agent files, user agent
  files, or memories.
- `overfit`: it is true only of the one artifact or incident, and no claim transfers.
- `overgeneral`: it is a platitude any agent already follows. Between this and `overfit`, find the
  sweet spot rather than rejecting: most candidates hold a claim that transfers once reworded.
- `transient`: it was true only during this session, such as an outage or a one-off state.
- `superseded`: it was reversed or corrected later in the session; the later candidate carries the
  learning.
- `not-a-learning`: routine work with nothing to know before acting.
- `user-declined`: the user said not to record it.

These are not bars:

- **"The code already shows it."** The docs and agent files are the source of truth for the agent
  system. Knowledge that exists only in code, a comment, or a commit message has not been recorded:
  it is immanent in the solution, not stated as a claim the next agent can read before touching
  anything. A rule is read *before* the code is opened, so the code demonstrating it arrives too late
  to be the warning. The duplication to avoid is between docs and agent files themselves: one home
  per claim, the code linking to it.
- **Another skill's reason.** A capture skill finding the code already carries the lesson is that
  skill's bar, not this one's.

## Recording

- Create the agent file when the repo has none. A repo with no root `AGENTS.md` or `CLAUDE.md` gets
  both before anything is recorded: `AGENTS.md` with a line saying what the project is, its gates,
  and a Docs section linking each file or folder under `docs/` with a one-line claim, and `CLAUDE.md`
  containing only `@AGENTS.md`. A learning written only to `docs/` is invisible without it, since no
  session loads `docs/` on its own. Scaffolding skills such as Compound Engineering's never create
  this file; they only add lines to one that already exists.
- Write the claim that transfers, not the incident it came from. Figures that describe one artifact
  — timings, element counts, coordinates, anything that scales with what happened to be on screen —
  belong in that artifact's own comment, and in a shared doc they read as thresholds without being
  any. Keep a number when a later decision turns on it, and say what it is a sample or a floor of.
- Capture the investigation, not only its answer. When the session found its way by trial and error
  — a platform or OS mechanism that behaved differently than assumed, undocumented or private
  behaviour, several approaches that failed before one worked — write a repo doc (`docs/<topic>.md`)
  with: the moving parts as they actually are, the approach that works and its quirks, every dead
  end with the reason it fails so it is not retried, and the techniques that transferred. Link the
  doc from the code it explains and from the agent file, so the next reader finds it before
  reworking the helper. A dead end recorded only in the chat is the most expensive learning to lose,
  and a one-line gotcha in the agent file is not where it goes.
- Yield the episode to the repo's own solutions store, where it has one. A repo that runs a capture
  skill beside this one — `ce-compound` filing under `docs/solutions/`, or any store of past problems
  kept for search — owns the single solved incident, and this skill's job beside it is the standing
  rule. The bars are not in conflict, because the two are found at different moments: a rule earns
  its place by being read before the file it governs is opened, where code demonstrating it is no
  help, and an episode earns its place only when the final code does not already carry the reasoning.
  Run that skill first at the same checkpoint, then write the one-line claim and a plain link to what
  it filed — never a retelling, and never a `docs/<topic>.md` for a single incident. A topic doc
  describes a mechanism as it actually behaves; a solution doc describes a mistake. A solution doc or
  a spec covers only what it actually states: a candidate is `covered` by the line that states it,
  not by a document on the same subject. The instruction files stay this skill's: a capture skill
  offering to add its own discoverability line is offering to edit the file you are about to edit,
  so decline it and take the tip as input.
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

## Landing

- A pass covers what happened before it, and a session rarely ends where it shipped. Where a repo's
  ship skill invokes this one, that is mid-session: everything after — a review that found something,
  a hook or a tool that misbehaved, a constraint you failed and fixed — never reaches that pass. A
  second invocation later in the same session is ordinary rather than redundant: it sweeps from where
  the last passing run stopped. The report's first line names the stretch swept, so a later ask to
  "record what we learned" has a boundary rather than a guess.
- Ship at the end without being asked, once `check` passes. Say what changed and where first — the
  built-in working-changes diff takes per-line comments, which is the cheapest way to push back on
  wording — then land it: follow the repo's own ship skill if it has one, and otherwise commit. Do not
  stop to ask; a learning is cheap to correct afterwards and expensive to lose to an unanswered
  question. When learn was invoked on its own rather than by a ship, take the ship's landing steps
  but not its archive or close-the-session steps: the session is still the user's.
- Land the learnings alone. Never sweep unrelated working-tree changes into the ship — commit only
  the agent files and docs this skill edited, plus whatever a companion capture skill wrote at the
  same checkpoint, and say what was left behind. Those files are the other half of the same
  learnings, not unrelated work; leaving them uncommitted strands them.
- Report only what landed: the output of `report`, which prints the stretch swept and one line per
  recorded learning. A learning that was considered and not added — already covered, filed by a
  companion capture skill, or rejected — is not a finding, and listing it pads the report with
  non-events that crowd out the lines that did change.
- Each learning line leads with `📚 `, which `report` adds. The report almost never stands alone — it
  lands inside a larger response, usually a ship's, where an unmarked learning reads as just another
  commit and the reader cannot tell which part of the turn this skill produced. The prefix goes on
  the learnings themselves and on nothing else: a commit hash, a file count, which files were left
  untracked, and a note about how a learning was worded are the ship noise the prefix exists to be
  distinguished *from*, so marking them too is what makes the marker useless. It goes on each
  learning line, never on a heading above a block: a heading is the thing that failed to make it
  obvious. This is the report prefix, unrelated to any session-title prefix a repo's own conventions
  may set.
