# claude-optin

A terminal UI for managing which Claude Code plugins **and MCP servers** are active, reducing the token cost of each session's initial context window.

## Why it exists

Every enabled plugin injects its skills and agent definitions into Claude's context at session start, and every active MCP server loads its tool schemas. With many of each installed, this adds up quickly. `claude-optin` lets you keep a large catalog available but disable what you don't need in a given repo — or set user-wide defaults — so Claude starts with only what's relevant.

It manages both in two tabs, switched with `Tab`:

- **Plugins** — discovered from the plugin cache.
- **MCP servers** — discovered from every `.mcp.json` found walking the current directory up to your home directory, plus user-scope servers in `~/.claude.json`. A server you disable stays *defined* but isn't started, so it contributes no startup context. Names listed in your settings that have no matching definition are shown flagged as **orphans** so you can clean them up.

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
| `Tab` | Switch between the Plugins and MCP Servers tabs |
| `j`/`k`, arrows | Move up/down |
| `space`/`enter` | Cycle state: inherit → on → off |
| `l`/right | Expand a plugin (skills/agents) or server (connection details) |
| `h`/left | Collapse |
| `a` | Expand/collapse all |
| `g`/`G` | Jump to top/bottom |
| `s` | Cycle sort: default / name / enabled / source / skills+agents / tokens |
| `D` | Delete plugin (removes cache, prompts for confirmation) — Plugins tab only |
| `q` | Quit (changes are saved on every toggle) |

The header shows the total estimated token cost of all currently-enabled plugins so you can see the impact of your changes. (MCP servers load their tool schemas at connect time, so their cost can't be estimated statically and is shown as `?`.)

## How it works

Plugins have three possible states at each settings layer:

| State | Meaning |
|-------|---------|
| **on** | Explicitly enabled at this layer |
| **off** | Explicitly disabled at this layer |
| **inherit** | Defers to the next layer down |

Layers are resolved in order: **local → project → user → default** (installed plugins default to enabled).

### MCP servers

MCP servers use the same three states and the same layer resolution, but the underlying storage differs. State is stored as two name-lists in each settings file — `enabledMcpjsonServers` and `disabledMcpjsonServers` — and toggling moves a server's name between them (or removes it for *inherit*). Unlike plugins, an MCP server defaults to **off**: a `.mcp.json` server isn't loaded until it's explicitly enabled, so the safe default keeps it out of context.

### Project-level (per-repo)

When run without `--global`, changes are written to `.claude/settings.local.json` in the repo root. This file is gitignored and personal — it won't affect teammates.

Use this to disable plugins that aren't relevant to a particular codebase.

### User-level (global defaults)

With `--global`, changes are written to `~/.claude/settings.json`. These apply across all repos unless overridden at the project or local layer.

Use this to turn off plugins you rarely use anywhere.

## Applying changes

After saving, run `/reload-plugins` inside a live Claude Code session to pick up the changes immediately, or start a new session.
