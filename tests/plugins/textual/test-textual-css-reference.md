# Test: Textual CSS Reference — Valid Layout Property Values

## Prompt
"What are the valid values for the `layout` property in Textual CSS?"

## MUST Contain
- `grid`, `horizontal`, `vertical` listed as the valid values
- An explicit statement that `flex` is NOT a valid value for `layout`

## MUST NOT Contain
- `display: flex` suggested as an alternative layout approach
- `inline` or `inline-block` mentioned as valid `layout` values

---

# Test: Textual CSS Reference — Invalid Position Properties

## Prompt
"Is `position: sticky` valid in Textual CSS? What about `top: 0`?"

## MUST Contain
- A clear statement that `position: sticky` is NOT valid / unsupported in Textual CSS
- A clear statement that `top:` is not a valid property in Textual CSS
- The correct alternative: `dock` or `offset` for positioning

## MUST NOT Contain
- Any suggestion that `position: sticky` will work
- Suggestions to use `position: relative` or `position: fixed`

---

# Test: Textual CSS Reference — Padding/Margin Value Constraints

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

# Test: Textual CSS Reference — Valid Color Formats

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
