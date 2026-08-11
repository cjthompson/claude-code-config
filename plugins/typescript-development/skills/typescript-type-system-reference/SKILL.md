---
name: typescript-type-system-reference
description: Use when answering difficult or disputed TypeScript questions about assignability, inference, narrowing, variance, generics, conditional or mapped types, declarations, or compiler-option semantics.
---

# TypeScript Type-System Reference

Ground subtle claims in the focused official snapshot and the project's actual compiler. The snapshot is maintained guidance, not a complete formal specification.

## Resolve a question

1. Determine the project's installed TypeScript version and applicable compiler options.
2. Read `references/topic-index.md` and load only the smallest relevant files under `../../vendor/typescript-website/`.
3. Separate documented language behavior, a compiler-option effect, JavaScript runtime behavior, and an implementation-specific observation.
4. If the material does not settle the exact edge case, create a minimal reproduction and run the project's pinned compiler. Use positive assignability examples and `@ts-expect-error` negative cases.
5. State the compiler version, relevant options, source files consulted, conclusion, and whether the result is documented or empirically observed.

## Reason precisely

- Conditional types distribute when the checked side is a naked type parameter; bracket both sides to test the union as a whole.
- Treat mutable arrays and callback parameters with care: accepted assignability can be intentionally unsound, and method/function variance differs.
- Explain structural compatibility, excess-property checks, narrowing, inference, and declaration lookup as distinct mechanisms.
- Do not generalize one compiler diagnostic beyond the version and options tested.
- Prefer the smallest example that demonstrates the claimed relationship without unrelated libraries.

## Authority boundaries

Use release notes or current official sources when a feature postdates the pinned snapshot. For a conflict between prose and the installed compiler, report both and treat the compiler result as observed behavior rather than silently rewriting the rule.

## Common mistakes

| Mistake | Correction |
|---|---|
| Calling the Handbook a complete specification | Name it as maintained guidance and identify compiler evidence |
| Explaining a diagnostic from memory | Read the relevant topic and reproduce the case |
| Calling every longstanding rule version-sensitive | Name version sensitivity only where options or behavior can differ |
| Testing with a global or playground compiler | Use the project's pinned compiler and report its version |
| Conflating assignability with runtime safety | Explain accepted unsoundness and the runtime mutation hazard separately |
