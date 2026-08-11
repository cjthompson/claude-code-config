---
name: tighten-typescript-types
description: Use when tightening annotations in existing TypeScript, removing avoidable any or assertions, improving changed-file types, or reducing compiler errors without broad refactoring.
---

# Tighten TypeScript Types

Improve the smallest changed surface while preserving runtime behavior and supported consumers. Types must describe evidence, not hide uncertainty.

## Set the boundary

1. Read repository instructions, the installed compiler version, applicable `tsconfig`, configured checks, and the task diff.
2. Use user-named files when supplied; otherwise start with changed TypeScript files.
3. Trace only the imported/exported interfaces needed to understand those files. Do not survey the whole repository by default.
4. Record public declarations, runtime behavior, and consumer compatibility that must remain stable.

## Tighten in evidence order

- Replace boundary `any` with `unknown`, then validate or narrow before use.
- Let inference handle honest local values; annotate exported, recursive, overloaded, callback, and serialization boundaries where it improves the contract.
- Make container elements, keys, return values, optionality, and discriminants precise.
- Prefer control-flow narrowing, predicates that perform real runtime checks, discriminated unions, and small typed adapters over assertions.
- Use `satisfies` to check values without discarding useful inference.
- Use an assertion only when a runtime fact is established outside TypeScript's model; keep it at that boundary and explain the fact.
- Never invent precision for dynamic legacy data. Keep uncertainty visible until validation.

Public compatibility does not require preserving `any` automatically. A narrower, truthful declaration may be acceptable only after compiling supported consumers and confirming the intended API contract; otherwise tighten behind the existing boundary.

## Expand scope only when required

Expand beyond the selected files only for a directly used declaration that prevents an honest local type, a necessary consumer fixture, or a focused regression test. Do not clean unrelated `any`, assertions, ignores, formatting, or legacy modules. Report pre-existing external errors separately.

## Verify

Run the configured focused typecheck and tests, then required repository checks. When exported types change, emit declarations if applicable and compile a supported external consumer. Review the diff for runtime changes, public API drift, formatting churn, new suppressions, and assertions.

## Common mistakes

| Mistake | Correction |
|---|---|
| Replacing `any` with an asserted domain type | Use `unknown` and validate at the boundary |
| Freezing a public `any` without examining consumers | Test whether a truthful type is compatible |
| Fixing every nearby legacy error | Limit edits to necessary interfaces and report the rest |
| Adding generic machinery for local inference | Prefer the compiler's existing inference |
| Using `@ts-ignore` to finish the pass | Resolve the cause or leave the uncertainty explicit |
