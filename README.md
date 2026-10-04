# skills

My shareable Claude Code skills, bundled as one plugin so cloud sessions get all of them from a
single setup-script line. Currently: `agent-setup`, `learn`, `learn-organize` — see
[skills.txt](skills.txt). The same line loads the public half of my global instructions,
[GLOBAL_AGENTS.md](GLOBAL_AGENTS.md).

## Install

### Cloud sessions

Add this line to the end of each environment's setup script at claude.ai/code, after anything that
writes `~/.claude/settings.json` wholesale:

```sh
claude plugin marketplace add raineorshine/skills && mkdir -p ~/.claude/skills && ln -sfn ~/.claude/plugins/marketplaces/skills/plugins/skills/skills/* ~/.claude/skills/ && echo '@~/.claude/plugins/marketplaces/skills/GLOBAL_AGENTS.md' >> ~/.claude/CLAUDE.md
```

This adds the marketplace without installing the plugin, and links its skills in as user skills, so
they keep their plain names (`/learn`). Installed as a plugin they would be namespaced
(`/skills:learn`), and doing both would list every skill twice. The last command imports
`GLOBAL_AGENTS.md` into the user-level `~/.claude/CLAUDE.md`, so its rules load in every session.
A cloud container fetches the marketplace fresh, so a skill or rule pushed here reaches the next
cloud session with no change to the setup script.

### Locally

```sh
claude plugin marketplace add raineorshine/skills
claude plugin install skills@skills
```

## License

MIT
