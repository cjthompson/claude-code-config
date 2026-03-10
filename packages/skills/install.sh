#!/usr/bin/env bash
set -euo pipefail

SKILLS_DIR="$HOME/.claude/skills"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SKILLS_DIR"

for dir in "$REPO_DIR"/*/; do
  name="$(basename "$dir")"
  # Skip non-skill directories
  [ -f "$dir/SKILL.md" ] || continue

  target="$SKILLS_DIR/$name"
  if [ -L "$target" ]; then
    echo "Already linked: $name"
  elif [ -e "$target" ]; then
    echo "Skipping $name: $target already exists and is not a symlink"
  else
    ln -s "$dir" "$target"
    echo "Linked: $name"
  fi
done
