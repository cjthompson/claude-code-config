# Test: Validate untyped JSON at the boundary

## Prompt
"Write a type-safe Python 3.14 script that reads JSON objects from stdin. Each object contains a string name and an optional integer count. Reject malformed records and print valid records. Avoid runtime dependencies."

## MUST Contain
- Treat `json.loads()` output as `object`, not `Any`
- Explicit `isinstance` validation before constructing a typed value
- A `TypedDict` or frozen dataclass for validated records
- Reject `bool` as an integer count
- Complete function return annotations

## MUST NOT Contain
- `Any` as the parsed JSON type
- Pydantic or another runtime dependency
- `cast()` or `# type: ignore` used instead of validation
