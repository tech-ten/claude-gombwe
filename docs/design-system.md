# gombwe dashboard design system

The dashboard is an instrument panel. It shows a household what its agent is
doing, what the network is doing, and what needs a decision. Density,
alignment and type hierarchy do the work. Nothing is decorative.

Tokens live in `ui/theme.css` and must be linked before `ui/style.css`.
`style.css` declares no colour of its own: every value resolves through a
token, so light and dark are one implementation rather than two. The only
colour literals in the UI are the token definitions themselves, plus the
chart palette in `ui/app.js` explained below.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#0F1115` | Page background |
| `--bg-soft` | `#FAFAFB` | `#151821` | Inset rows, hover, sidebar |
| `--surface` | `#FFFFFF` | `#151821` | Cards, panels, popovers |
| `--border` | `#E4E6EB` | `#262A35` | Hairline that separates regions |
| `--border-soft` | `#EFF0F3` | `#1E222B` | Hairline between rows of one list |
| `--text` | `#1A1D24` | `#E6E8EE` | Primary text |
| `--text-2` | `#4B5260` | `#A6ADBB` | Body detail, secondary values |
| `--text-3` | `#8A92A0` | `#6B7280` | Labels, timestamps, units, empty states |
| `--accent` | `#2563EB` | `#5B8DEF` | The only accent. Interactive and active states |
| `--accent-soft` | 8% accent | 14% accent | Active nav row, selected list row |
| `--on-accent` | `#FFFFFF` | `#0F1115` | Text on a filled accent or state swatch |
| `--ok` | `#15803D` | `#4ADE80` | Healthy, online, done |
| `--warn` | `#B45309` | `#FBBF24` | Needs attention, not broken |
| `--danger` | `#B91C1C` | `#F87171` | Failed, blocked, breached |
| `--scrim` | `rgba(0,0,0,.4)` | same | Behind a modal or the mobile drawer |

`--scrim` is the one token that does not flip with the theme. A scrim dims
whatever is beneath it, and what is beneath it is the page, which is already
light or dark. Tinting it with the theme would make it lighten a dark page.
It is used in exactly three places: the command palette overlay, the network
modal, and the mobile drawer backdrop.

There is exactly one accent. Blue means "you can act on this" or "this is
where you are". It is never used to decorate a heading or a border that is
not interactive. State colours mean state, never emphasis.

`--on-accent` flips with the theme because the dark palette's `--ok` and
`--warn` are bright: white text on `#4ADE80` fails contrast, dark text
passes.

`--c1` through `--c10` are the categorical chart series, ordered for
separation at small sizes. They are for charts only, never for chrome. SVG
presentation attributes (`fill="…"`) cannot resolve custom properties, so
`ui/app.js` carries the same values as literals in `SERIES` and `SEM`.
**Change `theme.css` and `app.js` together.**

## Type

One family: `--sans`, the system face. No web fonts — the dashboard should
look like the operating system it runs on, and a font request is a render
delay for a page people open twenty times a day. `--mono` for numbers,
identifiers, times and code.

| Size | Weight | Use |
|---|---|---|
| 11px | 600, `0.06em`, uppercase | Section labels (`.label`), nav group headings |
| 11px | 400 | Meta: timestamps, counts, units, principals |
| 12px | 400 | Secondary body, table cells, buttons |
| 13px | 400 | Base body, nav rows, inputs |
| 13–15px | 600 | Panel and page titles |
| 18px | 600 | Page title (`.page-title`) |
| 20px | 500, mono | A single large metric value |

Nothing is larger than 20px. Nothing is italic. There is no display face.

Every number column carries `font-variant-numeric: tabular-nums`, applied
broadly on `body` and the form elements. Use `.num` for a right-aligned
monospace figure and `.mono` for an identifier.

## Spacing

An 8px grid, with a 4px half-step: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16,
`--s5` 24, `--s6` 32. Use the tokens, not literals. Phone width gets a 16px
side gutter.

## Geometry and motion

- Radii: `--r` 6px for controls and rows, `--r-lg` 8px for panels. Nothing
  else. No pills except the existing filter chips.
- Borders are hairlines. `--border` separates regions, `--border-soft`
  separates rows within one region.
- `--shadow` is `0 1px 2px rgba(0,0,0,.04)` and is `none` in dark mode. It is
  for things that float above the page, which is almost nothing. A card is a
  hairline box, not a raised one.
- Motion is `--t` (120ms) or none. No infinite animation: a badge that
  throbs forever is noise, and the state is already in the colour and the
  label. `prefers-reduced-motion` reduces everything to 1ms.

## Components

**Nav.** Rows carry `data-grant`. `applyGrants()` in `ui/app.js` hides a row
whose grant the signed-in principal does not hold, and a group heading
disappears with its last visible row via `:has()`. Active row: `--accent-soft`
background, `--accent` text, accent dot. Never bold-plus-fill-plus-border;
one signal is enough.

**Tables over cards.** If the data is tabular, it is a table. A fixed,
monospace first column so the second column starts on the same x in every
row. Rows separated by `--border-soft`, the last row without one.

**Panels.** An 11px uppercase label, a hairline, then rows. No card around a
card. A panel with no data hides itself rather than showing an empty box,
and a panel whose endpoint 404s hides itself rather than showing an error.

**Alerts.** A row with a 2px coloured left edge, not a tinted block. A fill
behind body text costs more contrast than the attention it buys, and in dark
mode a tint over near-black reads as dirt.

**Buttons.** `.btn-primary` is a filled accent, used once per region for the
one action that matters. `.btn-ghost` is a hairline box for everything else.
`.btn-sm` for in-row actions.

**Glyphs.** There are no emoji anywhere in `ui/`. A flagged device or
destination is marked by `.flag-dot`, a 6px circle drawn in CSS and coloured
by `.flag-high` / `.flag-med` / `.flag-low`. A CSS glyph takes the theme's
state colour and renders identically on every platform; an emoji does
neither, and carries a colour the design system does not own. Status that
used to lead with a tick or a cross now leads with the word, coloured by
`.dns-ok` or `.dns-warn`.

Directional arrows (`↓` down, `↑` up, `→` maps-to) are kept. They are
typographic marks rather than pictographs, they carry meaning in a dense
throughput column where a word would wrap, and they render from the text
font in both themes.

**Failed writes.** A write that fails says so where it was triggered, in an
`.inline-error` line under the row, and the row stays put so the action can
be retried. Not a toast, not an alert box, never only a `console.warn`.

## Graceful degradation

Several endpoints this shell reads are owned by later work. The rule is that
a missing endpoint shortens the page, never breaks it:

- `getJSON()` returns `null` on a non-OK response or a thrown fetch. Callers
  hide their panel.
- `/api/me` returning 404 means owner with every grant, which is the
  single-user behaviour the household has today. This is the **only**
  fail-open path. A principal that is not the owner and carries no grants
  object holds no grants, so a malformed or truncated `/api/me` shows Home
  and Chat and nothing else.
- A tab hidden by grant is unreachable, including by URL hash.

## Do and do not

Do: use tokens; keep to the 8px grid; put numbers in monospace and align
them; hide what has no data; let one hairline do the work of a border, a
shadow and a fill.

Do not: add a second accent; add a web font; use a gradient, a glow or a
glassmorphic panel; animate on a loop; write an emoji or an exclamation mark
into UI copy; put a number in a sentence where a column would do; introduce
a colour literal in `style.css`; use a near-black tint such as
`rgba(0,0,0,.02)` for a hover or open state, because it disappears entirely
on a dark surface — use `--bg-soft`.
