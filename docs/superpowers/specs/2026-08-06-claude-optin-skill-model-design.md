# Claude Opt-In Skill Model Design

## Goal

Add a pure, renderer-independent model for discovering skills and determining
their effective opt-in state, mutability, and resident context cost.

## Scope

The work stays in `packages/claude-optin/claude-optin` and its Python test
suite. It does not add a curses tab, change key bindings, alter manifests, or
update public documentation.

## Frontmatter and discovery

The model parses only the opening YAML-style frontmatter block in each
`SKILL.md`. It exposes `name`, `description`, `when_to_use`, and
`disable_model_invocation`, accepting plain and quoted scalars plus folded
(`>`) and literal (`|`) block values. Folded values join nonblank continuation
lines with spaces; literal values preserve newlines.

Discovery returns records for personal skills, root-project skills,
directory-scoped project skills, and skills supplied by active installed
plugins. Project skill addresses are unqualified at the repository root and
directory-qualified below it. Plugin skill addresses are
`plugin-name:skill-name`. Cache entries that are not installed or whose plugin
is effectively disabled are excluded. Equivalent addresses collapse into one
record, retaining all contributing paths and the selected precedence source.

## Settings and effective state

`Settings` owns `skillOverrides` alongside the existing plugin and MCP
settings. It resolves a qualified address through local, project, and user
layers before attempting the unqualified skill name through those same layers.
Valid explicit states are `on`, `name-only`, `user-invocable-only`, and `off`.
Mutation helpers set a state, cycle in that order, or clear a state at a chosen
scope without modifying unrelated settings; an empty `skillOverrides` map is
removed when saved.

## Display model

`skill_display(skill, settings)` is pure and returns renderer-ready facts:
effective state and source, author-lock status, any inert override, and a
resident-token estimate. Active plugin skills are always shown as `on` and a
matching override is inert. `disable-model-invocation: true` locks the visible
state to `user-invocable-only`; a conflicting setting is inert rather than
effective. Token estimates are rounded up from character count: `on` counts
the command name, description, and `when_to_use`; `name-only` counts the
command name; `user-invocable-only` and `off` cost zero.

## Testing

Tests use temporary filesystem fixtures and import the executable’s pure model
directly. They cover every frontmatter form, all discovery sources and
collisions, disabled and stale plugins, qualified-address precedence and all
mutations, display-state rules, locks, inert overrides, and token-cost states.
The verification command is:

```sh
python3 packages/claude-optin/test_claude_optin.py -v
```
