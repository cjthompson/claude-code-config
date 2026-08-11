---
name: typescript-modules-packaging
description: Use when TypeScript imports, ESM or CommonJS, module resolution, package exports, declaration emit, subpaths, project references, or published consumer compatibility are involved.
---

# TypeScript Modules and Packaging

Align three contracts: the runtime loader, TypeScript's resolver and declarations, and the package's public exports. A build is not valid until supported consumers resolve all three.

## Identify the contract

Read `package.json`, every build/typecheck `tsconfig`, source extensions and import specifiers, bundler configuration, supported runtimes, and publication scripts. Determine whether the artifact is an application, an internal workspace package, or a published library and whether ESM, CommonJS, or both are explicitly required.

## Choose matching resolution

| Deployment | Typical compiler pairing |
|---|---|
| Modern Node package or application | `module` and `moduleResolution` set to the supported Node mode such as `NodeNext` |
| Bundler-owned application | `module: ESNext` with `moduleResolution: bundler` when the bundler contract supports it |
| Legacy CommonJS | A deliberate CommonJS configuration matching the runtime |

Do not mix an emit strategy and resolver that model different loaders. Under Node ESM, use runtime-valid relative extensions. Treat `paths` as compiler lookup guidance, not a runtime rewrite.

## Publish one explicit surface

- Start with one ESM artifact unless `require()` consumers are a stated requirement.
- Define `exports` targets with `./` paths. Put `types` before runtime conditions for each public entry.
- Export only intended roots and subpaths; verify forbidden deep imports stay unavailable.
- Emit declarations from the public source graph and ensure every referenced declaration ships.
- Add CJS only as a distinct output with conditional exports and test it independently. Do not point `import` and `require` at one ambiguous file.
- Use project references only when package/build boundaries and dependency direction benefit from separate outputs.

## Verify the artifact, not the source tree

1. Build and inspect emitted JavaScript, declarations, maps, and package metadata.
2. Create the actual package archive using the repository's publish command or package-manager pack command.
3. Install that archive into isolated consumer fixtures using every supported resolver/runtime.
4. Compile public imports and intended subpaths; include negative deep-import cases when encapsulation matters.
5. Execute supported runtime imports. Test bundler consumption when it is a promised target.

Run `--traceResolution` only for a focused failing import and interpret it using the project's installed compiler version.

## Common mistakes

| Mistake | Correction |
|---|---|
| `exports` target lacks `./` | Use a package-relative target such as `./dist/index.js` |
| `moduleResolution: node` for Node ESM | Use the Node mode matching the supported runtime |
| Adding dual ESM/CJS by reflex | Publish one ESM build unless `require()` is required |
| Testing repository source imports | Pack and install the artifact in external consumers |
| Publishing `.d.ts` without its graph | Inspect and compile the packed declarations |
