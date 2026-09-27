# skills

Packages opted-in user skills from `~/.agents/skills` as one public Claude Code plugin, `skills`,
so cloud sessions can run them. One setup-script line installs the whole bundle.

## Layout

- `skills.txt` — the opt-in list; a skill is published only when named here
- `plugins/skills/skills/*/` — copies of the skills; never edit here
- `sync.sh` — copies the listed skills in from `~/.agents/skills`, commits and pushes
- `plugins/skills/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — plugin and marketplace manifests

## Editing a skill

`~/.agents/skills/<skill>/` is canonical: shared with Codex and loaded locally through the
`~/.claude/skills` symlinks. Edit it there and commit; the post-commit hook in `~/.agents` runs
`./sync.sh`. An edit made only here is overwritten by the next sync.

To publish a skill, add its name to `skills.txt` and run `./sync.sh`. This repo is public: read the
skill for names, addresses, account details and private links before listing it.

## Cloud sessions

The cloud's GitHub proxy lets a session reach only the repos attached to it, and rejects a token
for anything else — so private repos cannot be fetched from a setup script, and this repo is
public. Public marketplaces clone fine during setup. A container installs fresh, so no version bump
is needed for the cloud to get `main`.

Do not install the plugin on this machine: the user-level skills already load, and the plugin would
add `skills:*` duplicates beside them. `claude --plugin-dir plugins/skills` loads the working tree
for one session.

## Docs

Topic docs live in `docs/`, indexed in [docs/README.md](docs/README.md) with a one-line claim
each. Read the doc covering an area before changing its code. A new doc gets its line in the
index in the same change.

## Git

Conventional-commit subjects (`feat:`, `fix:`, `docs:`, `sync:`).
