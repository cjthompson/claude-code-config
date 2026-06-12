# output-styles Tests

Tests for the `output-styles` package.

## Overview

No automated tests exist yet. Output styles are static Markdown files with YAML frontmatter.

**Source:** `packages/output-styles/`

## Test Files

None yet.

## Suggested Test Approach

Since output styles are declarative Markdown, testing could cover:

1. **Frontmatter validation** — Verify each style file has valid YAML with required fields
   (`name`, `description`) and is listed in `manifest.json`

2. **Functional test** — Load the style in Claude Code and verify the behavioral change
   matches the style's description

A lightweight linter script checking frontmatter completeness would be a good first test.

## How to Add Tests

1. Create a Node.js script to parse and validate all style files
2. Add it as a `.test.mts` file in `packages/output-styles/`
3. Run with: `node --experimental-strip-types --test packages/output-styles/<test>.test.mts`

**Record results in:** [test-results.md](test-results.md)
