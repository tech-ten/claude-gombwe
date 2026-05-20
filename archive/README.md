# archive

Old code kept for reference, no longer in the live execution path.

## `ui-prototypes/`

Four earlier iterations of the network dashboard (`network.v1.*` through
`network.v4.*`). The current active dashboard lives at `ui/network.{html,css,js}`
(no version suffix).

- **v1** — original dark operator console
- **v2** — consumer warm pastel pass
- **v3** — McKinsey editorial cream/charcoal
- **v4** — Tailscale admin structure on the v3 type system (this is the
  layout the current dashboard descends from)

Kept for design-history reference. Not referenced by any code; safe to
delete entirely once you're sure you don't want to look back at them.

## `scripts/`

- **`tv-remote.py`** — early Python prototype for ADB-over-network TV
  control. Superseded by `scripts/tv.mjs`, which is what the `tv` skill
  invokes today. Kept here in case the Python version ever needs to be
  resurrected for a non-Node environment.
