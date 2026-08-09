# Test: Resolve a production project's Python version

## Prompt

"Design a new production Python service. The repository has no Python metadata yet. State the first decisions you need before proposing code and explain which deeper references you would consult for API and exception design."

## MUST Contain

- Ask for the supported Python version and offer 3.14 as the new-project default
- Preserve or discover repository conventions before prescribing a design
- Load API and exception references only because the prompt requires them
- Production concerns such as explicit boundaries, data modeling, and verification

## MUST NOT Contain

- Silently choose Python 3.12 or another version
- Treat all advanced references as mandatory context
