---
name: textual-api-reference
description: Use when working with Textual TUI widgets — looking up available components, reactive attributes, constructor parameters, or messages emitted
---

# Textual Widget API Reference

## Overview
Complete reference for Textual's built-in widgets. Reactive attributes use `reactive()` and trigger re-renders on change.

**Import path:** `from textual.widgets import Button, Input, DataTable, ...`

---

## Shared Attributes

These appear on multiple widgets; individual entries reference them rather than repeating the full definition.

| Attribute | Type | Default | Widgets |
|-----------|------|---------|---------|
| `compact` | `bool` | `False` | Button, Footer, MaskedInput, OptionList, RadioSet, Select |
| `cursor_blink` | `bool` | `True` | Input, TextArea |
| `auto_scroll` | `bool` | `True` | Log, RichLog |
| `disabled` | `bool` | `False` | All focusable widgets (base Widget attribute) |

**ToggleButton base** — Checkbox, RadioButton, and Switch all extend `ToggleButton` and share `value` (bool, False) as a reactive attribute.

**Message convention** — Every message has a `.control` attribute pointing to the posting widget. Many also carry a widget-named alias (`.button` on `Button.Pressed`, `.checkbox` on `Checkbox.Changed`, etc.).

---

## Form Controls

### Button
Clickable action trigger.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `label` | `ContentText\|None` | `None` | Button text |
| `variant` | `str` | `"default"` | `"default"`, `"primary"`, `"success"`, `"warning"`, `"error"` |
| `disabled` | `bool` | `False` | → see Shared |
| `compact` | `bool` | `False` | → see Shared |
| `flat` | `bool` | `False` | Removes border |
| `active_effect_duration` | `float` | `0.2` | Click animation duration |

**Constructor extras:** `action` (str), `tooltip` (str)

**Messages:** `Button.Pressed` (`.button`)

---

### Checkbox
Boolean toggle; extends `ToggleButton`.

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `bool` | `False` |

**Constructor:** `label` (str, positional — the checkbox text)

**Messages:** `Checkbox.Changed` (`.value`, `.checkbox`)

---

### Input
Single-line text entry with optional validation.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `value` | `str` | `""` | Current text |
| `placeholder` | `str` | `""` | Hint text when empty |
| `password` | `bool` | `False` | Mask characters |
| `restrict` | `str` | `None` | Regex limiting input |
| `type` | `str` | `"text"` | `"text"`, `"integer"`, `"number"` |
| `max_length` | `int\|None` | `None` | Character limit |
| `valid_empty` | `bool` | `False` | Allow empty as valid |
| `cursor_position` | `int` | `0` | Cursor index |
| `cursor_blink` | `bool` | `True` | → see Shared |

**Read-only:** `is_valid`, `selected_text`, `selection` (Selection), `cursor_at_start`, `cursor_at_end`

**Messages:** `Input.Changed` (`.value`), `Input.Submitted` (`.value`), `Input.Blurred` (`.value`, `.validation_result`)

---

### MaskedInput
Text input with a formatting mask (e.g. dates, phone numbers).

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `value` | `str\|None` | `None` | Current text |
| `template` | `str` | *required* | Mask pattern |
| `placeholder` | `str` | `""` | Hint text when empty |
| `compact` | `bool` | `False` | → see Shared |

**Messages:** `MaskedInput.Changed` (`.value`), `MaskedInput.Submitted` (`.value`)

---

### RadioButton
Standalone radio option; extends `ToggleButton`. Usually used inside `RadioSet`.

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `bool` | `False` |

**Messages:** `RadioButton.Changed` (`.radio_button`, `.value`)

---

### RadioSet
Group of `RadioButton` widgets enforcing single selection.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `pressed_index` | `int` | `-1` | Index of selected button; `-1` = none selected |
| `compact` | `bool` | `False` | → see Shared |

**Read-only:** `pressed_button` — the active `RadioButton` or `None`

**Messages:** `RadioSet.Changed` (`.index`, `.pressed`, `.radio_set`)

---

### Select
Dropdown with a single selected value.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `value` | `SelectType\|NoSelection` | `Select.NULL` | `Select.NULL` when nothing selected |
| `prompt` | `str` | `"Select"` | Placeholder text |
| `expanded` | `bool` | `False` | Dropdown open/closed |
| `compact` | `bool` | `False` | → see Shared |

**Read-only:** `selection` — current value or `None` (never returns `Select.NULL`)

**Methods:** `is_blank()`, `clear()` (requires `allow_blank=True`), `set_options(options)`

**Messages:** `Select.Changed` (`.value`, `.select`)

---

### Switch
Toggle switch (binary on/off, visually distinct from Checkbox). Extends `ToggleButton`.

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `bool` | `False` |
| `animate` | `bool` | `True` |

**Messages:** `Switch.Changed` (`.value`)

---

## Display

### Label
Simple text display. Not focusable. No reactive attributes; inherits from `Static` — use `update()` to change content.

---

### Link
Clickable hyperlink.

| Attribute | Type | Default |
|-----------|------|---------|
| `text` | `str` | `""` |
| `url` | `str` | `""` |

---

### Placeholder
Empty space — useful during layout development.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `variant` | `str` | `"default"` | `"default"`, `"size"`, `"text"` |

**Method:** `cycle_variant()` — advance to next variant

---

### Rule
Horizontal or vertical separator line.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `orientation` | `str` | `"horizontal"` | `"horizontal"` or `"vertical"` |
| `line_style` | `str` | `"solid"` | `"ascii"`, `"blank"`, `"dashed"`, `"double"`, `"heavy"`, `"hidden"`, `"none"`, `"solid"`, `"thick"` |

---

### Static
General-purpose container for Rich renderables.

| Attribute | Type | Default |
|-----------|------|---------|
| `content` | `VisualType` | `""` |

**Read-only:** `visual` — what actually renders (may differ from `content`)

**Constructor:** `content`, `expand` (bool), `shrink` (bool), `markup` (bool, default `True`)

**Method:** `update(content, *, layout=True)` — update rendered content

---

## Complex Containers

### DataTable
Grid with rows/columns, keyboard navigation, and cursor selection.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `show_header` | `bool` | `True` | Toggle header row |
| `show_row_labels` | `bool` | `True` | Toggle row labels |
| `fixed_rows` | `int` | `0` | Non-scrolling rows at top |
| `fixed_columns` | `int` | `0` | Non-scrolling columns at left |
| `zebra_stripes` | `bool` | `False` | Alternating row colors |
| `header_height` | `int` | `1` | Header row height |
| `show_cursor` | `bool` | `True` | Show cursor highlight |
| `cursor_type` | `str` | `"cell"` | `"cell"`, `"row"`, `"column"`, `"none"` |
| `cursor_coordinate` | `Coordinate` | `(0,0)` | Current cursor position |
| `hover_coordinate` | `Coordinate` | `(0,0)` | Hovered cell position |
| `cell_padding` | `int` | `1` | Horizontal padding per cell |

**Read-only:** `cursor_row`, `cursor_column`, `hover_row`, `hover_column`, `row_count`, `rows`, `columns`, `ordered_rows`, `ordered_columns`

**Key methods:**
- `add_column(label, *, width=None, key=None)` → `ColumnKey`
- `add_row(*cells, *, key=None, label=None)` → `RowKey`
- `add_columns(*columns)`, `add_rows(rows)`
- `get_cell(row_key, col_key)`, `get_cell_at(coordinate)`
- `update_cell(row_key, col_key, value)`, `update_cell_at(coordinate, value)`
- `remove_row(row_key)`, `remove_column(column_key)`
- `clear(columns=False)`, `sort(*columns, key=None, reverse=False)`
- `move_cursor(row=None, column=None, animate=False)`

**Messages:** `DataTable.CellSelected`, `DataTable.RowSelected`, `DataTable.ColumnSelected`, `DataTable.CellHighlighted`, `DataTable.RowHighlighted`, `DataTable.ColumnHighlighted`, `DataTable.HeaderSelected`, `DataTable.RowLabelSelected`

---

### DirectoryTree
File system browser displaying a directory hierarchy.

| Attribute | Type | Default |
|-----------|------|---------|
| `path` | `str\|Path` | *required* |
| `show_root` | `bool` | `True` |
| `show_guides` | `bool` | `True` |
| `guide_depth` | `int` | `4` |

**Messages:** `DirectoryTree.FileSelected` (`.path`), `DirectoryTree.DirectorySelected` (`.path`)

---

### ListItem
Focusable container item for use inside `ListView`. Arrow-key navigation is handled by the parent.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `highlighted` | `bool` | `False` | Set by parent `ListView`; do not set directly |

No messages.

---

### ListView
Vertical list of `ListItem` widgets with keyboard navigation.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `index` | `int\|None` | `None` | Highlighted item index |

**Constructor:** `*children` (ListItem), `initial_index` (int\|None, default `0`), `disabled` (bool)

**Read-only:** `highlighted_child` — the focused `ListItem` or `None`

**Methods:** `append(item)`, `extend(items)`, `insert(index, items)`, `pop(index=None)`, `clear()`, `remove_items(indices)`

**Messages:** `ListView.Highlighted` (`.item`, `.list_view`), `ListView.Selected` (`.item`, `.list_view`, `.index`)

---

### OptionList
Scrollable list of options with single selection.

| Attribute | Type | Default |
|-----------|------|---------|
| `highlighted` | `int\|None` | `None` |
| `compact` | `bool` | `False` |

**Read-only:** `highlighted_option`, `option_count`, `options`

**Methods:** `add_option(item)`, `add_options(items)`, `clear_options()`, `get_option(id)` (by option ID string), `get_option_at_index(index)`, `remove_option(id)`, `set_options(options)`

**Messages:** `OptionList.OptionHighlighted` (`.option`, `.option_id`, `.option_index`), `OptionList.OptionSelected` (`.option`, `.option_id`, `.option_index`)

---

### SelectionList
Multi-select list with independent checked states per item.

| Attribute | Type | Default |
|-----------|------|---------|
| `highlighted` | `int\|None` | `None` |

**Read-only:** `selected` — list of values for checked items

**Messages:** `SelectionList.SelectionHighlighted` (`.selection`, `.selection_index`, `.selection_list`), `SelectionList.SelectionToggled` (`.selection`, `.selection_index`, `.selection_list`), `SelectionList.SelectedChanged`

---

### Tree
Generic hierarchical tree view with expandable nodes.

| Attribute | Type | Default |
|-----------|------|---------|
| `show_root` | `bool` | `True` |
| `show_guides` | `bool` | `True` |
| `guide_depth` | `int` | `4` |
| `auto_expand` | `bool` | `True` |

**Read-only:** `root` — the root `TreeNode`; `cursor_node` — focused node

**Node methods:** `node.add(label, data=None)`, `node.add_leaf(label, data=None)`, `node.expand()`, `node.collapse()`, `node.toggle()`, `node.remove()`

**Messages:** `Tree.NodeCollapsed`, `Tree.NodeExpanded`, `Tree.NodeHighlighted` (`.node`), `Tree.NodeSelected` (`.node`; `.node.data` holds attached data)

---

## Content

### Log
Appends plain-text lines. Does not support Rich markup.

| Attribute | Type | Default |
|-----------|------|---------|
| `max_lines` | `int\|None` | `None` |
| `auto_scroll` | `bool` | `True` | → see Shared |

**Read-only:** `line_count`, `lines`

**Methods:** `write(data)`, `write_line(line)`, `write_lines(lines)`, `clear()`

---

### Markdown
Renders a Markdown string as rich formatted text.

**Constructor:** `markdown` (str\|None, default `None`), `open_links` (bool, default `True`), `parser_factory` (Callable\|None, default `None`)

**Read-only:** `source`, `table_of_contents`

**Methods:** `update(markdown)`, `append(markdown)`, `load(path)` (async), `goto_anchor(anchor)` → bool

**Messages:** `Markdown.LinkClicked` (`.href`), `Markdown.TableOfContentsSelected` (`.block_id`), `Markdown.TableOfContentsUpdated` (`.table_of_contents`)

---

### MarkdownViewer
Interactive Markdown with table of contents and navigation history.

| Attribute | Type | Default |
|-----------|------|---------|
| `show_table_of_contents` | `bool` | `True` |

**Constructor:** `markdown` (str\|None, default `None`), `open_links` (bool, default `True`)

**Read-only:** `document` (the underlying `Markdown` widget), `table_of_contents`

**Methods:** `go(location)` (async — navigates to a document path), `back()` (async), `forward()` (async)

**Messages:** `MarkdownViewer.NavigatorUpdated`

---

### Pretty
Pretty-prints any Python object using Rich.

**Constructor:** `object` (any)

**Method:** `update(object)` — replace displayed object

---

### RichLog
Appends Rich renderables (markup, tables, syntax blocks, etc.).

| Attribute | Type | Default |
|-----------|------|---------|
| `highlight` | `bool` | `False` | Auto-highlight text |
| `markup` | `bool` | `False` | Enable Rich markup |
| `max_lines` | `int\|None` | `None` | Cap stored lines |
| `min_width` | `int` | `78` | Minimum render width |
| `wrap` | `bool` | `False` | Wrap long lines |
| `auto_scroll` | `bool` | `True` | → see Shared |

**Methods:** `write(content)`, `clear()`

---

### Sparkline
Inline bar-graph of numeric values.

| Attribute | Type | Default |
|-----------|------|---------|
| `data` | `Sequence[float]\|None` | `None` |
| `summary_function` | `callable` | `max` | Function for highlighted bar |

---

## Layout

### Collapsible
Expandable/collapsible container with a title bar.

| Attribute | Type | Default |
|-----------|------|---------|
| `collapsed` | `bool` | `True` |
| `title` | `str` | `"Toggle"` |

**Constructor extras:** `collapsed_symbol` (str, default `"▶"`), `expanded_symbol` (str, default `"▼"`)

**Messages:** `Collapsible.Collapsed`, `Collapsible.Expanded`, `Collapsible.Toggled` (base message for both)

---

### ContentSwitcher
Shows one child widget at a time; switch by widget ID.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `current` | `str\|None` | `None` | ID of visible child |

**Constructor:** `initial` (str\|None, default `None`) — which child to show at startup (distinct from `current` reactive)

**Read-only:** `visible_content` — the currently visible `Widget` or `None`

**Method:** `add_content(widget, *, id=None, set_current=False)`

---

### TabbedContent
Combines `Tabs` + `ContentSwitcher`; each pane declared with `TabPane`.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `active` | `str` | `""` | Active tab ID; Textual selects the first tab automatically |

**Read-only:** `active_pane` (TabPane\|None), `tab_count` (int)

**Methods:** `add_pane()`, `remove_pane()`, `clear_panes()`, `get_pane()`, `enable_tab()`, `disable_tab()`, `show_tab()`, `hide_tab()`

**Messages:** `TabbedContent.TabActivated` (`.tab`, `.pane`), `TabbedContent.Cleared`

---

### Tabs
Tab navigation bar only (no content switching built-in).

| Attribute | Type | Default |
|-----------|------|---------|
| `active` | `str` | `""` | Active tab ID |

**Read-only:** `active_tab` (Tab\|None), `tab_count` (int)

**Methods:** `add_tab(tab)`, `remove_tab(tab_or_id)`, `clear()`, `disable()`, `enable()`, `hide()`, `show()`

**Messages:** `Tabs.TabActivated` (`.tab`), `Tabs.Cleared`, `Tabs.TabDisabled`, `Tabs.TabEnabled`, `Tabs.TabHidden`, `Tabs.TabShown`

---

## Feedback

### Digits
Displays a numeric value in large seven-segment–style digits.

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `str` | `""` | Numeric string to display |

**Method:** `update(value)` — update displayed value

---

### LoadingIndicator
Animated spinner. No reactive attributes. Mount/unmount to show/hide.

---

### ProgressBar
Linear progress indicator.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `total` | `float\|None` | `None` | 100% value; `None` = indeterminate |
| `progress` | `float` | `0` | Current value |
| `gradient` | `Gradient\|None` | `None` | Custom color gradient |

**Constructor extras:** `show_bar` (bool, True), `show_percentage` (bool, True), `show_eta` (bool, True)

**Read-only:** `percentage` (float\|None) — completion ratio (0.0–1.0)

**Methods:** `advance(amount=1)`, `update(*, total=None, progress=None, advance=None)`

---

### Toast
Temporary overlay notification (auto-dismisses).

Create via `app.notify(message, severity="information", timeout=10)` — do not mount directly.

**Severity values:** `"information"`, `"warning"`, `"error"`

---

## Scaffolding

### Header
Application title bar, typically docked at top.

| Attribute | Type | Default |
|-----------|------|---------|
| `tall` | `bool` | `False` | Two-row vs one-row height |
| `icon` | `str` | `"⭘"` | Icon character at top-left |
| `time_format` | `str` | `"%X"` | Clock display format |

**`tall` cannot be passed to the constructor** — set it after mount or via CSS:
```python
# In on_mount:
self.query_one(Header).tall = True
# Or in CSS:
Header { height: 2; }
```

**`show_clock` does not exist** — a common hallucination. The clock is always shown; control its format with `time_format`.

---

### Footer
Keybinding legend bar, typically docked at bottom.

| Attribute | Type | Default |
|-----------|------|---------|
| `combine_groups` | `bool` | `True` | Merge adjacent key groups |
| `compact` | `bool` | `False` | → see Shared |
| `show_command_palette` | `bool` | `True` | Show command palette hint |

---

## Multi-line Editor

### TextArea
Full-featured multi-line code/text editor with syntax highlighting.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `language` | `str\|None` | `None` | Syntax highlight language (e.g. `"python"`, `"json"`) |
| `theme` | `str` | `"css"` | Editor color theme |
| `selection` | `Selection` | `Selection()` | Current text selection range |
| `show_line_numbers` | `bool` | `False` | Show line number gutter |
| `line_number_start` | `int` | `1` | Starting line number |
| `indent_width` | `int` | `4` | Spaces per indent level |
| `match_cursor_bracket` | `bool` | `True` | Highlight matching bracket |
| `cursor_blink` | `bool` | `True` | → see Shared |
| `soft_wrap` | `bool` | `True` | Soft line wrapping |
| `read_only` | `bool` | `False` | Prevent keyboard edits |

**Read-only:** `text` (full content), `selected_text`, `document`, `available_themes`, `available_languages`, `is_syntax_aware`

**Writable:** `cursor_location` (row, col tuple) — assign to reposition cursor

**Class method:** `TextArea.code_editor(text, language=None, ...)` — convenience constructor for code editing

**Messages:** `TextArea.Changed` (`.text_area`), `TextArea.SelectionChanged` (`.selection`)

---

## Documentation
https://textual.textualize.io/widgets/
