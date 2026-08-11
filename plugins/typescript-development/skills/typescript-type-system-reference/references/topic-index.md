# TypeScript Reference Topic Index

All paths are relative to `vendor/typescript-website/`.

| Question | Read first | Add when needed |
|---|---|---|
| Everyday types, unions, literals, nullability | `handbook-v2/Everyday Types.md` | `handbook-v2/Narrowing.md`, `tsconfig/strictNullChecks.md` |
| Objects, excess properties, readonly, arrays, tuples | `handbook-v2/Object Types.md` | `handbook-v2/Type Manipulation/Indexed Access Types.md`, `tsconfig/noUncheckedIndexedAccess.md` |
| Functions, overloads, callbacks, variance | `handbook-v2/More on Functions.md` | `tsconfig/strictFunctionTypes.md`, `handbook-v2/Type Manipulation/Generics.md` |
| Classes and visibility | `handbook-v2/Classes.md` | `tsconfig/noImplicitOverride.md` |
| Control-flow narrowing and predicates | `handbook-v2/Narrowing.md` | `handbook-v2/Type Manipulation/Conditional Types.md` |
| Generics and constraints | `handbook-v2/Type Manipulation/Generics.md` | `handbook-v2/Type Manipulation/Keyof Type Operator.md`, `handbook-v2/Type Manipulation/Indexed Access Types.md` |
| Conditional and distributive types | `handbook-v2/Type Manipulation/Conditional Types.md` | `handbook-v2/Type Manipulation/_Creating Types from Types.md` |
| Mapped and template-literal types | `handbook-v2/Type Manipulation/Mapped Types.md` | `handbook-v2/Type Manipulation/Template Literal Types.md`, `handbook-v2/Type Manipulation/Keyof Type Operator.md` |
| `keyof`, indexed access, and `typeof` | matching file under `handbook-v2/Type Manipulation/` | `handbook-v2/Type Manipulation/_Creating Types from Types.md` |
| Modules and declaration lookup | `modules-reference/Reference.md` | `modules-reference/Theory.md`, `handbook-v2/Type Declarations.md` |
| ESM/CJS interoperability | `modules-reference/appendices/ESM-CJS-Interop.md` | `modules-reference/guides/Choosing Compiler Options.md`, `tsconfig/esModuleInterop.md` |
| Authoring or publishing declarations | `declaration-files/Library Structures.md` | `declaration-files/Publishing.md`, `declaration-files/Do's and Don'ts.md` |
| Compiler-option semantics | matching file under `tsconfig/` | `modules-reference/guides/Choosing Compiler Options.md` for module settings |
| Compiler errors | `handbook-v2/Understanding Errors.md` | the topic file for the construct involved |

When behavior may have changed after the pinned commit, consult current official release notes and verify with the project's installed compiler.
