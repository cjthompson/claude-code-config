# claude-optin

A terminal UI for managing which Claude Code plugins are active, reducing the token cost of each session's initial context window.

## Why it exists

Every enabled plugin injects its skills and agent definitions into Claude's context at session start. With many plugins installed, this adds up quickly. `claude-optin` lets you disable plugins you don't need in a given repo — or set user-wide defaults — so Claude starts with only what's relevant.

## Installation

Installed via the package manager in this repo:

```sh
npm run install-packages
```

This places the `claude-optin` binary in `~/.local/bin/`.

## Usage

Run from inside any git repo:

```sh
claude-optin              # manage opt-ins for the current repo
claude-optin --global     # manage your user-wide defaults
```

### Keys

| Key | Action |
|-----|--------|
| `j`/`k`, arrows | Move up/down |
| `space`/`enter` | Cycle state: inherit → on → off |
| `l`/right | Expand plugin to show skills and agents |
| `h`/left | Collapse |
| `a` | Expand/collapse all |
| `g`/`G` | Jump to top/bottom |
| `s` | Cycle sort: default / name / enabled / source / skills+agents / tokens |
| `D` | Delete plugin (removes cache, prompts for confirmation) |
| `q` | Quit (changes are saved on every toggle) |

The header shows the total estimated token cost of all currently-enabled plugins so you can see the impact of your changes.

## How it works

Plugins have three possible states at each settings layer:

| State | Meaning |
|-------|---------|
| **on** | Explicitly enabled at this layer |
| **off** | Explicitly disabled at this layer |
| **inherit** | Defers to the next layer down |

Layers are resolved in order: **local → project → user → default** (installed plugins default to enabled).

### Project-level (per-repo)

When run without `--global`, changes are written to `.claude/settings.local.json` in the repo root. This file is gitignored and personal — it won't affect teammates.

Use this to disable plugins that aren't relevant to a particular codebase.

### User-level (global defaults)

With `--global`, changes are written to `~/.claude/settings.json`. These apply across all repos unless overridden at the project or local layer.

Use this to turn off plugins you rarely use anywhere.

## Applying changes

After saving, run `/reload-plugins` inside a live Claude Code session to pick up the changes immediately, or start a new session.
