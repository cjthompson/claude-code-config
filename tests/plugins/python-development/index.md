# python-development Tests

Behavioral tests for the deep Python development plugin. Run each prompt without the skill for a baseline and with the named skill for GREEN. Use `gpt-5.6-luna` as an independent checklist judge and record results in `test-results.md`.

Structural and vendor validation:

```bash
python3 tests/plugins/python/test_python_plugins.py -v
node --test tests/plugins/python-development/sync-typing-references.test.mjs
node plugins/python-development/scripts/sync-typing-references.mjs --check
```
