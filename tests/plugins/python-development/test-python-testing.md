# Test: JSONL parser test strategy

## Prompt

"We have a JSONL parser that validates and normalizes records. Design its test strategy, including malformed input, integration boundaries, and useful invariants. Tell me what not to mock."

## MUST Contain

- Clear unit and integration boundaries
- Malformed and boundary cases with observable assertions
- Real temporary-filesystem coverage
- Appropriate invariant/property testing and explicit mocking advice
