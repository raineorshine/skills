# Scripts

- Write scripts in Node.js, not Python — for helper scripts, one-off data wrangling, and inline `-e` snippets alike. Use Python only when the project is already Python or a library exists nowhere else.
- Prefer a deterministic script to agent inference whenever the step has one right answer: a CLI, AppleScript (`osascript`), an app's API, a shell pipeline, or a helper script. A script is faster, repeatable, and needs no per-session permission. For example, a Calendar view switch is one `osascript` call, where computer-use clicks need an access grant every session.
- Keep agents (computer use, browser driving, subagents) for steps that need real inference, such as reading an unfamiliar page, judging content, or choosing between options. When you spot a step that is driven by hand but could be scripted, script it, and put the command in the skill or doc that governs that step.
- Start node in a Claude Code hook as `NODE_USE_SYSTEM_CA=0 node …`. The desktop app exports `NODE_USE_SYSTEM_CA=1`, a hook runs under `/bin/sh` without the shell profile, and loading the macOS keychain roots adds about 150 ms to every node start, network or not. Leave it off only for a hook that reaches a host signed by a root that lives only in the keychain.

# Worktrees

- A worktree shares only `.git`, so it starts without `node_modules` and every other gitignored local file. Restore them at session start rather than assuming they carry over — but defer to the project's own worktree setup where it has one.
- Share dependencies by symlink, never by copying: symlinking `node_modules` to the main checkout is instant, where duplicating it costs more than a clean install (measured, 2155 npm packages: symlink 0.3s, `npm ci` 16s, `cp -Rc` APFS clone 20s, `cp -Rl` hardlink 45s). Speed is the reason, not disk.
- Only symlink when the shared tree is provably the one the worktree needs — lock files agreeing entry for entry **and** the main checkout's installed tree still matching its own lock, since a checkout that pulled a dependency change without reinstalling passes the lock-file comparison alone. Otherwise install. Either way say which tree the worktree got, because a symlinked tree is shared for writes too: `npm install <pkg>` from a worktree mutates the main checkout's `node_modules`.

# Browser

- When using my browser, start by opening a separate browser window for the task. Keep task-related tabs in that window. When the task is complete, close the window you created, unless it contains a result I need to inspect or continue using. Preserve all pre-existing browser windows and tabs, and restore the previously active window when practical.

# Scheduling

- Never schedule background work during working hours — no 9am jobs. Default recurring and unattended runs to 22:00 local, the slot I already use.
- A one-off run I ask for with no time named starts now, overriding the 22:00 default: create it with no schedule and fire it at once, not a few minutes out.

# Cloud sessions

- In a Claude Code cloud session, hand work to another repo or environment with `create_session`: the `env_…` ID from `list_environments`, the repo as `source_url`. Then check with `get_session` on the child that it landed there. No route tried from a regular claude.ai chat did this: the scheduled tasks it created ran as chats, even when given a Claude Code environment's ID (observed 2026-10-24).
- The child has none of the parent's context, so its start prompt must stand alone. It doesn't wake the parent when done: read its result with `list_events`, after a `send_later` check-in a few minutes out (a follow-up on live work, not background work; it fails if this session is gone by then). It may wait for my approval before an outward step another session asks for (one child did, for a `send_message` back), so give me its `claude.ai/code/session_<id>` link.

# Reporting

- Show every time in my local time zone, in 12-hour format, with the zone named — "3:41:39 PM EDT", not "15:41:39" or "19:41:39Z". Local means the machine's zone; in a cloud session (`CLAUDE_CODE_REMOTE=true`, clock on UTC) use US Eastern. Convert UTC timestamps from logs, APIs and transcripts before reporting them.

- Verify your own work automatically wherever the environment allows it — run the gates, drive the UI, exercise the script — and report what the check showed. Never hand the verification back: no "try it and let me know", no list of steps for me to click through, no waiting on my confirmation before continuing. I test only when I ask to. This is a deliberate trade: these are small projects I use myself, and a mistake that ships costs less than a task that stalls on me.
