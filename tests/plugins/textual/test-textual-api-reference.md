# Test: Textual API — Button Widget Attributes and Message

## Prompt
"What reactive attributes does the Textual `Button` widget have, and what message does it emit when clicked?"

## MUST Contain
- `label` as a reactive attribute (str, default `""`)
- `variant` as a reactive attribute with the five valid values: `"default"`, `"primary"`, `"success"`, `"warning"`, `"error"`
- `disabled` as a reactive attribute (bool, default `False`)
- `Button.Pressed` as the emitted message
- That `Button.Pressed` has a `.button` attribute

## MUST NOT Contain
- `Button.Clicked` as the emitted message (wrong name)
- `text` as a reactive attribute (the correct name is `label`)

---

# Test: Textual API — DataTable Read-Only Properties and Methods

## Prompt
"What are the read-only properties of `DataTable`, and how do I add columns and rows to it?"

## MUST Contain
- Read-only properties: `cursor_row`, `cursor_column`, `row_count`, `rows`, `columns`
- `add_column(label, width=None, key=None)` method signature
- `add_row(*cells, key=None, label=None)` method signature

## MUST NOT Contain
- Suggestions to directly assign to `rows` or `columns` (they are read-only)
- `append_row()` as a method name (correct name is `add_row`)

---

# Test: Textual API — Input Widget Messages and Read-Only State

## Prompt
"What messages does the Textual `Input` widget emit, and what read-only properties does it expose?"

## MUST Contain
- `Input.Changed` with `.value` attribute
- `Input.Submitted` with `.value` attribute
- Read-only properties including: `is_valid`, `selected_text`, `cursor_at_start`, `cursor_at_end`
- `password` attribute (bool) for masking input

## MUST NOT Contain
- `Input.KeyPressed` as a message
- Any suggestion that `is_valid` is writable/settable

---

# Test: Textual API — Tree Widget Node Operations and Messages

## Prompt
"How do I add nodes to a Textual `Tree` widget, and what messages does it emit when a node is selected?"

## MUST Contain
- `node.add(label, data=None)` for adding child nodes
- `node.add_leaf(label, data=None)` for adding leaf nodes
- `tree.root` as the entry point to the root `TreeNode`
- `Tree.NodeSelected` as the message emitted on selection
- That `.node.data` holds the data attached to the selected node

## MUST NOT Contain
- `Tree.add_node()` as a direct method on the tree object (nodes are added via `tree.root.add()`)
- Any suggestion that `Tree.NodeSelected` has a `.value` attribute (correct attribute is `.node`)
