# Test: layout property — valid values only

## Prompt
"What are the valid values for the `layout` property in Textual CSS?"

## MUST Contain
- `grid`, `horizontal`, `vertical` as the only valid values
- An explicit statement that `flex` is NOT a valid value for `layout`

## MUST NOT Contain
- `display: flex` suggested as an alternative layout approach
- `inline` or `inline-block` mentioned as valid `layout` values

---

# Test: position properties — sticky, fixed, top, left

## Prompt
"Is `position: sticky` valid in Textual CSS? What about `top: 0`?"

## MUST Contain
- A clear statement that `position: sticky` is NOT valid in Textual CSS
- A clear statement that `top:` is not a valid property in Textual CSS
- The correct alternative: `dock` or `offset` for positioning

## MUST NOT Contain
- Any suggestion that `position: sticky` will work
- Suggestions to use `position: relative` or `position: fixed`

---

# Test: padding/margin — 3-value shorthand

## Prompt
"Can I write `padding: 0 10 20` in Textual CSS?"

## MUST Contain
- A statement that 3-value shorthand is NOT valid for `padding` in Textual CSS
- The valid alternatives: 1, 2, or 4 values (e.g., `padding: 0 10 20 10`)
- The same constraint applies to `margin`

## MUST NOT Contain
- Confirmation that `padding: 0 10 20` is valid
- A suggestion that `padding: auto` is a valid fallback

---

# Test: color formats — supported functions

## Prompt
"What color formats can I use for the `color` property in Textual CSS?"

## MUST Contain
- Named colors (e.g., `red`, `aliceblue`)
- Hex formats: `#RGB`, `#RRGGBB`, `#RGBA`, `#RRGGBBAA`
- Functional formats: `rgb()`, `rgba()`, `hsl()`, `hsla()`
- CSS variables using the `$variable-name` syntax

## MUST NOT Contain
- `oklch()` or `lch()` color functions
- Any suggestion that `currentColor` is supported

---

# Test: display property — only two valid values

## Prompt
"What values can I use for `display` in Textual CSS? I want to make a widget behave like a flex container."

## MUST Contain
- Only `block` and `none` are valid values for `display`
- `flex`, `inline`, `inline-block`, `grid` are NOT valid values for `display`
- That flex-like layouts use `layout: horizontal` or `layout: vertical`, not `display: flex`

## MUST NOT Contain
- `display: flex` as a suggested approach
- `display: inline` or `display: inline-block` as valid options
- `display: grid` as a valid value (grid is set with `layout: grid`, not `display: grid`)

---

# Test: grid layout — correct property names

## Prompt
"How do I define column widths in a Textual grid layout? I want two columns, one twice as wide as the other."

## MUST Contain
- `layout: grid` to enable grid layout
- `grid-columns: 1fr 2fr` as the correct property name for column widths
- `grid-rows` as the correct property name for row heights (not `grid-template-rows`)

## MUST NOT Contain
- `grid-template-columns` as a property name (this is CSS3 — Textual uses `grid-columns`)
- `grid-template-rows` as a property name (Textual uses `grid-rows`)
- `display: grid` as the way to enable grid layout

---

# Test: text styling — Textual properties vs CSS3 font properties

## Prompt
"How do I make text bold and italic in Textual CSS?"

## MUST Contain
- `text-style: bold italic` as the correct approach (space-separated values)
- Valid `text-style` values: `bold`, `italic`, `underline`, `strike`, `reverse`, `none`
- That multiple styles can be combined: e.g. `text-style: bold italic underline`

## MUST NOT Contain
- `font-weight: bold` (not a valid Textual CSS property)
- `font-style: italic` (not a valid Textual CSS property)
- `font-family` (not a valid Textual CSS property)

---

# Test: overflow — axis must be specified

## Prompt
"How do I hide overflowing content vertically in Textual CSS? Can I use `overflow: hidden`?"

## MUST Contain
- `overflow: hidden` alone is NOT valid in Textual CSS
- The correct form specifies an axis: `overflow-y: hidden` or `overflow-x: hidden`
- That `overflow` with two values works: e.g. `overflow: hidden auto` (y-axis then x-axis)

## MUST NOT Contain
- `overflow: hidden` presented as a standalone valid declaration
- Any suggestion that `overflow: hidden` without an axis specification will work

---

# Test: centering — margin: auto is invalid

## Prompt
"How do I center a widget horizontally in Textual CSS? Can I use `margin: auto`?"

## MUST Contain
- `margin: auto` is NOT valid in Textual CSS
- The correct approach: `align-horizontal: center` or `align: center middle`
- `content-align` for aligning content within a widget

## MUST NOT Contain
- `margin: auto` or `margin: 0 auto` presented as valid centering techniques
- `justify-content: center` or `align-items: center` (CSS3 flexbox — not valid in Textual)

---

# Test: border styles — Textual-specific values

## Prompt
"What border styles are available in Textual CSS? Can I use `border: 1px dotted red`?"

## MUST Contain
- `border: dotted red` is NOT valid — `dotted` is not a Textual border style
- Valid Textual border styles include: `solid`, `round`, `heavy`, `dashed`, `double`, `ascii`, `blank`, `thick`, `panel`, `tall`, `wide`, `hidden`, `none`
- Textual border syntax does NOT use pixel widths: `border: solid red` not `border: 1px solid red`

## MUST NOT Contain
- `dotted` listed as a valid Textual border style
- Any pixel-width syntax like `1px` or `2px` in a border declaration
- `border-radius` as a valid property (not supported in Textual)
