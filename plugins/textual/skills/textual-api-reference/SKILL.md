---
name: textual-api-reference
description: Use when working with Textual TUI widgets — looking up available components, reactive attributes, constructor parameters, or messages emitted
---

# Textual Widget API Reference

## Overview
Complete reference for Textual's built-in widgets. All reactive attributes use `reactive()` and trigger re-renders on change. Constructor params marked `(R)` are also reactive attributes.

**Import path:** `from textual.widgets import Button, Input, DataTable, ...`

---

## Form Controls

### Button
Clickable action trigger that posts a `Button.Pressed` message.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `label` | `str` | `""` | Button text |
| `variant` | `str` | `"default"` | `"default"`, `"primary"`, `"success"`, `"warning"`, `"error"` |
| `disabled` | `bool` | `False` | Prevents clicks |

**Constructor extras:** `compact` (bool), `flat` (bool), `action` (str), `tooltip` (str)

**Messages:** `Button.Pressed` (has `.button` attr)

---

### Checkbox
Boolean toggle; extends `ToggleButton`. Posts `Checkbox.Changed`.

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `bool` | `False` |

**Toggle keys:** `enter`, `space`

**Messages:** `Checkbox.Changed` (has `.value` attr)

---

### Input
Single-line text entry with optional validation.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `value` | `str` | `""` | Current text |
| `placeholder` | `str` | `""` | Hint text when empty |
| `password` | `bool` | `False` | Mask characters |
| `restrict` | `str\|None` | `None` | Regex limiting input |
| `type` | `str` | `"text"` | `"text"`, `"integer"`, `"number"` |
| `max_length` | `int\|None` | `None` | Character limit |
| `valid_empty` | `bool` | `False` | Allow empty as valid |
| `cursor_position` | `int` | `0` | Cursor index |
| `cursor_blink` | `bool` | `True` | Animate cursor |

**Read-only:** `is_valid`, `selected_text`, `cursor_at_start`, `cursor_at_end`

**Messages:** `Input.Changed` (`.value`), `Input.Submitted` (`.value`)

---

### MaskedInput
Text input with a formatting mask (e.g. dates, phone numbers).

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `str` | `""` |
| `template` | `str` | `""` | Mask pattern |

---

### RadioButton
Standalone radio option; extends `ToggleButton`. Usually used inside `RadioSet`.

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `bool` | `False` |

---

### RadioSet
Group of `RadioButton` widgets enforcing single selection.

| Attribute | Type | Default |
|-----------|------|---------|
| `pressed_index` | `int` | `0` | Index of selected button |

**Read-only:** `pressed_button` — the active `RadioButton` or `None`

**Messages:** `RadioSet.Changed` (`.index`, `.pressed`)

---

### Select
Dropdown with a single selected value.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `value` | `SelectType\|NoSelection` | `BLANK` | `Select.BLANK` when nothing selected |
| `prompt` | `str` | `"Select"` | Placeholder text |
| `expanded` | `bool` | `False` | Dropdown open/closed |

**Methods:** `is_blank()`, `clear()` (requires `allow_blank=True`), `set_options(options)`

**Messages:** `Select.Changed` (`.value`, `.select`), `Select.SelectionChanged` (`.selection` — the highlighted option or `None`)

---

### Switch
Toggle switch (binary on/off, visually distinct from Checkbox).

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `bool` | `False` |
| `animate` | `bool` | `True` |

**Messages:** `Switch.Changed` (`.value`)

---

## Display

### Label
Simple text display. Not focusable, not a container.

No reactive attributes. Inherits from `Static`; use `update()` to change content.

---

### Link
Clickable hyperlink that opens a URL or fires an action.

| Attribute | Type | Default |
|-----------|------|---------|
| `text` | `str` | `""` |
| `url` | `str` | `""` |

---

### Placeholder
Empty space with a label — useful during layout development.

| Attribute | Type | Default |
|-----------|------|---------|
| `label` | `str\|None` | `None` | Displayed label text |
| `variant` | `str` | `"default"` | Color variant |

---

### Rule
Horizontal or vertical separator line.

**Constructor:** `Rule(orientation="horizontal")` — `"horizontal"` or `"vertical"`

| Attribute | Type | Default |
|-----------|------|---------|
| `orientation` | `str` | `"horizontal"` |
| `line_style` | `str` | `"solid"` | `"solid"`, `"dashed"`, `"double"`, `"heavy"` |

---

### Static
General-purpose content container for Rich renderables.

| Attribute | Type | Default | Notes |
|-----------|------|---------|-------|
| `content` | `VisualType` | `""` | Original set content (writable) |

**Read-only:** `visual` — what actually renders (may differ from `content`)

**Constructor:** `content`, `expand` (bool), `shrink` (bool), `markup` (bool, default `True`)

**Method:** `update(content, *, recompose=False)` — update rendered content

---

## Complex Containers

### DataTable
Grid with rows and columns, keyboard navigation, and cursor selection.

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
| `cell_padding` | `int` | `1` | Horizontal padding per cell |

**Read-only:** `cursor_row`, `cursor_column`, `hover_row`, `hover_column`, `row_count`, `rows`, `columns`

**Key methods:** `add_column(label, width=None, key=None)`, `add_row(*cells, key=None, label=None)`, `get_cell(row_key, col_key)`, `update_cell(row_key, col_key, value)`, `move_cursor(row=None, column=None, animate=False)`

**Messages:** `DataTable.CellSelected`, `DataTable.RowSelected`, `DataTable.ColumnSelected`, `DataTable.CellHighlighted`, `DataTable.RowHighlighted`

---

### DirectoryTree
File system browser displaying a directory hierarchy.

| Attribute | Type | Default |
|-----------|------|---------|
| `path` | `str\|Path` | required |
| `show_root` | `bool` | `True` |

**Messages:** `DirectoryTree.FileSelected` (`.path`), `DirectoryTree.DirectorySelected` (`.path`)

---

### ListView
Vertical list of `ListItem` widgets with keyboard navigation.

| Attribute | Type | Default |
|-----------|------|---------|
| `index` | `int\|None` | `0` | Highlighted item index |

**Constructor:** `*children` (ListItem), `initial_index` (int\|None, default `0`), `disabled` (bool)

**Read-only:** `highlighted_child` — the focused `ListItem` or `None`

**Messages:** `ListView.Highlighted` (`.item`, `.list_view`), `ListView.Selected` (`.item`, `.list_view`)

---

### OptionList
Scrollable list of options with single selection.

| Attribute | Type | Default |
|-----------|------|---------|
| `highlighted` | `int\|None` | `None` |

**Methods:** `add_option(item)`, `clear_options()`, `get_option(index)`, `get_option_at_index(index)`

**Messages:** `OptionList.OptionHighlighted` (`.option`, `.option_index`), `OptionList.OptionSelected`

---

### SelectionList
Multi-select list where each item has an independent checked state.

| Attribute | Type | Default |
|-----------|------|---------|
| `highlighted` | `int\|None` | `None` |

**Read-only:** `selected` — list of values for checked items

**Messages:** `SelectionList.SelectionHighlighted`, `SelectionList.SelectionToggled` (`.selection_list`, `.item`)

---

### Tree
Generic hierarchical tree view with expandable nodes.

| Attribute | Type | Default |
|-----------|------|---------|
| `show_root` | `bool` | `True` |
| `show_guides` | `bool` | `True` |
| `guide_depth` | `int` | `4` |

**Read-only:** `root` — the root `TreeNode`; `cursor_node` — focused node

**Node methods:** `node.add(label, data=None)`, `node.add_leaf(label, data=None)`, `node.expand()`, `node.collapse()`, `node.remove()`

**Messages:** `Tree.NodeCollapsed`, `Tree.NodeExpanded`, `Tree.NodeHighlighted` (`.node`), `Tree.NodeSelected` (`.node`; `.node.data` holds attached data)

---

## Content

### Log
Appends text lines; does not support Rich markup.

**Method:** `write_line(line)`, `write_lines(lines)`, `clear()`

---

### Markdown
Renders a markdown string as rich formatted text.

**Constructor:** `markdown` (str), `code_theme` (str, default `"monokai"`), `hyperlinks` (bool)

**Method:** `update(markdown)` — replace content

---

### MarkdownViewer
Interactive `Markdown` with a table of contents and navigation.

| Attribute | Type | Default |
|-----------|------|---------|
| `show_table_of_contents` | `bool` | `True` |

**Method:** `go(anchor)` — scroll to heading anchor

---

### Pretty
Pretty-prints any Python object using Rich's `Pretty`.

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

**Methods:** `write(content)`, `clear()`

---

### Sparkline
Inline bar-graph showing a sequence of numeric values.

| Attribute | Type | Default |
|-----------|------|---------|
| `data` | `Sequence[float]` | `[]` |
| `summary_function` | `callable` | `max` | Function for highlighted bar |

---

## Layout

### Collapsible
Expandable/collapsible container with a title bar.

| Attribute | Type | Default |
|-----------|------|---------|
| `collapsed` | `bool` | `True` |
| `title` | `str` | `""` |

**Messages:** `Collapsible.Collapsed`, `Collapsible.Expanded`

---

### ContentSwitcher
Shows one child widget at a time; switch by widget ID.

| Attribute | Type | Default |
|-----------|------|---------|
| `current` | `str\|None` | `None` | ID of visible child |

**Messages:** `ContentSwitcher.Changed` (`.content_switcher`, `.item`)

---

### TabbedContent
Combines `Tabs` + `ContentSwitcher`; each pane declared with `TabPane`.

| Attribute | Type | Default |
|-----------|------|---------|
| `active` | `str` | First tab ID | Currently active tab ID |

**Messages:** `TabbedContent.TabActivated` (`.tab`, `.pane`)

---

### Tabs
Tab navigation bar only (no content switching built-in).

| Attribute | Type | Default |
|-----------|------|---------|
| `active` | `str` | `""` | Active tab ID |

**Methods:** `add_tab(tab)`, `remove_tab(tab_or_id)`, `clear()`

**Messages:** `Tabs.TabActivated` (`.tab`), `Tabs.Cleared`

---

## Feedback

### Digits
Displays a numeric value in large seven-segment–style digits.

| Attribute | Type | Default |
|-----------|------|---------|
| `value` | `str` | `"0"` | Numeric string to display |

---

### LoadingIndicator
Animated spinner shown while content loads.

No reactive attributes. Mount/unmount to show/hide.

---

### ProgressBar
Linear progress indicator.

| Attribute | Type | Default |
|-----------|------|---------|
| `total` | `float\|None` | `None` | 100% value; `None` = indeterminate |
| `progress` | `float` | `0` | Current value |

**Method:** `advance(amount=1)` — increment progress

---

### Toast
Temporary overlay notification (auto-dismisses).

Typically created via `app.notify(message, severity="information", timeout=3.0)` rather than mounted directly.

**Severity values:** `"information"`, `"warning"`, `"error"`

---

## Scaffolding

### Header
Application title bar, typically docked at top.

| Attribute | Type | Default |
|-----------|------|---------|
| `tall` | `bool` | `True` | Two-row vs one-row height |
| `show_clock` | `bool` | `False` | Display current time |

---

### Footer
Keybinding legend bar, typically docked at bottom.

No reactive attributes. Automatically discovers active bindings from the focused widget and its ancestors.

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
| `cursor_blink` | `bool` | `True` | Animate cursor |
| `soft_wrap` | `bool` | `True` | Soft line wrapping |
| `read_only` | `bool` | `False` | Prevent keyboard edits |

**Read-only:** `text` (full content), `selected_text`, `cursor_location` (row, col tuple), `document`, `available_themes`

**Class method:** `TextArea.code_editor(text, language=None, ...)` — convenience constructor for code editing

**Messages:** `TextArea.Changed` (`.text_area`), `TextArea.SelectionChanged` (`.selection`)

---

## Documentation
https://textual.textualize.io/widgets/
