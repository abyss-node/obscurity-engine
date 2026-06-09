# Obscurity Engine — Design System

Single warm-dark theme. Scientific instrument, not a SaaS product. Taste treated as intelligence.

---

## Core Principles

- **One theme only.** Dark, warm, permanent. No light mode, no toggle.
- **Weight hierarchy, not tracking.** No ALL-CAPS with letter-spacing as a design move. Size and weight carry hierarchy.
- **Prose over dashboards.** Numbers earn their place. Where possible, translate data to language.
- **No decorative chrome.** No backdrop-blur, no radial gradient overlays, no colored glows, no rounded bubbly cards.

---

## Color System

```css
:root {
  --bg:        #080806;   /* page background */
  --surface:   #111110;   /* card / elevated surface */
  --surface2:  #1A1916;   /* nested surface / hover */
  --border:    #2A2824;   /* dividers, card borders */
  --text:      #EDE8DC;   /* primary text */
  --muted:     #7A7265;   /* secondary / supporting text */
  --dim:       #4A4640;   /* tertiary / labels / very quiet text */
  --accent:    #B8832E;   /* gold — brand, active states, cross-validated badge */
  --accent2:   #8B5E2A;   /* gold darker — hover on accent, secondary accent use */
  --discovery: #8B3A2A;   /* rust/terracotta — error states, rare emphasis */
}
```

**Usage rules:**
- `--accent` gold is used sparingly: branding in header, active period pill border/text, DUAL SIGNAL badge, depth score number, `[ERR]` prefix color.
- `--discovery` rust is error-only. Do not use for emphasis.
- `--dim` is the floor. Never go lower contrast than `--dim` on `--bg`.
- No gradients as decoration. The background is flat `--bg`.

---

## Typography

### Fonts

```
Display / headings:  Playfair Display — Google Fonts
Data / mono:         IBM Plex Mono    — Google Fonts  
Body / prose:        IBM Plex Serif   — Google Fonts
```

**Next.js font loading** (`layout.tsx`):
```ts
import { Playfair_Display, IBM_Plex_Mono, IBM_Plex_Serif } from 'next/font/google'
```

### Scale

| Role | Font | Size | Weight | Color |
|------|------|------|--------|-------|
| App name / header brand | Playfair Display | 15px | 600 | `--accent` |
| Landing title | Playfair Display | 64px (mobile: 40px) | 700 | `--text` |
| Landing subtitle | IBM Plex Mono | 11px | 400 | `--muted` |
| Depth assessment score (number) | Playfair Display | 80px (mobile: 56px) | 700 italic | `--accent` |
| Depth assessment prose | IBM Plex Serif | 18px | 300 italic | `--muted` |
| Artist name — hero card | Playfair Display | 36px (mobile: 28px) | 600 | `--text` |
| Artist name — regular card | Playfair Display | 22px | 600 | `--text` |
| Tag label | IBM Plex Mono | 11px | 400 | `--muted` |
| Data values (conviction, stickiness) | IBM Plex Mono | 16px | 400 | `--text` |
| Section labels | IBM Plex Mono | 10px | 400 | `--dim` |
| Error / system copy | IBM Plex Mono | 11px | 400 | `--discovery` |
| Body min | IBM Plex Mono | 13px | 400 | — |

**Letter-spacing:** Use only on 10px and smaller labels: `0.08–0.12em`. Never on headings or body text.

---

## Layout

- **Max content width:** 960px, centered, 48px horizontal padding (mobile: 16px).
- **Fixed top bar height:** 48px. Present only in results view.
- **Section spacing:** 64px vertical gap between major sections.
- **Card padding:** 24px (regular), 40px (hero card).

---

## Pages & States

### Landing

Blank page. Nothing above the fold except:
1. Small "OBSCURITY ENGINE" wordmark — Playfair Display 13px `--accent`, top-left corner, fixed.
2. Vertically centered input field: `border-b-2` `border-[--border]`, no background, IBM Plex Mono 28px, `--text` color.
3. Placeholder: `enter last.fm username` — all lowercase, `--dim`.
4. Submit button: text-only, IBM Plex Mono 11px `--muted`, appears only when input has value. No background, no border.

No hero copy. No subtitle. No "Execute Analysis" button with a big CTA style. The input IS the call to action.

### Loading State

```
[gradient scan bar — 180px wide, 1px tall, --accent tint]
calibrating sonar...       ← IBM Plex Mono 11px --muted, lowercase
[3s delay] waking up — this may take a moment    ← IBM Plex Mono 10px --dim
```

- Gradient scan: framer-motion left-to-right sweep, `--accent` at center fading to transparent on both sides.
- No progress rings. No percentage. The scan communicates "working," not "how much."

### Results — Order

```
[Fixed top bar]
  ← username (click to reset)    [period pills]    [share]

[Depth Assessment Block]  — fades in at 0ms delay
  Large italic score number (Playfair Display, gold)
  Prose description (IBM Plex Serif italic, muted)

[Iceberg / Sonar Map]  — fades in at 200ms delay
  (collapsible, open by default, label: "sonar map")

[Artist List]  — cards stagger in at 400ms + 50ms per card
```

### Depth Assessment Block

Score + prose computed client-side from `depth_score` and `top_genres[0]`:

```
depth_score >= 85  →  "collector-grade"
depth_score >= 70  →  "devoted listener"
depth_score >= 55  →  "adventurous"
depth_score >= 40  →  "eclectic"
depth_score <  40  →  "wide listener"
```

Genre modifier appended based on `top_genres[0].name` (if it exists and weight > 10%):
`"collector-grade" + ", " + genre_name` → `"collector-grade, black metal focus"`

Display as:
```
[score number]
[prose string in italic IBM Plex Serif]
```

### Fixed Top Bar (results view only)

Height: 48px. Background: `--surface`. Bottom border: `1px solid --border`.

```
[username — Playfair Display 13px --text, click to reset]   [7D 1M 3M 6M 1Y ALL]   [↑ SHARE]
```

Period pills: IBM Plex Mono 10px. Active: `--accent` text + `--accent` border. Inactive: `--dim` text + `--border` border.

Mobile (< 640px): period pills wrap to 3×2 grid. Bar height expands accordingly.

### Artist Cards

No background glow. No backdrop-blur. No rounded corners.

```
Surface: --surface
Border:  1px solid --border
Padding: 24px (regular), 40px (hero)
Border-radius: 0
```

**Hero card** (rank 1):
- Artist name: Playfair Display 36px 600 `--text`
- Top tag: IBM Plex Mono 11px `--muted`
- Expanded on click: conviction / stickiness / genre fit data in IBM Plex Mono + Last.fm link

**Regular cards:**
- Artist name: Playfair Display 22px 600 `--text`
- Rank: IBM Plex Mono 10px `--dim`, right-aligned, `/01` format
- Top tag: IBM Plex Mono 10px `--muted`

**DUAL SIGNAL badge** (cross_validated = true):
```
IBM Plex Mono 9px
border: 1px solid --accent
color: --accent
text: "DUAL SIGNAL"
padding: 2px 6px
```

### Error State

```
IBM Plex Mono 11px
color: --discovery (#8B3A2A)
text: "[ERR] SONAR_FAILURE — {message}"

Retry button: IBM Plex Mono 10px, border --discovery/40, text --discovery
```

### Low Data Warning

```
border: 1px solid --border
background: --surface
IBM Plex Mono 10px --muted
text: "[WARN] {message}"
```

---

## Responsive Breakpoints

| Breakpoint | Width | Changes |
|------------|-------|---------|
| Mobile | < 640px | Period pills: 3×2 grid. Typography scale down (see table above). Content padding: 16px. |
| Tablet | 640–960px | Full single-row period pills. Standard padding (32px). |
| Desktop | > 960px | Max-width 960px centered, 48px padding. |

**Touch targets:** 44px minimum height for all interactive elements (period pills, retry button, share button, card tap area).

---

## Animations / Motion

| Element | Animation | Spec |
|---------|-----------|------|
| Landing → loading transition | opacity fade | 0.3s ease |
| Loading → results | staged fade-in | depth block: 0ms, iceberg: 200ms, artist cards: 400ms + 50ms stagger |
| Artist card stagger | framer-motion `variants` | `hidden: { opacity: 0, y: 16 }` → `visible: { opacity: 1, y: 0 }`, spring, stiffness 80, damping 20 |
| Loading scan bar | framer-motion `x` | left-to-right, repeat Infinity, duration 2s, ease linear |
| Card expand (click) | framer-motion `height` | auto, duration 0.35s |
| Active period pill | CSS transition | `color`, `border-color`, 0.15s ease |

No entrance animations on the landing page. It appears immediately.

