---
name: textual-css-reference
description: Use when writing Textual TUI CSS styles or checking valid CSS properties
---

# Textual CSS Reference

## Overview
Complete reference for valid Textual CSS properties, values, and types. Textual CSS differs from web CSS — many web properties are invalid or unsupported.

## VALID PROPERTIES

### Layout & Sizing
| Property | Valid Values |
|----------|-------------|
| `width` | integer, `N%`, `Nw`, `Nh`, `Nvw`, `Nvh`, `auto`, `Nfr` |
| `height` | integer, `N%`, `Nw`, `Nh`, `Nvw`, `Nvh`, `auto`, `Nfr` |
| `min-width` | integer, percentage, `auto` |
| `min-height` | integer, percentage, `auto` |
| `max-width` | integer, percentage, `auto` |
| `max-height` | integer, percentage, `auto` |
| `layout` | `grid`, `horizontal`, `vertical` (NOT `flex`) |
| `align` | `left\|center\|right` `top\|middle\|bottom` |
| `align-horizontal` | `left`, `center`, `right` |
| `align-vertical` | `top`, `middle`, `bottom` |
| `content-align` | `left\|center\|right` `top\|middle\|bottom` |
| `dock` | docking position value |
| `position` | x/y coordinates (ONLY `absolute` supported) |
| `offset` | positional offset |

### Spacing
| Property | Valid Values |
|----------|-------------|
| `margin` | 1-4 integers (clockwise: top→right→bottom→left) |
| `margin-top` | integer |
| `margin-right` | integer |
| `margin-bottom` | integer |
| `margin-left` | integer |
| `padding` | 1-4 integers |
| `padding-top` | integer |
| `padding-right` | integer |
| `padding-bottom` | integer |
| `padding-left` | integer |

### Display & Visibility
| Property | Valid Values |
|----------|-------------|
| `display` | `block`, `none` (NOT `flex`, `inline`, `grid` for display) |
| `visibility` | `hidden`, `visible` |

### Colors & Backgrounds
| Property | Valid Values |
|----------|-------------|
| `color` | Named, hex, rgb(), hsl(), hsla() |
| `background` | `<color>` with optional `<percentage>` for opacity |
| `background-tint` | tint overlay |
| `tint` | color tint overlay |
| `text-opacity` | percentage |
| `opacity` | transparency level |
| `box-sizing` | `border-box`, `content-box` |

### Text Styling
| Property | Valid Values |
|----------|-------------|
| `text-style` | `bold`, `italic`, `underline`, `strike`, `reverse`, `none` |
| `text-align` | `left`, `center`, `right` |
| `text-wrap` | wrap mode values |
| `text-overflow` | overflow handling |

### Borders
| Property | Valid Values |
|----------|-------------|
| `border` | `<border-style>` `<color>` `<percentage>` |
| `border-top` | style/color on top edge only |
| `border-right` | style/color on right edge only |
| `border-bottom` | style/color on bottom edge only |
| `border-left` | style/color on left edge only |
| `border-title-align` | `left`, `center`, `right` |
| `border-title-background` | color |
| `border-title-color` | color |
| `border-title-style` | text style |
| `border-subtitle-align` | `left`, `center`, `right` |
| `border-subtitle-background` | color |
| `border-subtitle-color` | color |
| `border-subtitle-style` | text style |

**Border Styles:** `solid`, `dashed`, `tall`, `ascii`, `blank`, `double`, `heavy`, `hidden`, `none`, `hkey`, `inner`, `outer`, `panel`, `round`, `thick`, `vkey`, `wide`

### Grid Layout
| Property | Valid Values |
|----------|-------------|
| `grid` | grid container |
| `grid-size` | `cols rows` |
| `grid-columns` | `<scalar>+` |
| `grid-rows` | `<scalar>+` |
| `grid-gutter` | `<scalar>` or `<scalar> <scalar>` |
| `column-span` | integer |
| `row-span` | integer |

### Scrollbars
| Property | Valid Values |
|----------|-------------|
| `scrollbar-gutter` | gutter handling |
| `scrollbar-size` | dimensions |
| `scrollbar-visibility` | visibility mode |
| `scrollbar-color` | color |
| `scrollbar-background` | color |
| `scrollbar-color-hover` | color |
| `scrollbar-background-hover` | color |
| `scrollbar-color-active` | color |
| `scrollbar-background-active` | color |
| `scrollbar-corner-color` | color |

### Links
| Property | Valid Values |
|----------|-------------|
| `links` | container |
| `link-color` | color |
| `link-background` | color |
| `link-style` | text style |
| `link-color-hover` | color |
| `link-background-hover` | color |
| `link-style-hover` | text style |

### Other
| Property | Valid Values |
|----------|-------------|
| `overflow` | `auto`, `scroll`, `hidden` |
| `overflow-x` | `auto`, `scroll`, `hidden` |
| `overflow-y` | `auto`, `scroll`, `hidden` |
| `pointer` | pointer event handling |
| `layer` | single layer |
| `layers` | multiple layers |
| `hatch` | hatch pattern |
| `keyline` | keyline style |
| `outline` | outline styling |

## INVALID / UNSUPPORTED PROPERTIES

These will cause runtime errors:
- `position: sticky`, `position: fixed`, `position: relative`
- `position: absolute` is only valid position value
- `top:`, `left:`, `right:`, `bottom:` positioning
- `display: flex` — use `layout: horizontal/vertical` instead
- `display: grid` — use `layout: grid` instead
- `grid-template-columns:`, `grid-template-rows:` — use `grid-columns:`, `grid-rows:` instead
- `margin:` with 3 values
- `padding:` with 3 values
- `margin: auto`, `padding: auto`
- `overflow: hidden` alone (must use `overflow-y: hidden`)
- `overflow: scroll` alone (must specify axes: `overflow: scroll auto`)

## CSS TYPES

### `<color>`
- Named colors: `red`, `blue`, `aliceblue`, etc.
- Hex: `#RGB`, `#RRGGBB`, `#RGBA`, `#RRGGBBAA`
- Functional: `rgb(r,g,b)`, `rgba(r,g,b,a)`, `hsl(h,s%,l%)`, `hsla(h,s%,l%,a)`
- CSS variables: `$variable-name`

### `<text-style>`
Space-separated: `bold`, `italic`, `underline`, `strike`, `reverse`, `none`
Can combine: `bold italic underline`

### `<border>`
Style + optional color: `heavy red`, `round orange 50%`

### `<scalar>`
- Integer cells: `10`
- Fraction: `1fr`
- Percent: `50%`
- Container-relative: `25w`, `75h`
- Viewport-relative: `25vw`, `75vh`
- Auto: `auto`

## COMMON MISTAKES

| Wrong | Correct |
|-------|---------|
| `display: flex` | `layout: horizontal` |
| `display: grid` | `layout: grid` |
| `margin: auto` | Remove or use explicit values |
| `padding: 0 10 20` | `padding: 0 10 20 10` (must be 1, 2, or 4 values) |
| `position: absolute; top: 0` | Just `dock: top` or `offset` |
| `overflow: hidden` | `overflow-y: hidden` |
| `grid-template-columns: 1fr 2fr` | `grid-columns: 1fr 2fr` |

## VALID DISPLAY VALUES

Only TWO valid values:
- `block` — show widget
- `none` — hide widget

NOT valid: `flex`, `inline`, `inline-block`, `grid`

## DOCUMENTATION
https://textual.textualize.io/styles/
