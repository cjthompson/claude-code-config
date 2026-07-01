# git-utils

Workspace-level git status and sync tools. Located in `packages/git-utils/`. Install via the TUI installer or `npm run install-package git-utils` (installs `repos` to `~/.local/bin/`).

## repos

Scans every sub-repo in a workspace directory and reports, for each one: current branch, time of last commit, ahead/behind vs. its remote and primary branch, local change counts, and open PRs.

```sh
repos              # scan the current directory
repos <path>       # scan a specific workspace directory
repos --sync       # also non-interactively pull/push repos that are in sync range
```

Run from any directory — repo discovery is relative to the target directory, not to where the script lives. Any immediate sub-directory containing a `.git` file or directory is treated as a repo.

When run interactively (both stdin and stdout are a TTY), it offers to:

- Pull the current branch if it's behind its remote (fast-forward only)
- Update local primary branches from their remote
- Push non-primary branches that are ahead of their remote

`--sync` performs all of the above non-interactively, without prompting.

### Requirements

- `git`
- `gh` (GitHub CLI, authenticated) — used to list open PRs
- `jq`

macOS-native (`stat -f %m`, `date -j -f`); not tested on Linux.

### Configuration

Edit the `AUTHORS` array near the top of the script to control which GitHub login(s) are searched for open PRs.
