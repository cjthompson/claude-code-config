# Output Styles

Custom output styles for Claude Code. An output style is a markdown file (YAML frontmatter + body) that Claude Code injects into the system prompt for a session, letting you swap presentation or behavior rules without forking the default instructions.

## Quick Start

Install from the repo root:

```bash
npm run install-package output-styles
```

Then inside Claude Code:

```
/output-style          # opens the picker — choose "Concise"
/output-style default  # revert to the built-in default
```

The picker reads styles from `~/.claude/output-styles/`.

## Available styles

| File | Frontmatter `name` | Description |
|---|---|---|
| `output-styles/concise.md` | Concise | Terse answers; action lists captured as tasks rather than buried in prose |

## Frontmatter reference

| Field | Type | Required | Purpose |
|---|---|---|---|
| `name` | string | yes | Label shown in the `/output-style` picker |
| `description` | string | yes | One-liner shown next to the name in the picker |
| `keep-coding-instructions` | boolean | no (default `false`) | When `true`, Claude Code keeps its built-in coding-task guidance underneath your style's body. When `false` or omitted, the style replaces that guidance. Use `true` for styles that only tune presentation (like `concise.md`); use `false` for styles that fundamentally redefine how Claude should code. |

## Adding a new style

1. Create `packages/output-styles/output-styles/<slug>.md`:

    ```markdown
    ---
    name: My Style
    description: One-line description shown in the picker
    keep-coding-instructions: true
    ---

    # Section heading

    Imperative guidance about how Claude should respond...
    ```

2. Add `"output-styles/<slug>.md"` to the `files` array in `manifest.json`.

3. Install:

    ```bash
    npm run install-package output-styles
    ```

4. In Claude Code, run `/output-style` and confirm your new style is listed.

## Package layout

The source layout mirrors the install destination so the installer can copy each file in `files` from `packages/output-styles/<path>` straight to `~/.claude/<path>`:

```
packages/output-styles/
├── README.md
├── manifest.json
└── output-styles/        # mirrors ~/.claude/output-styles/
    └── concise.md        # → ~/.claude/output-styles/concise.md
```

Files install via copy (not symlink), so edits to a style file require a reinstall to take effect — run `npm run install-package output-styles` after each change.
