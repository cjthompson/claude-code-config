# Test: Button — reactive attributes and message

## Prompt
"What reactive attributes does the Textual `Button` widget have, and what message does it emit when clicked?"

## MUST Contain
- `label` as a reactive attribute with type `ContentText|None` and default `None`
- `variant` with the five valid values: `"default"`, `"primary"`, `"success"`, `"warning"`, `"error"`
- `disabled` as a reactive attribute (bool, default `False`)
- `compact` and `flat` as reactive attributes (bool, default `False`)
- `Button.Pressed` as the emitted message with a `.button` attribute

## MUST NOT Contain
- `label` default listed as `""` (empty string) — the actual default is `None`
- `Button.Clicked` as the message name (wrong — it is `Button.Pressed`)
- `text` as a reactive attribute name (the correct name is `label`)

---

# Test: Input — messages and read-only state

## Prompt
"What messages does the Textual `Input` widget emit, and what read-only properties does it expose?"

## MUST Contain
- `Input.Changed` with `.value` attribute
- `Input.Submitted` with `.value` attribute
- `Input.Blurred` as a third message (carries `.value` and `.validation_result`)
- Read-only properties: `is_valid`, `selected_text`, `selection`, `cursor_at_start`, `cursor_at_end`

## MUST NOT Contain
- `Input.KeyPressed` as a message name
- Any suggestion that `is_valid` is writable or settable
- Only two messages listed (the skill documents three)

---

# Test: Select — sentinel value and available messages

## Prompt
"What is the default value of `Select.value` when nothing is selected, and what messages does `Select` emit?"

## MUST Contain
- `Select.NULL` as the sentinel constant for no selection
- `value` reactive attribute type `SelectType|NoSelection`
- `Select.Changed` as the message, with `.value` and `.select` attributes
- `selection` read-only property that returns current value or `None` (never the NULL sentinel)

## MUST NOT Contain
- `Select.BLANK` as the sentinel constant (wrong — the correct constant is `Select.NULL`)
- `Select.SelectionChanged` as a message (this message does not exist)

---

# Test: ContentSwitcher — messages and active widget access

## Prompt
"Does `ContentSwitcher` emit a message when the visible widget changes? How do I get a reference to the currently visible widget?"

## MUST Contain
- `visible_content` as the read-only property that returns the currently visible widget or `None`
- `current` reactive attribute (`str|None`) as the way to switch between widgets by ID
- `add_content(widget, *, id=None, set_current=False)` as a method for adding children

## MUST NOT Contain
- `ContentSwitcher.Changed` as a message (this message does not exist in Textual)
- Any claim that ContentSwitcher posts messages when the active pane changes

---

# Test: Footer — reactive attributes

## Prompt
"What reactive attributes does the Textual `Footer` widget have?"

## MUST Contain
- `combine_groups` (bool, default `True`) — merges adjacent key groups
- `compact` (bool, default `False`) — compact display mode
- `show_command_palette` (bool, default `True`) — shows command palette hint

## MUST NOT Contain
- Any claim that Footer has no reactive attributes
- Any claim that Footer automatically discovers everything and has nothing configurable

---

# Test: Toast — correct creation pattern

## Prompt
"How do I show a Toast notification in Textual? What severity levels are available?"

## MUST Contain
- `app.notify(message, severity="information", timeout=10)` as the creation pattern
- Severity values: `"information"`, `"warning"`, `"error"`
- That Toast is NOT mounted directly — it is created via `app.notify()`
- Default timeout of `10` seconds

## MUST NOT Contain
- Mounting Toast directly (e.g. `self.mount(Toast(...))`)
- A timeout default of `3` or `3.0` seconds (the actual default is `10`)

---

# Test: DataTable — read-only properties and adding data

## Prompt
"What are the read-only properties of `DataTable`, and how do I add columns and rows to it?"

## MUST Contain
- Read-only properties: `cursor_row`, `cursor_column`, `row_count`, `rows`, `columns`
- `add_column(label, *, width=None, key=None)` method signature
- `add_row(*cells, *, key=None, label=None)` method signature
- At minimum `DataTable.CellSelected` and `DataTable.RowSelected` as messages

## MUST NOT Contain
- Suggestions to directly assign to `rows` or `columns` (they are read-only)
- `append_row()` as a method name (correct name is `add_row`)

---

# Test: Tree — node operations and selection message

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
