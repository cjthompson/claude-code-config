# Fix the dangling `outputStyle` name that silently disables Terse

## The fix

**In `~/.claude/settings.json:390`, change `"outputStyle": "Terse"` to
`"outputStyle": "output-styles:Terse"`.** That one edit makes Terse work in every directory.
Everything else in this plan is prevention and documentation — none of it is required to
make the style work tomorrow.

> **Do not use `/output-style` or `/config` for this.** Confirmed against the docs: the
> output-style menu writes to the **project-local** `.claude/settings.local.json`, not the
> user-level file, and there is no `--global`/`--user`/`--project` scope flag. `outputStyle`
> is explicitly one of the few settings that saves project-local rather than to
> `~/.claude/settings.json`. Running it would fix only the directory you run it in and leave
> line 390 dangling — reproducing the exact bug.
>
> **There is no documented CLI or menu path to set the user-level default output style.**
> Hand-editing `~/.claude/settings.json` is the only way.
>
> This also explains how the machine got into this state: the three project-local
> `"output-styles:Terse"` values are what the menu writes, while the global `"Terse"` was
> typed by hand and never corrected.
>
> The edit has to be made by you: this repo's `CLAUDE.md` puts `~/.claude/` off-limits, so
> it cannot be applied from a session here.

Then correct the one other stale value:

- `~/workspace/monolith-extraction/.claude/settings.local.json` — has `"Terse"`, and would
  keep shadowing the fixed global in that directory.

Leave `~/workspace/.claude/settings.local.json` alone. It has `"output-styles:Terse"` but is
**dead config** — no session has ever run with that cwd, and `outputStyle` does not inherit
down to `workspace/*` subdirectories. It has no effect, so removing it is optional tidying,
not part of the fix.

## Context

The `output-styles:Terse` style appears to work "sometimes." It has never worked except in
two directories.

**Root cause: `~/.claude/settings.json:390` sets `"outputStyle": "Terse"`, and no style
named `Terse` exists on this machine.** The plugin-provided style is
`output-styles:Terse`. Claude Code does not error on an unresolvable name — it records the
configured value, injects no style prompt, and runs with default behavior. `/output-style`
still prints `Output style: Terse`, which makes the setting look correct while the style
list printed directly beneath it shows the only real names.

`~/.claude/output-styles/` **exists and is completely empty**. The styles are provided
entirely by the plugin, cached at
`~/.claude/plugins/cache/cjthompson-claude-code-config/output-styles/1.0.1/`. So bare
`Terse` has no provider and cannot resolve.

### Evidence from the two sessions

| | Session `51ae4824` (Image #1) | Session `e331b86b` (Image #2) |
|---|---|---|
| Directory | `~/workspace/temp` | `~/workspace/client-onboarding` |
| `output_style_instructions` attachment | present, line 15 | **absent** |
| Per-turn `output_style` reminders | **106** | **0** |
| Own-dir `outputStyle` | `"output-styles:Terse"` | absent → falls back to user-level `"Terse"` |
| Outcome | Terse rendered correctly | default style |

Image #2 is not the model ignoring the style. **That session never received the style
prompt** — zero output-style attachments across 438 lines. The only `Terse` string in it is
the `/output-style` check run at the very end, and the style list it printed contains
`output-styles:Concise` and `output-styles:Terse` but **no bare `Terse`** — primary-source
proof, from inside the failing session, that the configured value resolves to nothing.

Both sessions ran on 2026-09-17 within ~40 minutes, so global config drift cannot explain
the difference. The only variable is the working directory.

### Corpus-wide confirmation

A sweep of 1617 transcripts found that **exactly one style name has ever genuinely reached
the model: `output-styles:Terse`** (2 sessions). Bare `Terse` was recorded as a configured
name in 1360 attachments across 19 files with **zero** rendered instruction text.

Only Claude Code v2.1.274 transcripts are diagnostic — earlier versions logged no
`rendered` field for any attachment type, so their silence is a logging gap rather than
proof. Within that diagnostic window the correlation is perfect, with no counterexamples:

| cwd | injected | no style | own-dir `outputStyle` |
|---|---|---|---|
| `~/dev/claude-code-config` | **1** | 0 | `output-styles:Terse` |
| `~/workspace/temp` | **1** | 0 | `output-styles:Terse` |
| `~/dev/claude-monitor` | 0 | 8 | absent |
| `~/workspace/gusto-pro` | 0 | 7 | absent |
| `~/workspace/client-onboarding` | 0 | 3 | absent |
| `~/workspace/client-onboarding/project` | 0 | 1 | absent |

The documented precedence, highest to lowest:

1. managed/enterprise settings
2. command line (`claude --settings`)
3. project local — `.claude/settings.local.json`
4. shared project — `.claude/settings.json`
5. user — `~/.claude/settings.json`

**The `outputStyle` setting does not scan ancestor directories.** (Custom output-style
*files* in `.claude/output-styles/` *are* scanned from the working directory up to the
repository root — but that is file discovery, not setting resolution.) That is why
`~/workspace/.claude/settings.local.json` has never applied to anything: it is neither a
session cwd nor a repository root for the projects beneath it.

### Ruled out: the plugin itself is healthy

Nothing is wrong with the plugin, its registration, or its content — which is why the fix is
a single setting and not a reinstall:

- `cjthompson-claude-code-config` is a registered marketplace.
- `output-styles@cjthompson-claude-code-config` v1.0.1 is **installed at user scope and
  enabled** (`claude plugin list --json`).
- The cached `terse.md` and `concise.md` are **byte-identical to repo `HEAD`**, so the
  recent Terse rewrites (`4fec1cd`, `9e5c85b`, `8d484c2`) are live. Stale cached style
  content is not a contributing factor.

### All five `outputStyle` declarations on this machine

| File | Value | Resolves? |
|---|---|---|
| `~/.claude/settings.json:390` | `"Terse"` | **no** |
| `~/workspace/monolith-extraction/.claude/settings.local.json` | `"Terse"` | **no** |
| `~/workspace/.claude/settings.local.json` | `"output-styles:Terse"` | dead config — never applies |
| `~/workspace/temp/.claude/settings.local.json` | `"output-styles:Terse"` | yes |
| `~/dev/claude-code-config/.claude/settings.local.json` | `"output-styles:Terse"` | yes |

Every one of these was hand-written: **nothing in this repo reads, writes, or validates
`outputStyle`.** A repo-wide grep returns zero tracked files,
`plugins/output-styles/manifest.json` has no `settings` block, and the installer's settings
merge (`packages/installer/src/lib/install.ts:296-343`) writes only `~/.claude/settings.json`
and is used only by `packages/statusline/`. With no single source of truth, the values
drifted apart.

### Why `Terse` looked like a plausible name: two routes, two identifiers

This repo ships the same two style files through two install routes that produce different
identifiers, and the README documents only the one that is not in use.

| Route | Mechanism | Identifier |
|---|---|---|
| Plugin marketplace (`README.md:10`) | `.claude-plugin/marketplace.json:34-36` maps `output-styles` → `./plugins/output-styles` | `output-styles:Terse` |
| File installer (`README.md:122`) | `plugins/output-styles/manifest.json` declares `files: [...]`; `install.ts:249-262` copies them to `~/.claude/output-styles/` | bare `Terse` |

The style name comes from the YAML `name:` field (`terse.md:1-3` → `name: Terse`), never
the filename. The `output-styles:` prefix is added by the **plugin route only**.

So `"Terse"` is exactly what the *installer* route would produce, and `README.md:120-127`
documents that route with an unprefixed style table. A reader following it would reasonably
write `Terse` into settings. The plugin route is documented separately at `README.md:10`,
and the README never reconciles the two or mentions the prefix anywhere.

Git history rules out migration drift: `terse.md` has only ever existed at
`plugins/output-styles/output-styles/terse.md`, added by `f3c3964` (2026-07-09). Its sibling
`concise.md` did move from `packages/` to `plugins/` (`267efe9` → `bfa4eb6`, 2026-06-14),
which is the likely origin of the belief that a bare user-level name should work.

## Decisions

Confirmed with the user before planning:

1. **The plugin route is canonical.** `output-styles:Terse` is the only correct name; the
   README stops advertising a package install for styles.
2. **The installer should perform a real plugin install, not a file copy.** User's words:
   > the install step should run a command to do a proper plugin install, not copy files
3. **Warn during install** when a configured `outputStyle` matches no available style,
   suggesting the closest prefixed match. Never auto-write a settings file.

## Changes

### 1. Delete `plugins/output-styles/manifest.json`

It is the **only** `manifest.json` under `plugins/`, and its entire content is the `files`
key that drives the bad copy:

```json
{
    "files": ["output-styles/concise.md", "output-styles/terse.md"]
}
```

No other plugin declares `files` or `settings`, so nothing depends on the installer's
file-copy route for plugins. Deleting this one file removes the second identifier at its
source.

> **Correction — deleting this file alone is a regression, not a fix.** Verified:
> `discover.ts:215` guards on `exists(manifestPath)` so there is no throw, but
> `plugins/output-styles/` contains no `skills/` and no `agents/`. With the manifest gone,
> `items.length === 0` hits the `continue` at `discover.ts:258` and **the descriptor
> disappears entirely** — `npm run install-package output-styles` would start printing
> `Package(s) not found: output-styles` (`install-package.ts:75-86`).
>
> So the deletion **must ship together with** the discovery change in change 2, which gates
> descriptor creation on `.claude-plugin/plugin.json` existing instead of on `items.length`.
> On its own it is exactly the "bare migration" the slicing rule forbids.

Once change 2 lands, deleting the manifest is inert data cleanup. Ten of the eleven plugins
already have no `manifest.json`, so absence is the norm. Add a regression guard —
`tests/packages/installer/plugin-manifest.test.mjs` asserting no `plugins/*/manifest.json`
exists — in the spirit of the existing `tests/plugins/project-tasks/structure.test.mjs`.

The contract being retracted is documented at `discover.ts:172`
("manifest.json files[] → file items (copied to ~/.claude/)"); update that comment.

**Do not repurpose plugin manifests.** `.claude-plugin/plugin.json` plus the
`marketplace.json` entry are the real metadata, and `discover.ts:262-269` already reads
label and description from `plugin.json`. The second parallel metadata file is what created
the divergence.

### 2. Install plugins via the CLI instead of copying files

**Reuse existing work, but fix its command.** The unmerged branch
`ct/install-plugins-script` already has `scripts/install-plugins.ts` (commit `3268f20`). Its
*shape* is right — enumerate `plugins/*/` by `.claude-plugin/plugin.json`, act per plugin,
count failures, exit non-zero.

> **Do not cherry-pick it.** That branch is **superseded**. Its command does not exist (see
> below), its `stdio: "inherit"` is wrong for a tool reachable from the Ink render, and it
> bypasses `discover`/`installPackage` entirely — so it is neither testable nor idempotent.
> The only thing worth taking from it is the npm script **name** it reserved,
> `install-plugins`. Write `packages/installer/src/install-plugins.ts` fresh, mirroring
> `reinstall.ts`, and leave `3268f20` unmerged.

> **Its command does not exist.** The script runs `claude plugin add <pluginPath>`. There is
> no `add` subcommand under `claude plugin`, and installation takes a
> `plugin@marketplace` id, not a filesystem path. Verified against the installed binary
> (v2.1.274) — the subcommands are `install`/`i`, `marketplace`, `list`, `enable`,
> `disable`, `uninstall`/`remove`, `update`, `details`, `validate`, `init`/`new`, `tag`,
> `prune`, `eval`.

The verified two-step, both idempotent and exit 0 on a repeat:

```
claude plugin marketplace add cjthompson/claude-code-config
claude plugin install -y -s user <plugin>@cjthompson-claude-code-config
```

Details that matter for the script:

- `-s, --scope <user|project|local>` defaults to `user`. User scope writes `enabledPlugins`
  and `extraKnownMarketplaces` into `~/.claude/settings.json`.
- `-y, --yes` suppresses the marketplace-declared-command prompt, so the script is headless.
- `--json` emits one machine-readable result line with an `outcome` field (`ok` / `failed`)
  and a `failureCode` on failure — parse that instead of scraping human output. Exit codes
  are 0 on success or already-installed, 1 on error.
- The marketplace name is `cjthompson-claude-code-config` (derived from the repo), already
  registered on this machine.
- Keep the command behind one named constant/function, and fail with a clear message when
  `claude` is not on `PATH` rather than a stack trace.

For the record on why `3268f20` is not worth salvaging as a commit: the branch is a chain,
with `3268f20` sitting on top of the unrelated `58b692c` ("feat(claude-optin): manage MCP
servers alongside plugins"), so it could not be merged as-is anyway. Leave the branch alone.

#### Two consequences that must be stated up front, not discovered later

> **The install pulls published GitHub `HEAD`, not this working tree.** The registered
> marketplace resolves to `{"source": "github", "repo": "cjthompson/claude-code-config"}`,
> while this checkout's only remote is `local`
> (`chris@192.168.1.87:dev/personal/claude-code-config`). So
> `claude plugin install output-styles@cjthompson-claude-code-config` installs whatever is
> published, **not** local uncommitted plugin edits. That is a genuine semantic change from
> today's copy-from-the-repo behavior, and it belongs in the README. (Today the two happen
> to agree — the cached styles are byte-identical to repo `HEAD`.) Installing from the local
> tree would need a separately-named path marketplace; that is a different feature and out
> of scope. Also note plugin changes need a Claude Code restart or `/reload-plugins` to take
> effect — say so in the result message.

> **`README.md:122`'s "Install via the TUI installer" was never true for plugins.**
> `App.ts:25` (`if (pkg.type === "plugin") continue;`) and `App.ts:48`
> (`packages.filter((p) => p.type !== "plugin")`) filter plugin descriptors out of both the
> list and `runInstall`. The only callers that reach `installPlugin` are `reinstall.ts:43`
> and `install-package.ts:97` — so the file-copy defect fires only via `npm run reinstall`
> or `npm run install-package output-styles`. Leave the `App.ts` filters alone; making
> plugins TUI-visible is a UX change nobody asked for.

Implementation notes worth honoring:

- Put the command in **one** module (`packages/installer/src/lib/plugin-cli.ts`) — argv
  builders, `CLAUDE_BIN`, and the parsers. A grep for the subcommand string should hit only
  that file.
- Use `execFile` with an argv array — never `shell: true` (plugin names would be
  injectable), and never `stdio: "inherit"` (it corrupts the Ink render). Capture and parse
  `--json`.
- Inject the spawn function so tests assert argv without executing anything.
- **Never fall back to copying files** when `claude` is missing. That reintroduces the
  duplicate identifier, which is the entire bug. Emit an error naming the manual
  `/plugin marketplace add` + `/plugin install` commands instead.
- **Do not auto-run `marketplace add`.** `marketplace.json` declares the name
  `cjthompson-claude-code-config`, which is already registered pointing at GitHub; adding
  this local path under the same name would clobber a working entry. Warn and name the
  command.
- **Do not auto-enable** a plugin that is installed but disabled — that is a user
  preference the installer did not set. Warn and suggest `claude plugin enable <id>`.
- `claude plugin list --json` returns the **same `id` more than once** at different scopes
  (verified: `command-watchdog` at both `user` and `local`; `rust-coding` twice at `local`).
  Any already-installed probe must filter to the scope it installs with and dedupe, or it
  will misfire.
- Idempotency comes from comparing the installed version against `plugin.json`'s: when they
  match, run **zero** subprocesses beyond the read-only probes and report `already-exists`.
  This mirrors the hash short-circuit `installFiles` already does at `install.ts:269-277`.
- Rewrite `removePlugin` (`install.ts:75-98`) to call `plugin uninstall`, keeping
  `installPackage`/`removePackage` symmetric.

> **Scope note for review:** dropping the file-copy route also means dropping
> `installPlugin`'s skill and agent symlink branches, so `npm run install-package
> python-scripting` will no longer create `~/.claude/skills/python-typing`. That is the
> *same* duplicate-identity bug class (bare `python-typing` vs
> `python-scripting:python-typing`), so removing it is consistent — but it is a real
> behavior removal and should be called out, not slipped in. Keep the skill/agent *scan*
> only to build the item description for the `i` info overlay.

### 3. Warn on an unresolvable `outputStyle` during install

Runs as part of the install flow, read-only, and **never writes a settings file**. It must
read the configured values, report any that match no available style, and suggest the
closest match by prefix (`Terse` → `output-styles:Terse`).

> **No CLI enumerates output styles.** `claude plugin details <name>` reports only Skills,
> Agents, Hooks, MCP servers, and LSP servers — output styles are omitted, and there is no
> `list-styles` command. Verified directly: `claude plugin details
> output-styles@cjthompson-claude-code-config` shows a component inventory with no style
> entries.

So build the available-name list from sources the installer can read:

- **plugin styles** — for each `plugins/<plugin>/output-styles/*.md`, parse the YAML `name:`
  field and prefix it: `<plugin>:<Name>`. The name always comes from frontmatter, never the
  filename (`terse.md` → `name: Terse` → `output-styles:Terse`).
- **user styles** — any `~/.claude/output-styles/*.md`, bare `name:` value.
- **built-ins** — `default`, `Concise`, `Explanatory`, `Learning`.

Optionally cross-check which plugins are actually enabled via `claude plugin list --json`
(the `id` and `enabled` fields), so the warning can distinguish "name is wrong" from
"plugin is installed but disabled."

Reuse the frontmatter-parsing shape already in `discover.ts:320-356`
(`extractSkillDescription` — `startsWith("---")` / `indexOf("\n---", 3)` / regex) for a
sibling `parseStyleName`. Do not add a YAML dependency, and do not refactor
`extractSkillDescription` — that widens the diff into change 2's files.

#### The `Concise` trap — a naive check reports working config as broken

> Built-in `Concise` **shadows** the plugin's `Concise`. So a configured bare `"Concise"`
> resolves (to the built-in) while bare `"Terse"` resolves to nothing. A rule of "not in the
> plugin list → warn" would false-alarm on a perfectly good setting.

Three outcomes, not two:

| Configured value | Outcome | Emits |
|---|---|---|
| exact match in the union | resolves | nothing |
| matches a built-in that also exists as `<plugin>:<name>` | resolves, but ambiguous | informational warning naming both |
| no match | broken | warning with file, value, and suggestion |

Suggestion order — deterministic, no edit-distance needed:

1. suffix-after-colon, case-insensitive: available `X:Y` where `Y === configured` → suggest
   `X:Y`. **This one rule covers the entire `Terse` → `output-styles:Terse` case.**
2. case-insensitive exact → suggest the correctly-cased name.
3. `startsWith` prefix match → suggest.
4. otherwise list the available names.

#### Wiring

- Add `"warning"` to `InstallResult["status"]` (`types.ts:70`). **`ResultsView.ts:14-23`
  falls through to `✗`/red for anything unrecognized**, so without an explicit branch a
  warning renders as an error.
- `reinstall.ts:47` and `install-package.ts:101` gate `hasError` on `status === "error"`
  exactly, so warnings correctly do not flip the exit code. Verify this; do not edit it.
- Run as a post-install check in all three entrypoints: `useInstaller.ts` after the loop at
  `:60`, `reinstall.ts` after `:54`, `install-package.ts` after `:108`.
- Read configured values from `<claudeDir>/settings.json` and the repo's own
  `.claude/settings.json` / `.claude/settings.local.json` only. **Do not walk the filesystem
  for other projects' settings** — the installer has no business scanning `~/workspace`.
  Tolerate missing files and invalid JSON the way `install.ts:301-306` already does.

#### Proving it never writes

Structure the pure core as `checkOutputStyle(configured, available)` returning a verdict,
with an IO wrapper that imports only `readFile`/`readdir`. Then add a test that reads the
module's **own source** and asserts it contains none of `writeFile`, `mkdir`, `unlink`,
`copyFile`, `symlink`. Cheap, and it encodes the hard constraint rather than promising it.

> **Constraint for whoever implements this:** this repo's `CLAUDE.md` forbids agents from
> reading or writing under `~/.claude/`, and `.claude/settings.json` denies
> `Read(~/.claude/**)`. The installer is runtime code and may legitimately read those paths
> when a user runs it, but the implementing agent cannot inspect them while developing. Take
> `claudeDir` as a parameter with a real default so every test runs against fixtures, and
> assume nothing about the file beyond top-level `{"outputStyle": string}`.

### 3b. Warn about stale copies left by the old route — never delete them

Earlier runs of `npm run install-package output-styles` or `npm run reinstall` would have
left `~/.claude/output-styles/terse.md` and `concise.md`, which Claude Code discovers under
bare names. Derive the path to check from the repo (for each
`plugins/*/output-styles/*.md`, the path the old `installFiles` would have written) rather
than hardcoding filenames, and use the existing `isSymlinkIntoRepo` (`discover.ts:359-367`)
to report whether it is a real copy or a symlink back into the checkout.

The message must name the file, the bare style name it manufactures, the canonical prefixed
name, and the literal `rm` command. **No `unlink` in this code path.**

Same detector shape applies to stale skill/agent symlinks left by the branches change 2
removes. That half is droppable if the diff grows; the style-copy detector is the reported
bug and is mandatory.

> On this machine there is nothing to clean: `~/.claude/output-styles/` is verified empty.
> This is for anyone who did run the old route.

### 4. Fix `README.md`

- `README.md:120-127` — drop the `~/.claude/output-styles/` install path and the
  `npm run install-package output-styles` instruction. Give the exact settings value and
  slash command with the `output-styles:` prefix shown literally. The missing prefix is the
  entire bug, so the docs must make it impossible to miss.
- `README.md:23` — the plugin table lists the styles as `Concise` and `Terse` without the
  prefix. Same correction.
- `tests/README.md:52` still points at the pre-`bfa4eb6` path `packages/output-styles/`.
  Fix while nearby.

- `README.md:33-52` (Installer section) — name the new `npm run install-plugins`, and state
  that plugin installs go through `claude plugin install` **from the published GitHub
  marketplace, not the local tree**. Correct or keep the `:42` claim about plugins not
  appearing in the TUI (it is true, and stays true).
- `README.md:122` currently claims plugins install "via the TUI installer". **That was never
  true** — `App.ts:25`/`:48` filter plugin descriptors out. Remove the claim rather than
  carrying it forward.

### Not doing

- **A TUI-visible "stale copies" row** the user can select for removal. It needs `App.ts`
  list changes plus a removal path, and `removePlugin`'s file branch is being deleted in
  change 2. Deliberate non-goal.
- **Making plugins visible in the TUI installer.** The `App.ts:25`/`:48` filters stay. That
  is a UX change nobody requested.
- **Installing plugins from the local working tree.** Would need a separately-named path
  marketplace. Out of scope; the GitHub-`HEAD` semantics get documented instead.
- **A version bump or `CHANGELOG.md` entry inside any slice.** `CLAUDE.md` scopes those to
  after a commit or merge **on `main`**. Putting them in each slice would make every slice
  conflict with every other and break "mergeable in any order" by construction.

## Slices

`~/dev` repo, so per `CLAUDE.md`: branch-per-slice discipline applies, but **skip
`gh pr create`** unless asked, and skip the post-PR Fresh Eyes watch (no CI). The local
pre-push `fresheyes` review still applies.

The remote is `local` (`chris@192.168.1.87:dev/personal/claude-code-config`), **not
GitHub** — `origin` does not exist, so `git symbolic-ref refs/remotes/origin/HEAD` fails.
Default branch is `main`. `git remote set-head` is not applicable to a non-`origin` remote;
just fetch `local` and branch from `main`.

The governing rule, quoted:

> **Default: every PR is cut from the repo's default branch and targets it.** A PR is
> "independently shippable" only if it can be reviewed and merged on its own, in any order
> relative to my other open PRs, and contains working reviewable code (not a bare migration
> or empty stub). Never slice a single function across PRs.

**Three slices, not four.** An earlier draft made the manifest deletion its own slice; that
is a regression on its own (see change 1) and has been folded into slice 2.

### Slice 1 — `ct/docs-output-style-prefix`

Docs only. Fixes the instruction that is actively producing wrong config today, and is
worth shipping whether or not the installer work ever lands.

| File | Change |
|---|---|
| `README.md:23` | plugin table: `Concise`, `Terse` → `output-styles:Concise`, `output-styles:Terse` |
| `README.md:120-127` | drop the `~/.claude/output-styles/` path, the `npm run install-package output-styles` instruction, and the false "via the TUI installer" claim; show the literal prefixed value |
| `tests/packages/output-styles/index.md` | stale `packages/output-styles/` source path |
| `tests/README.md:52` | same stale path |

Touches `README.md` lines 23 and 120-127 only — **not** 33-52, which is slice 2's territory.

### Slice 2 — `ct/installer-plugin-cli-install`

Changes 1 and 2 together. **They cannot be separated:** deleting the manifest without the
descriptor-gate change makes `output-styles` vanish from discovery (a bare migration);
changing the gate without deleting the manifest leaves contradictory copy-and-install items
on one descriptor.

| File | Change |
|---|---|
| `packages/installer/src/lib/plugin-cli.ts` | **new** — argv builders, `CLAUDE_BIN`, injectable `Spawn`, list parsers |
| `packages/installer/src/lib/paths.ts` | **new** — `claudeDir()` accessor replacing module-scope consts at `discover.ts:6` / `install.ts:6` |
| `packages/installer/src/lib/install.ts` | rewrite `installPlugin` (`:40-73`) and `removePlugin` (`:75-98`) |
| `packages/installer/src/lib/discover.ts` | rewrite `discoverPlugins` (`:176-284`): gate on `plugin.json`, one item, drop manifest/skill/agent item loops, fix the `:168-175` contract comment |
| `packages/installer/src/lib/types.ts` | add `"plugin"` to `PackageItem.itemType` (`:18`) |
| `packages/installer/src/install-plugins.ts` | **new** entrypoint mirroring `reinstall.ts` |
| `package.json` | add the `install-plugins` script (the name `3268f20` reserved) |
| `plugins/output-styles/manifest.json` | **delete** |
| `tests/packages/installer/*.test.mjs` | **new** — argv assertions via injected spawn; no-plugin-manifest guard |
| `README.md:33-52` | Installer section: `npm run install-plugins`, GitHub-`HEAD` semantics |

### Slice 3 — `ct/installer-output-style-check`

Changes 3 and 3b. Disjoint from slice 2 by construction — it wires into the three
*entrypoints* and `ResultsView`, not into `install.ts` or `discover.ts`.

| File | Change |
|---|---|
| `packages/installer/src/lib/output-style-check.ts` | **new** — pure `checkOutputStyle`, `parseStyleName`, enumeration, stale-copy detectors |
| `packages/installer/src/lib/types.ts` | add `"warning"` to `InstallResult["status"]` (`:70`) |
| `packages/installer/src/components/ResultsView.ts` | warning icon/color branch (`:14-23`) |
| `useInstaller.ts` / `reinstall.ts` / `install-package.ts` | call the check after the loop (`:60` / `:54` / `:108`) |
| `tests/packages/installer/fixtures/**` + `output-style-check.test.mjs` | **new** |

### Disjointness audit

| Contact point | Resolution |
|---|---|
| `types.ts` | slice 2 edits line 18, slice 3 edits line 70 — 52 lines apart, separate hunks |
| `README.md` | slice 1 → lines 23, 120-127; slice 2 → 33-52. No overlap |
| `claudeDir()` in `paths.ts` | introduced by slice 2; **slice 3 must not depend on it** or it acquires a merge-order dependency. Slice 3 takes `claudeDir` as a parameter and callers pass it inline |

All three bases are `main`, and no slice's diff contains another's. Recommended shipping
order is 1 → 2 → 3 because slice 1 is smallest and stops the live misinformation, **but the
order is not required**: merging 2 first leaves `README.md:122` briefly stale, merging 1
first leaves the installer briefly copying files. Both converge; neither end state is
broken.

Version bumps and `CHANGELOG.md` go on `main` after each merge, per `CLAUDE.md` — not inside
any slice. See "Not doing."

## Verification

1. After editing line 390, run `/output-style` with no argument. The printed value must
   exactly match an entry in the style list beneath it.
2. Start a fresh session in **`~/dev/claude-monitor`** (8 confirmed no-style sessions) or
   `~/workspace/gusto-pro` (7). Ask something that reports work and confirm the reply uses
   Terse structure (`` # `Label`: `` blocks, `›` facts, closing `Result` block).

   > Deliberately **not** `~/workspace/client-onboarding` for this step. Pick a directory
   > that has never held a project-local `outputStyle`, so a pass proves the *global* value
   > resolves. Testing in the directory where you might have run a scope-ambiguous
   > `/output-style` can pass for the wrong reason — a project-local value written there
   > would mask a still-dangling line 390.
3. Confirm injection at the transcript level rather than trusting rendered output:

   ```
   grep -c '"type":"output_style_instructions"' ~/.claude/projects/<dir>/<session>.jsonl
   ```

   A working session on v2.1.274+ shows one `output_style_instructions` attachment plus one
   `output_style` reminder per turn. Zero means it still is not resolving.

   > Parse each line as JSON and require top-level `type == "attachment"`. Substring
   > matching produces false positives, because transcripts discussing this bug contain the
   > marker strings as prompt text. Also note `attachment.style` is a plain **string** for
   > reminders but a **dict** with `name` + `prompt` for `output_style_instructions`, so a
   > `style.name` regex silently misses every reminder.
4. Repeat step 2 in `~/workspace/monolith-extraction` after fixing its local value. This
   also settles a question the corpus sweep could not: its only transcript predates
   `rendered` logging, so whether a project-local bare `"Terse"` ever resolved is untested.
   One fresh session there answers it.
5. `npm run install-plugins` — one line per plugin; confirm against
   `claude plugin list --json` and note the restart requirement. Re-run it: an up-to-date
   plugin must report already-installed and spawn no install command.
6. `npm run install-package output-styles` — must still resolve (this is the regression that
   deleting the manifest alone would cause) and must **not** create
   `~/.claude/output-styles/`.
7. `npm run install-packages` (the TUI) — confirm no plugin rows appear, since the
   `App.ts:25`/`:48` filters are unchanged.
8. `PATH=/usr/bin npm run install-plugins` — exercises the `claude`-not-on-`PATH` branch for
   real. Must print the manual commands and must not fall back to copying.

### Test harness facts that will otherwise waste time

> **Root `npm test` is `node --test tests/**/*.test.mjs` — `.mts` files are not matched.**
> `tests/packages/statusline/statusline-render.test.mts` never actually runs. New installer
> tests must be `.test.mjs` under `tests/packages/installer/` to execute at all.

- Node is pinned to 26 (`mise.toml`), so type stripping is on and a `.test.mjs` can
  `await import(".../plugin-cli.ts")` directly — no build step.
- `npm run typecheck` is `tsc --noEmit -p packages/installer/tsconfig.json`; run it per slice.
- Pattern to copy: `tests/plugins/project-tasks/structure.test.mjs`.
- Per slice, confirm `git diff --stat` against `main` shows only that slice's declared files,
  and that `grep -rn '"plugin"' packages/installer/src --include=*.ts` hits only
  `plugin-cli.ts` — proof the command parameterization held.
6. Point a scratch fixture at a bogus style name and confirm the warning fires and suggests
   the prefixed match.

## Out of scope

- Any change to the Terse style's rules or wording. The style content is fine; it was never
  being delivered. `docs/terse-style-rule-gaps-plan.md` and
  `docs/output-style-terse-instructions.md` are separate in-progress work — and note
  `docs/terse-style-rule-gaps-plan.md:31-33` records that
  `docs/output-style-terse-instructions.md` is a stale, unloaded design-note ancestor.
- The never-executed Codex/Cursor plugin support in
  `docs/plans/2026-08-09-codex-cursor-marketplace-support.md:355-359`.
