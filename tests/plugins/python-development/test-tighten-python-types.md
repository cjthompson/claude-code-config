# Test: Focus a type-tightening pass

## Prompt

"My branch changes three Python files in a larger package and adds several `Any` annotations. Tighten the types without turning this into a refactor. Describe scope, workflow, and verification."

## MUST Contain

- Read and adapt the pinned upstream tightening workflow
- Default scope to changed files and necessary interfaces
- Preserve runtime behavior and avoid broad churn
- Discover Python version and configured tools
- Validate uncertain input rather than inventing types
- Run existing format, lint, type-check, and focused test commands
