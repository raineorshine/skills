# skills

My shareable Claude Code skills, bundled as one plugin so cloud sessions get all of them from a
single setup-script line. Currently: `agent-setup`, `learn`, `learn-organize` — see
[skills.txt](skills.txt).

Installed as a plugin, they are namespaced: `/skills:learn`, `/skills:agent-setup`.

## Install

### Cloud sessions

Add this line to the end of each environment's setup script at claude.ai/code, after anything that
writes `~/.claude/settings.json` wholesale:

```sh
claude plugin marketplace add raineorshine/skills && claude plugin install skills@skills
```

A cloud container installs fresh each session, so a skill pushed here reaches the next cloud
session with no change to the setup script.

### Locally

```sh
claude plugin marketplace add raineorshine/skills
claude plugin install skills@skills
```

## License

MIT
