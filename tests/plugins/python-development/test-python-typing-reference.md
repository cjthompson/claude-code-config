# Test: Generic variance

## Prompt

"Why is `list[int]` not assignable to `list[object]`, while `Sequence[int]` is assignable to `Sequence[object]`? What should an API accept if it only reads?"

## MUST Contain

- Consult and name the relevant vendored specification files
- Explain invariance, covariance, and the mutation safety rationale
- Recommend a read-only covariant boundary
- Distinguish normative rules from checker-specific behavior
