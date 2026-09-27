#!/usr/bin/env bash
# Copy the skills named in skills.txt from ~/.agents/skills (their canonical home, shared with
# Codex) into the plugin, then commit and push if anything changed. Runs from the post-commit hook
# in ~/.agents; safe to run by hand.
set -euo pipefail
cd "$(dirname "$0")"
SRC="${AGENTS_SKILLS:-$HOME/.agents/skills}"
DEST=plugins/skills/skills
names="$(grep -v -e '^#' -e '^[[:space:]]*$' skills.txt)"
for name in $names; do
  [ -f "$SRC/$name/SKILL.md" ] || { echo "sync.sh: $name is listed but $SRC/$name/SKILL.md is missing" >&2; exit 1; }
  mkdir -p "$DEST/$name"
  rsync -a --delete --exclude .DS_Store "$SRC/$name/" "$DEST/$name/"
done
# Drop skills no longer listed.
for dir in "$DEST"/*/; do
  [ -d "$dir" ] || continue
  grep -qx "$(basename "$dir")" <<<"$names" || rm -rf "$dir"
done
git add -A "$DEST" skills.txt
if git diff --cached --quiet; then
  echo "sync.sh: no changes"
  exit 0
fi
git commit -q -m "sync: $(git diff --cached --name-only "$DEST" | cut -d/ -f4 | sort -u | paste -sd, - | sed 's/,/, /g')"
git push -q origin HEAD:main
echo "sync.sh: pushed $(git rev-parse --short HEAD)"
