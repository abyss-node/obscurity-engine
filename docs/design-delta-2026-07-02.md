# Design delta — 2026-07-02 (low-risk polish pass, T3)

Audit of `design-preview.html`, `design-faint-field.html`, `DESIGN.md`, and
`design_handoff_results_redesign/` against the **live** UI, to port only
clearly-better **low-risk** elements (typography, spacing, color tokens,
card/surface treatments, micro-interactions). **No** layout / IA changes, **no**
component API (prop) changes. `page.tsx` is owned by the share task and was not
touched — token changes made here propagate to it through the shared CSS vars.

## Sources, in order of authority

- **`design_handoff_results_redesign/`** — the *current* design system. The live
  UI already implements it faithfully (component-for-component: `DiscoveryMatrix`,
  the artist ledger `ArtistCard`/`ArtistList`, `LoadingState`, `EmptyState`,
  `ErrorState`, `ApiKeyModal`, `ShareCard`, `TracksComingSoon`, `OnboardingGuide`).
  This is the newest, shipped spec.
- **`DESIGN.md`** — the written design-system rules (colors, type scale, the
  explicit rule "no letter-spacing on headings or body text").
- **`design-preview.html`** — an **earlier** iteration of the *same* visual
  language (identical tokens + 3-font system). Most of its choices were
  intentionally superseded by the handoff redesign (single-axis scatter → 2-D
  Discovery Matrix; scored cards → compact ledger). It is a polish reference, not
  a target to re-adopt.
- **`design-faint-field.html`** — a **divergent alternative concept**: different
  palette (deep blue `#070a14`, cyan/amber), different fonts (Bodoni Moda /
  Hanken Grotesk / Spline Sans Mono), starfield + film-grain + reticle cursor,
  RA/Dec chart chrome. Adopting any of it would be an aesthetic/IA change, which
  is out of scope for a low-risk pass. Treated as **reference only → no ports**.

## Per-element decisions

| Element | Current (live) | Preview / reference | Port? | Why |
|---|---|---|---|---|
| Color tokens (bg/surface/border/text/muted/dim/accent/accent2/discovery) | Exact hexes in `globals.css` | Identical hexes in `design-preview.html` `:root` | **no** | Already identical; nothing to change. |
| `gold-bright` hover token | absent from token layer | Handoff Color table defines `gold-bright #D9A441 / #E0AE52` ("hover-brightened gold"); preview brightens the primary button on hover (`#CA9436`) | **YES** | Real gap: the authoritative handoff spec names a hover-gold token that the code never added. Add `--accent-bright: #D9A441` and register it in Tailwind. Additive, low-risk. |
| Gold bordered-button hover feel | Gold bordered buttons dim via `hover:opacity-70` (EmptyState, ApiKeyModal) or only shift border (ArtistCard listen/find links keep gold text static) | Handoff calls for hover-brightened gold; faint-field brightens active/hover affordances | **YES** | Micro-interaction: brighten the gold **text** to `--accent-bright` on hover for the bordered-gold-button family (ArtistCard listen/find links, EmptyState "check my setup", ApiKeyModal "save"). Purely additive; does not change borders (ArtistCard link border stays `accent2` per handoff), so it contradicts nothing and cannot regress a static state. |
| Negative letter-spacing on Playfair headings (`-0.01em`/`-0.02em`) | none on artist names / headings | `design-preview.html` tightens `.display-*`, `.artist-name`, `.results-username` | **no** | `DESIGN.md` explicitly forbids letter-spacing on headings/body ("Size and weight carry hierarchy"). Respect the stated system; the only negative tracking in the shipped design is on the giant index numeral (already present in `ShareCard`/`page.tsx`). |
| Depth/index numeral weight | Playfair italic **700** (ShareCard, page.tsx) | preview `.depth-number` uses **900** | **no** | Handoff (newer) specifies italic **700** for the index numeral; preview's 900 was superseded. Keeping 700. |
| Font smoothing | `antialiased` on `<body>` (sets `-webkit-font-smoothing` + `-moz-osx-font-smoothing`) | preview `-webkit-font-smoothing: antialiased` | **no** | Already covered by the existing `antialiased` class. |
| Artist row = compact ledger | Ledger rows (rank · artist · genre · country · conviction · listeners · expand) | preview shows scored **cards** with right-aligned conviction/stickiness/composite | **no** | IA change; the handoff redesign deliberately replaced cards with the ledger. Out of scope (layout/IA). |
| Genre chips | bordered only, no fill (`border` + `--border`), `px-2.5 py-1` | preview `.tag` adds a `--surface2` fill | **no** | Handoff spec is bordered-only ("1px border `#2A2824`", no fill); preview's fill was superseded. Current matches the newer spec. |
| Sort tabs | mono 11px, active = gold text + 2px gold bottom-border | preview `.sort-btn` identical treatment | **no** | Already matches. |
| Loading scan bar | 240px hairline, gold gradient sweep, 1.9s linear | preview 200px; handoff 240px/1.9s | **no** | Current matches the newer handoff (240px/1.9s). |
| Discovery Matrix (2-D, dot size = obscurity) | implemented per handoff | preview has no matrix (single-axis) / faint-field has a 1-D magnitude plot | **no** | Current is the newest, richest version; nothing better to port. |
| `::selection` styling | `--surface2` (subtle) | not defined in any reference | **no** | Not present in the audited references; a selection-color change would be un-sourced. Left as-is. |
| Faint-field aesthetic (starfield, grain, reticle cursor, blue palette, Bodoni/Hanken/Spline fonts, RA-Dec chrome, `--ease` curve, hover row gold bar, button lift) | n/a | `design-faint-field.html` | **no** | Divergent design language; adopting any piece is an aesthetic/IA change, not low-risk polish. Reference only. |

## Ported (the "yes" rows)

1. **`--accent-bright: #D9A441`** added to `frontend/src/app/globals.css` `:root` and
   registered as `accent-bright` in `frontend/tailwind.config.ts` — closes a real
   gap between the authoritative handoff token table and the code.
2. **Hover-brighten gold text** to `--accent-bright` on the bordered-gold-button
   family, via `onMouseEnter`/`onMouseLeave` (same pattern already used for the
   ArtistCard link border), with `transition-colors` so it eases:
   - `frontend/src/components/ArtistCard.tsx` — listen/find link text.
   - `frontend/src/components/EmptyState.tsx` — "check my setup" button.
   - `frontend/src/components/ApiKeyModal.tsx` — "save" / "clear" button.

Everything else in the table is **no** — the live UI already implements the
newer handoff spec, and the faint-field concept is out of scope for a low-risk
polish pass.

## No-regression checklist (verified after the change, 1440px + 390px)

- Empty (fresh + short-window), Error, Loading, Onboarding states render.
- Discovery appetite slider drags on desktop + mobile.
- ShareCard PNG export unaffected (its inline hexes were **not** touched).
- "view more" still expands to the full set (up to 25).
- Mobile responsive layout intact at 390px.

See the `after-*.png` screenshots saved next to this doc.
