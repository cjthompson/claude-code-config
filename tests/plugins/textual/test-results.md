# textual Test Results

Tracks test execution history for the textual plugin.
For test scenarios, see:
- [test-textual-css-reference.md](test-textual-css-reference.md)
- [test-textual-api-reference.md](test-textual-api-reference.md)

## Execution Log

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-06-12 | CSS display property — only two valid values | Baseline: PASS / GREEN: PASS | ⚠️ Baseline passed — not a discriminating scenario for Sonnet 4.6. |
| 2026-06-13 | CSS grid layout — correct property names | Baseline: PARTIAL / GREEN: FAIL | ⚠️ Two test design bugs found and fixed: MUST #3 (grid-rows) not triggered by column-only prompt; MUST NOT too strict (flagged mentions of wrong property even when labelled as invalid). Scenario updated; re-run needed. |
| 2026-06-13 | Progressive Step 1 — App shell | Baseline: CSS ✅ / Code ✅ | PASS |
| 2026-06-13 | Progressive Step 1 — App shell | GREEN: CSS ✅ / Code ❌ | FAIL — GREEN used `Header(show_clock=True)` (attribute doesn't exist). Baseline wrote `Header()` correctly. Skill updated with explicit warning. |
| 2026-06-13 | Progressive Step 2 — Two-column grid | Baseline: CSS ✅ / Code ✅ | PASS — used `layout: horizontal` + `1fr`/`2fr`, no CSS3 |
| 2026-06-13 | Progressive Step 2 — Two-column grid | GREEN: CSS ✅ / Code ✅ | PASS |
| 2026-06-13 | Progressive Step 3 — Input + Button row | Baseline: CSS ✅ / Code ⚠️ | PARTIAL — used Horizontal() container but no `layout: horizontal` in CSS; `height: auto` not `height: 1` |
| 2026-06-13 | Progressive Step 3 — Input + Button row | GREEN: CSS ✅ / Code ✅ | PASS — explicit `layout: horizontal` in CSS, `height: 1`, `value = ""` to clear (skill guidance followed) |
| 2026-06-13 | Progressive Step 4 — DataTable in sidebar | Baseline: CSS ✅ / Code ✅ | PASS — correct cursor_type="row", zebra_stripes, add_columns/add_rows |
| 2026-06-13 | Progressive Step 4 — DataTable in sidebar | GREEN: CSS ✅ / Code ✅ | PASS — used individual add_column with explicit keys |
| 2026-06-13 | Progressive Step 5 — RichLog message area | Baseline: CSS ✅ / Code ✅ | PASS — RichLog, markup=True, auto_scroll=True, Input.Submitted handled |
| 2026-06-13 | Progressive Step 5 — RichLog message area | GREEN: CSS ✅ / Code ✅ | PASS — identical approach, TIE |
| 2026-06-13 | Progressive Step 6 — CSS styling | Baseline: CSS ✅ / Runtime ✅ | PASS — used Header { height: 2; } in CSS, text-style: bold, border: round |
| 2026-06-13 | Progressive Step 6 — CSS styling | GREEN: CSS ✅ / Runtime ❌ | FAIL — skill said tall=True works in Header constructor; actual error: TypeError unexpected keyword argument. Baseline's CSS approach worked. Skill corrected. |
