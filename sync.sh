#!/usr/bin/env bash
# Copy the skills named in skills.txt from ~/.agents/skills (their canonical home, shared with
# Codex) into the plugin, and ~/.agents/PUBLIC_AGENTS.md (the public global rules) to the repo
# root, then commit and push if anything changed. Runs from the post-commit hook in ~/.agents;
# safe to run by hand. Copies the committed state (HEAD), never the working tree, so an
# uncommitted edit in ~/.agents is not published.
set -euo pipefail
cd "$(dirname "$0")"
AGENTS="${AGENTS_REPO:-$HOME/.agents}"
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT
git -C "$AGENTS" archive HEAD skills | tar -x -C "$SRC"
if git -C "$AGENTS" cat-file -e HEAD:PUBLIC_AGENTS.md 2>/dev/null; then
  git -C "$AGENTS" show HEAD:PUBLIC_AGENTS.md > PUBLIC_AGENTS.md
fi
SRC="$SRC/skills"
DEST=plugins/skills/skills
names="$(grep -v -e '^#' -e '^[[:space:]]*$' skills.txt)"
for name in $names; do
  [ -f "$SRC/$name/SKILL.md" ] || { echo "sync.sh: $name is listed but skills/$name/SKILL.md is not committed in $AGENTS" >&2; exit 1; }
  mkdir -p "$DEST/$name"
  rsync -a --delete --exclude .DS_Store "$SRC/$name/" "$DEST/$name/"
done
# Drop skills no longer listed.
for dir in "$DEST"/*/; do
  [ -d "$dir" ] || continue
  grep -qx "$(basename "$dir")" <<<"$names" || rm -rf "$dir"
done
git add -A "$DEST" skills.txt PUBLIC_AGENTS.md
if git diff --cached --quiet; then
  echo "sync.sh: no changes"
  exit 0
fi
changed="$( { git diff --cached --name-only "$DEST" | cut -d/ -f4; git diff --cached --name-only PUBLIC_AGENTS.md; } | sort -u | paste -sd, - | sed 's/,/, /g')"
git commit -q -m "sync: $changed"
git push -q "${SKILLS_REMOTE:-origin}" HEAD:main
echo "sync.sh: pushed $(git rev-parse --short HEAD)"
