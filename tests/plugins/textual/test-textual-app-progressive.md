# Progressive App Tests — Textual Chat Application

These tests build a real Textual app step by step. Each step gives the current app
state as context and asks the agent to add one feature. The agent writes **complete**
Python code; the test runner validates it actually runs without CSS errors.

Both skills are exercised simultaneously — CSS reference prevents crashes, widget
API reference ensures correct widget usage.

## How to Run Each Step

```bash
# 1. Dispatch agent (baseline: no skills / GREEN: both skills prepended)
# 2. Extract Python code block from response → save to file
# 3. Validate CSS:
source /tmp/textual-test/bin/activate
python3 tests/plugins/textual/run_textual_test.py /tmp/step_N.py

# 4. Dispatch Haiku judge for widget/API correctness (see Code Checks per step)
# 5. Record in test-results.md
```

**PASS** = `run_textual_test.py` exits 0 AND Haiku judge finds no violations  
**FAIL (CSS)** = `run_textual_test.py` exits 1 — lists exact bad properties  
**FAIL (API)** = runner passes but Haiku judge finds wrong widget/message usage

---

# Step 1: App Shell

## Prompt
"Write a complete Textual Python app for a chat interface. It should have a Header
showing the title 'Chat', a Footer showing keybindings, and a placeholder Static
widget in the body that says 'Messages will appear here'. Include all necessary
imports and valid Textual CSS to make the layout fill the terminal."

## Code Checks (Haiku judge)
MUST appear in code:
- `Header()` widget instantiated in compose
- `Footer()` widget instantiated in compose
- `Static` widget with placeholder text
- `dock: top` in CSS for Header OR Header used without explicit CSS (it docks itself)

MUST NOT appear in CSS:
- `display: flex` or `display: inline` or `display: grid`
- `position: fixed` or `position: sticky` or `position: relative`
- `font-weight` or `font-size` or `font-family`

---

# Step 2: Two-Column Grid Body

## Prompt
"Update the app: replace the single Static placeholder with a two-column layout.
The left column is a sidebar (1/3 width) and the right column is the main chat area
(2/3 width). Each column should be a container with a border so you can see them.
Use valid Textual CSS for the grid — the app must not crash on startup."

## Context given to agent
```
(Include the complete working code from Step 1)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `layout: grid` in CSS
- `grid-columns: 1fr 2fr` or equivalent fraction-based column widths
- Two separate container widgets (one for sidebar, one for main)

MUST NOT appear in CSS:
- `display: grid` (correct is `layout: grid`)
- `grid-template-columns` (correct is `grid-columns`)
- `flex` anywhere
- `width: 33%` on child widgets as a column-sizing technique

---

# Step 3: Input + Send Button Row

## Prompt
"Add a message input row at the bottom of the main chat area. It should have a
text Input widget on the left (taking all available width) and a 'Send' Button
on the right. The button should be exactly 1 line tall — no taller. The row sits
at the bottom of the main area. Wire up the Button so pressing it clears the input."

## Context given to agent
```
(Include the complete working code from Step 2)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `Input` widget
- `Button` widget with label `"Send"` or `'Send'`
- `layout: horizontal` in CSS for the input row container
- `height: 1` or `height: auto` on the Button or its container
- Handler for `Button.Pressed` (not `Button.Clicked`)

MUST NOT appear in CSS:
- `display: flex` or `flex-direction: row`
- `align-items` or `justify-content` (CSS3 flexbox)

MUST NOT appear in code:
- `Button.Clicked` as message name (correct is `Button.Pressed`)
- `on_button_clicked` as handler name (correct is `on_button_pressed`)

---

# Step 4: DataTable in Sidebar

## Prompt
"Add a DataTable to the sidebar showing a list of chat users. It should have two
columns: 'User' and 'Status'. Add 3 sample rows of data. Use alternating row colors
(zebra stripes) and highlight the full row when the cursor is on it (not just the
cell). Make it fill the sidebar."

## Context given to agent
```
(Include the complete working code from Step 3)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `DataTable` widget
- `add_column(` called at least twice
- `add_row(` called at least 3 times
- `zebra_stripes=True` or `zebra_stripes: True` in CSS
- `cursor_type="row"` (not `"cell"`) for row-level highlighting

MUST NOT appear in code:
- Direct assignment to `.rows` or `.columns` (they are read-only)
- `append_row(` (correct method is `add_row`)
- `cursor_type="cell"` when row-level is required

---

# Step 5: RichLog Message Area

## Prompt
"Replace the placeholder in the main chat area with a RichLog widget that will
display chat messages. It should automatically scroll to the latest message, support
Rich markup (so messages can have bold names and colored text), and fill the
available space above the input row."

## Context given to agent
```
(Include the complete working code from Step 4)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `RichLog` widget (not `Log` — Log does not support markup)
- `markup=True` on the RichLog
- `auto_scroll=True` on the RichLog
- `.write(` used to add messages (not `.write_line` which is for Log)

MUST NOT appear in code:
- `Log` instead of `RichLog` when markup support is needed
- `print(` used to write to the log widget

---

# Step 6: CSS Styling Pass

## Prompt
"Style the app with Textual CSS:
- The sidebar should have a heavy border on its right edge only, and a slightly
  darker background than the default
- User names in the DataTable should appear bold
- The Header should be tall (two rows) and show a clock
- The Send button should use the 'success' variant
- The Input placeholder text should say 'Type a message...'"

## Context given to agent
```
(Include the complete working code from Step 5)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `border-right: heavy` or `border-right: heavy <color>` (Textual border syntax)
- `text-style: bold` for bold text (not `font-weight: bold`)
- `variant="success"` on the Button
- `placeholder="Type a message..."` on the Input
- `tall=True` on Header OR Header CSS for two-row height

MUST NOT appear in CSS:
- `font-weight: bold` (invalid — use `text-style: bold`)
- `border-right: 1px` or any pixel-width border syntax
- `border: dotted` (dotted is not a valid Textual border style)
- `font-size` (not a valid Textual CSS property)

---

# Step 7: Collapsible Sidebar

## Prompt
"Wrap the sidebar's content in a Collapsible widget so users can hide the user list.
The Collapsible should start expanded (not collapsed) and have the title 'Users'.
Add a keyboard binding Ctrl+B to toggle it."

## Context given to agent
```
(Include the complete working code from Step 6)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `Collapsible` widget with `title="Users"` or `title='Users'`
- `collapsed=False` to start expanded (the default is True — must be explicit)
- A keybinding for Ctrl+B to toggle

MUST NOT appear in code:
- `Collapsible()` without `collapsed=False` (default collapsed=True would start it hidden)
- `title=""` or no title (the default is "Toggle", not "Users")

---

# Step 8: Select Filter Dropdown

## Prompt
"Add a Select dropdown at the top of the sidebar to filter the DataTable by user
status. Options: 'All', 'Online', 'Away', 'Offline'. When the selection changes,
print the selected value to the RichLog. Handle the case where nothing is selected."

## Context given to agent
```
(Include the complete working code from Step 7)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `Select` widget with options for All/Online/Away/Offline
- Handler for `Select.Changed` (not `Select.SelectionChanged` — that doesn't exist)
- Check for `Select.NULL` or `self.query_one(Select).is_blank()` before using the value

MUST NOT appear in code:
- `Select.SelectionChanged` as a message (does not exist)
- `Select.BLANK` as the sentinel (correct is `Select.NULL`)
- Using `event.value` directly without checking for the null/unselected state

---

# Step 9: Markdown Help Panel

## Prompt
"Add a help panel to the main area that can be toggled with F1. When visible, it
replaces the RichLog with a MarkdownViewer showing help text about the app's
keybindings. The MarkdownViewer should show its table of contents. Pressing F1
again hides the help and restores the chat view. Use ContentSwitcher to toggle
between the two panels."

## Context given to agent
```
(Include the complete working code from Step 8)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `ContentSwitcher` widget
- `MarkdownViewer` widget with `show_table_of_contents=True`
- Switching via `self.query_one(ContentSwitcher).current = "..."` (setting the ID)
- F1 keybinding

MUST NOT appear in code:
- `ContentSwitcher.Changed` as a message (does not exist)
- `MarkdownViewer.go(anchor)` used to switch panels (go() navigates documents, not panels)
- Mounting and unmounting widgets to toggle visibility (use ContentSwitcher instead)

---

# Step 10: Progress Bar and Notifications

## Prompt
"Add a ProgressBar to the Footer area showing a simulated 'sync' progress.
When the user presses Ctrl+S, start a worker that increments the progress bar
from 0 to 100 over 2 seconds, then shows a success Toast notification when done.
The progress bar should be determinate (total=100) and show the percentage and ETA."

## Context given to agent
```
(Include the complete working code from Step 9)
```

## Code Checks (Haiku judge)
MUST appear in code:
- `ProgressBar` with `total=100`
- `show_percentage=True` and `show_eta=True` on ProgressBar
- `self.notify(` or `app.notify(` for the success notification (not mounting Toast directly)
- `advance(` or `update(progress=` to increment the bar

MUST NOT appear in code:
- `Toast(` mounted directly (use `app.notify()`)
- `total=None` on ProgressBar (that makes it indeterminate)
- `progress_bar.progress = X` as a direct assignment to increment (use `advance()` or `update()`)
