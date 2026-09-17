# output-styles Tests

Tests for the `output-styles` package.

## Overview

No automated tests exist yet. Output styles are static Markdown files with YAML frontmatter.

**Source:** `plugins/output-styles/`

## Test Files

None yet.

## Suggested Test Approach

Since output styles are declarative Markdown, testing could cover:

1. **Frontmatter validation** — Verify each style file has valid YAML with required fields
   (`name`, `description`). Note the `name` field is what Claude Code uses, namespaced as
   `output-styles:<name>` because the styles are plugin-provided; the filename is not used.

2. **Functional test** — Load the style in Claude Code and verify the behavioral change
   matches the style's description

A lightweight linter script checking frontmatter completeness would be a good first test.

## How to Add Tests

1. Create a Node.js script to parse and validate all style files
2. Add it as a `.test.mjs` file under `tests/plugins/output-styles/`
3. Run with `npm test`

> Use `.test.mjs`, not `.test.mts`. The root `npm test` globs `tests/**/*.test.mjs`, so a
> `.mts` file is never picked up and the tests silently never run.

**Record results in:** [test-results.md](test-results.md)
