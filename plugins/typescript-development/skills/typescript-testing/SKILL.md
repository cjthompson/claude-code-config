---
name: typescript-testing
description: Use when designing or implementing tests for TypeScript behavior, public types, compiler failures, filesystem or process boundaries, or package-consumer compatibility.
---

# TypeScript Testing

Test runtime behavior and compile-time contracts separately, using the repository's established runner and compiler commands.

## Establish the test surfaces

Read the test configuration, `tsconfig` files, package scripts, CI, and nearby tests. Keep the configured runner, assertion library, coverage tool, DOM/browser environment, and compiler version unless the user asks for a migration.

| Surface | Verify with |
|---|---|
| Pure decisions and transformations | Focused runtime unit tests through public behavior |
| Filesystem, process, network, database, worker, or browser seams | The smallest realistic integration boundary |
| Exported type narrowing and inference | A compiled consumer fixture or type-test file |
| Invalid types that must stay rejected | `@ts-expect-error` whose unused directive fails compilation |
| Published package behavior | A packed external consumer, not source-path imports |

## Build meaningful cases

- Add a regression that demonstrates a reported bug before changing production code.
- Cover success, empty and boundary values, malformed runtime input, and each expected failure variant.
- For discriminated unions, compile narrowing and exhaustiveness examples as consumers use them.
- Assert defaults do not overwrite valid falsy values such as `false`, `0`, or an empty string.
- Use temporary directories and real files for file behavior. Mock only slow or nondeterministic boundaries, not the unit under test.
- Avoid snapshots of incidental formatting, internal call order, emitted diagnostics, or whole platform error messages.

## Test types honestly

- Compile positive examples that must type-check and negative examples marked with `@ts-expect-error`.
- Prefer assignability checks and real API calls over opaque type-equality tricks. Use equality helpers only when exact identity is the public contract.
- Keep runtime assertions out of compile-only fixtures and do not claim a type test verifies runtime validation.
- When exported types or declarations change, compile a separate consumer configuration using the supported module resolution mode.

## Verify

Run the narrowest affected runtime and compiler tests first, then the repository's full required checks. Report the exact commands and distinguish runtime-test, type-test, and package-consumer failures.

## Common mistakes

| Mistake | Correction |
|---|---|
| Testing only runtime behavior | Compile the public narrowing and invalid-use contracts too |
| Using `as` to make a fixture compile | Construct input through the real public boundary |
| Treating `@ts-ignore` as a negative test | Use `@ts-expect-error` so disappearance of the error fails |
| Importing package source in a consumer test | Pack/install the artifact and resolve its public exports |
