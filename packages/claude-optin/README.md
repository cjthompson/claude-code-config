# claude-optin

A terminal UI for managing which Claude Code plugins, MCP servers, **and individual skills** are active, reducing the token cost of each session's initial context window.

## Why it exists

Every enabled plugin injects its skills and agent definitions into Claude's context at session start, every active MCP server loads its tool schemas, and every discovered skill (personal, project, or plugin-supplied) can carry its own resident cost depending on how visible it is. With many of each installed, this adds up quickly. `claude-optin` lets you keep a large catalog available but disable what you don't need in a given repo — or set user-wide defaults — so Claude starts with only what's relevant.

It manages all four in four tabs, switched with `Tab`:

- **Plugins** — discovered from the plugin cache.
- **MCP servers** — discovered from every `.mcp.json` found walking the current directory up to your home directory, plus user-scope servers in `~/.claude.json`. A server you disable stays *defined* but isn't started, so it contributes no startup context. Names listed in your settings that have no matching definition are shown flagged as **orphans** so you can clean them up.
- **Skills** — every discovered skill: personal (`~/.claude/skills/`), project (`.claude/skills/`, including directory-scoped subfolders), and active-plugin skills. Each shows its effective visibility state and resident token cost. Plugin-backed skills are always on and read-only here — manage those from the Plugins tab instead.
- **Trust** — whether the current repo (or, with `--global`, every entry in `~/.claude.json`) has accepted Claude Code's trust dialog. See [Trust](#trust) below.

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
| `Tab` | Switch between the Plugins, MCP Servers, Skills, and Trust tabs |
| `j`/`k`, arrows | Move up/down |
| `space`/`enter` | Cycle state: Plugins/MCP inherit → on → off; Skills on → name-only → off (skips user-invocable-only); Trust: prompts `Trust <path>?` / `Untrust <path>?`, `y` confirms, any other key cancels |
| `l`/right | Expand a plugin (skills/agents), server (connection details), skill (collision paths), or trust entry (onboarding fields, suppressing ancestor) |
| `h`/left | Collapse |
| `a` | Expand/collapse all |
| `g`/`G` | Jump to top/bottom |
| `s` | Cycle sort: default / name / enabled / source / skills+agents / tokens |
| `D` | Delete plugin (removes cache, prompts for confirmation) — Plugins tab only |
| `O` | Set explicit **on** — Skills tab only |
| `U` | Set explicit **user-invocable-only** — Skills tab only |
| `C` | Clear the override at the current write scope — Skills tab only |
| `q` | Quit (changes are saved on every toggle) |

The header shows the total estimated token cost of all currently-enabled plugins so you can see the impact of your changes. (MCP servers load their tool schemas at connect time, so their cost can't be estimated statically and is shown as `?`.)

The header also shows an `N on/M off` count, resolved the same way `claude-optin` resolves everything else: **only the layer(s) currently in view**. A plugin key merely *existing* in `enabledPlugins` doesn't mean it's enabled — check the boolean, not just presence. And `--global`/`-g` intentionally shows *only* the user layer (that's what "GLOBAL defaults" in the header means): a plugin off there can still be `true` in a specific repo's `.claude/settings.local.json` or `.claude/settings.json`, and will show as on/actively used in that repo. Run plain `claude-optin` (no `-g`) from inside a repo to see its actual effective state — the merge of local → project → user.

On the Trust tab, the header adds an `N trust (X trusted/Y untrusted)` count at the start of the line, keeps the other counts, and shows the writes path as `~/.claude.json` regardless of `--global`.

## Trust

The `hasTrustDialogAccepted` flag in `~/.claude.json`'s `projects` map marks a repository as trusted. When a repo is trusted, Claude Code skips the "do you trust this folder?" prompt on startup. This tool provides CLI flags to read and write this flag:

| Flag | Effect |
|------|--------|
| `--trust [PATH]` | Mark a path as trusted (default: current repo's trust key (git root; main checkout for a linked worktree)). Creates an entry in `projects` with `hasTrustDialogAccepted: true` |
| `--untrust [PATH]` | Mark a path as untrusted (default: current repo's trust key (git root; main checkout for a linked worktree)). Sets `hasTrustDialogAccepted: false` |
| `--trust-status` | Show the current repo's trust state (trusted/untrusted/no entry). If untrusted but the dialog is suppressed by another trusted entry (an ancestor, or a linked worktree's own root), shows that path and an explanation |
| `--trust-status -g` | List all trusted/untrusted entries in `~/.claude.json` → `projects`, marking the current repo's key with `* ` |

### Trust tab

The Trust tab mirrors the CLI flags above in the TUI. Without `--global`, it shows a single row for the current repo's trust key, even when `~/.claude.json` has no entry for it yet (shown as **no entry**, distinct from **trusted**/**untrusted**/**unset**). With `--global`, it lists every entry in `~/.claude.json` → `projects`, with the current repo's key marked **current**; if the current key has no entry, it's still added to the list as a **no entry** current row so you can trust it from there.

Press `space`/`enter` on a row to prompt `Trust <path>?` / `Untrust <path>?`; `y` confirms and writes to `~/.claude.json`, any other key cancels. Trusting sets `hasTrustDialogAccepted: true` on an **untrusted**, **unset**, or **no entry** row. Untrusting a **trusted** row removes the flag and keeps the rest of the entry, leaving it **unset** (no `hasTrustDialogAccepted` field), which Claude Code treats the same as untrusted. **Untrusted** means the flag is explicitly `false`, which Claude Code writes itself and `--untrust` sets. `l`/right expands a row to show its onboarding fields (when present) and, on the current repo's row only when it isn't trusted, the suppressing ancestor causing the #72896 mismatch described below. This tab always writes `~/.claude.json`, never the repo's settings files.

Toggling a **non-canonical** row in `--global` mode (a `projects` key that isn't a realpath) writes the realpath'd form, same as the CLI — this may add a new row to the list rather than updating the one you toggled.

A malformed `~/.claude.json` shows an error badge and leaves the file untouched. As with the CLI, a live Claude Code session can overwrite your change — see the caveats below.

### Why a repo can stay untrusted despite no prompt (issue #72896)

Claude Code applies trust in two steps:
1. **Dialog suppression** walks from your current directory up through ancestors, stopping at the git root. If any ancestor is trusted, the prompt is suppressed.
2. **Applied trust** (access to settings, MCP servers, etc.) requires an *exact key match* — only the precise git root's entry grants access.

**Linked git worktrees.** Applied trust for a linked worktree (`git worktree add`) is keyed on the
*main checkout* (for a bare repo, the bare repository directory), so `--trust` run inside a worktree
trusts the main checkout and therefore every worktree of it. Dialog suppression, however, only walks
up to the worktree's *own* root. A trusted entry for the worktree path itself can therefore hide the
prompt while the main-checkout key stays untrusted; `--trust-status` reports that case. Submodules
keep their own path as the key.

This means an ancestor can suppress the prompt without the exact git root being trusted. Run `--trust-status` to see this mismatch and `--trust` to fix it — then start a new session.

### Caveats

- **Home directory (`$HOME`) trust is session-only** — Claude Code ignores persisted trust for your home directory and recomputes it each session. `--trust $HOME` will warn you about this.
- **Live sessions can overwrite changes** — A running Claude Code session caches `~/.claude.json` and rewrites the whole file. Changes you make with this tool are reliable for *new* sessions; if a session is live in the repo you're trusting, verify the change took effect before closing that session.

## How it works

Plugins have three possible states at each settings layer:

| State | Meaning |
|-------|---------|
| **on** | Explicitly enabled at this layer |
| **off** | Explicitly disabled at this layer |
| **inherit** | Defers to the next layer down |

Layers are resolved in order: **local → project → user → default** (installed plugins default to enabled).

### MCP servers

MCP servers use three states — **approved**, **hidden**, and **pending approval** — stored as two name-lists in each settings file: `enabledMcpjsonServers` and `disabledMcpjsonServers`. Toggling moves a server's name between them (or removes it, for pending). Unlike plugins, MCP resolution is **disable-wins, not nearest-layer-wins**: a disable in *any* layer hides the server, regardless of which layer is nearer, matching Claude Code's own resolution. An enable only takes effect if no layer disables it and the current repo is trusted; otherwise it stays pending. Pressing SPACE on a server that another layer disables shows `!` and a "blocked by \<layer\>" footer badge rather than silently doing nothing. In an untrusted repo, enabling a server keeps it pending (shown as `!` with "blocked: untrusted") until the repo is trusted. Project settings come from the git root, or the current directory if there's no git repo — plugin and skill overrides resolve from that same settings root.

### Skills

Skills use four states instead of three, stored under `skillOverrides` in the same settings files:

| State | Meaning |
|-------|---------|
| **on** | Fully visible: name, description, and `when_to_use` are resident |
| **name-only** | Only the skill's name is resident — cheaper, but Claude can't decide to invoke it from its description alone |
| **user-invocable-only** | Nothing resident; only invocable if you ask for it by name yourself |
| **off** | Not available at all |

Resolution checks the qualified address (e.g. `apps/web:deploy`) before the plain name, across the same local → project → user → default layers as plugins and MCP servers. An **active plugin-backed skill is always effectively `on`** and any override on it is inert — plugins are the unit of control for their own skills; toggle the plugin itself instead. A skill authored with `disable-model-invocation: true` in its frontmatter is locked to **user-invocable-only** the same way — an author lock always wins over a settings override, which is shown as inert rather than effective.

### Project-level (per-repo)

When run without `--global`, changes are written to `.claude/settings.local.json` in the repo root — the nearest git root, or the current directory if there's no git repo. This file is gitignored and personal — it won't affect teammates.

Use this to disable plugins that aren't relevant to a particular codebase.

### User-level (global defaults)

With `--global`, changes are written to `~/.claude/settings.json`. These apply across all repos unless overridden at the project or local layer.

Use this to turn off plugins you rarely use anywhere.

## Applying changes

After saving, run `/reload-plugins` inside a live Claude Code session to pick up the changes immediately, or start a new session.
