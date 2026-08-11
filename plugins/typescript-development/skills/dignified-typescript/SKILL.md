---
name: dignified-typescript
description: Use when implementing or reviewing substantial TypeScript, designing public APIs, modeling domain state, validating runtime data, or refactoring project-scale TypeScript code.
---

# Dignified TypeScript

Build on JavaScript runtime truth and use types to make valid states and supported operations clear. Preserve an existing repository's conventions unless the user requests a migration.

## Establish the target

1. Read repository instructions, `package.json`, lockfiles, `tsconfig` files, build configuration, CI, and public package metadata.
2. Determine the installed TypeScript version, runtime targets, module system, deployment environments, and whether the code is an application or published library.
3. If those targets are missing and affect the design, ask before choosing them. Do not silently impose the current repository's targets on another project.

## Design from runtime boundaries

- Treat JSON, environment variables, storage, network responses, messages, and third-party callbacks as `unknown` until validated.
- Model domain state with discriminated unions and exhaustive handling. Do not use optional fields to merge states with different invariants.
- Prefer inference inside cohesive functions and precise annotations at exported, callback, serialization, and dependency boundaries.
- Make dependencies and effects explicit. Keep modules cohesive and avoid ambient mutable state, import-time work, and hidden singleton coupling.
- Distinguish operational failures callers can handle from programmer errors. Preserve causes and add actionable context at the boundary that understands the operation.
- Use `readonly` for genuinely read-only views, not as decoration. Remember that TypeScript's structural types do not enforce runtime immutability.

## Keep types honest

- Prefer `unknown` plus validation to `any`, assertions, non-null assertions, and blanket suppressions.
- Use `satisfies` when checking a value without widening away useful inference.
- Add generics, overloads, conditional types, or branded types only when they express a consumer-visible relationship that simpler types cannot.
- Do not confuse successful type checking with runtime validation, package compatibility, or test coverage.
- Verify version-sensitive behavior with the project's installed compiler and a minimal reproduction.

## Work narrowly and verify

Follow the repository's configured format, lint, typecheck, test, and build commands. Test runtime behavior at realistic boundaries and compile public consumers when exported types change. Avoid unrelated tool migrations or cleanup.

Use `typescript-development:typescript-testing` for test design, `typescript-development:typescript-project-tooling` for repository configuration, `typescript-development:typescript-modules-packaging` for resolution or publishing, and the reference or tightening skills for focused type-system work.

## Common mistakes

| Mistake | Correction |
|---|---|
| Casting decoded JSON to a domain type | Decode to `unknown`, validate, then construct the type |
| Encoding states with many optional fields | Use a discriminated union with exhaustive handling |
| Exporting clever type machinery | Export the smallest stable relationship consumers need |
| Fixing an error with `any` or `skipLibCheck` | Find the boundary or incompatible declaration causing it |
| Assuming types change runtime behavior | Verify emitted JavaScript and runtime inputs separately |
