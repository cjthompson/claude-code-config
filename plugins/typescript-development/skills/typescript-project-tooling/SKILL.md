---
name: typescript-project-tooling
description: Use when configuring or maintaining a TypeScript repository, package manager, tsconfig files, linting, formatting, testing, builds, workspaces, CI, or publishing automation.
---

# TypeScript Project Tooling

Make the repository's runtime and distribution contract drive its tools. Existing projects keep their established commands unless the user requests a migration.

## Inspect before recommending

Read `package.json`, the lockfile and package-manager declaration, all relevant `tsconfig` inheritance, formatter/linter/test/build configuration, workspace files, CI, and contributor documentation. Determine:

- application or library;
- Node, browser, worker, edge, Bun, Deno, or mixed runtime;
- emitted, bundled, or typecheck-only TypeScript;
- supported runtime and TypeScript versions;
- ESM/CJS and publication requirements.

For explicitly named files, use configured commands scoped to those files when supported. If no configured tool covers a requested check, report the gap instead of adding a tool silently.

## Greenfield decisions

Ask about runtime, consumers, publishing, monorepo needs, and organization standards before selecting a package manager or build stack. Then choose the smallest stack that satisfies those answers:

- install TypeScript locally and run the pinned compiler through package scripts;
- enable `strict`; add stricter flags only when their semantics match the project;
- use `tsc` directly when its emit is the desired artifact and add a bundler only for an actual bundling requirement;
- choose formatter, linter, test runner, and package manager contextually rather than naming universal defaults;
- separate type checking from transpilation when another tool emits JavaScript.

Do not enable `skipLibCheck` as a generic default. Use it only for a measured compatibility or performance constraint, record what declaration problem it masks, and retain a path to remove it.

## Configuration rules

- Derive `target` and `lib` from runtime support, not from the newest syntax available.
- Pair `module` and `moduleResolution` according to the actual runtime/build pipeline.
- Keep editor, CI, build, test, and published declaration configurations aligned through explicit `extends` relationships where useful.
- Avoid path aliases that the runtime or bundler cannot resolve.
- For project references, keep package boundaries and emitted declarations consistent with dependency direction.
- Commit the repository's chosen lockfile and make CI use its frozen/install-exact mode.

## Change safely

Separate tool migrations from feature changes. Review automatic rewrites, generated output, lockfile changes, and package contents. Verify install, format check, lint, typecheck, runtime tests, build, packed artifact, and consumer compilation as applicable.

## Common mistakes

| Mistake | Correction |
|---|---|
| Replacing configured tools with a preferred stack | Continue using the repository's working commands |
| Copying one universal `tsconfig` | Derive settings from runtime, emit, and consumer requirements |
| Enabling `skipLibCheck` preemptively | Diagnose declarations first; document any bounded exception |
| Adding a bundler to every library | Use `tsc` when preserved modules are the intended artifact |
| Running a global compiler | Use the repository-pinned TypeScript version |
