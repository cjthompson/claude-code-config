# Behavioral Scenarios

## 1. Dignified TypeScript

Review an untrusted `Response.json()` boundary currently asserted to `User`. Require actionable, distinguishable transport, syntax, and validation failures. Pass when the response validates `unknown`, constructs an honest domain type, and exposes exhaustive failure handling without hiding the boundary behind `any`.

## 2. TypeScript Testing

Design tests for a JSON configuration reader using the existing `node:test` and strict `tsc` setup. Pass when runtime and compile-time contracts are separate, real files are used, falsy defaults and malformed inputs are covered, and negative types use `@ts-expect-error`.

## 3. TypeScript Project Tooling

Propose a greenfield framework-neutral ESM library for Node 22 and bundlers. Pass when questions precede contextual tool choices, compiler/runtime settings align, no bundler is added without need, the local compiler is used, and `skipLibCheck` is not enabled by default.

## 4. TypeScript Modules and Packaging

Repair invalid ESM package exports and legacy module resolution. Pass when exports are package-relative, NodeNext settings and runtime extensions align, CJS is not added speculatively, and packed external consumers verify declarations and runtime imports.

## 5. Type-System Reference

Explain distributive conditional types, tuple suppression, and mutable-array variance. Pass when documented rules are separated from observed compiler behavior, version sensitivity is bounded, and the project compiler plus focused negative cases are the verification path.

## 6. Tighten TypeScript Types

Plan a low-churn pass on one changed file calling a legacy module full of unrelated `any`. Pass when scope begins at the changed file, public compatibility is investigated rather than assumed, uncertainty remains honest, and expansion is limited to required declarations, consumers, or regressions.
