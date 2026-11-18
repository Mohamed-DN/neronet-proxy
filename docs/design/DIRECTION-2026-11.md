# Design direction: the network as a transit map (November 2026)

Status: accepted, implemented in waves. Supersedes the visual parts of `docs/design/README.md` where
they differ; the system rules there (tokens only, status is colour + shape + word, five data states,
"Not measured" never shown as zero) stay.

## Why a transit map

Every mesh VPN console looks the same: a left rail, a grey table, a blue button, green and grey
dots. NeroNet's subject already has a visual language people read without training: a network of
lines and stations. A device is a **station**, a gateway is an **interchange**, an exit to the
internet is a **terminus**, a relay is a **change of line**, a sub-network is a **line** with its
own colour. Transit diagrams are also a model of clarity under density: few typefaces, flat colour,
45° geometry, labels set horizontally, status announced in words ("in service", "interrupted").

The map is the product's memorable thing. Everything around it stays quiet: signage, not decoration.

## Tokens

Colour (light / dark), named by role:

| Role | Light | Dark | Use |
|---|---|---|---|
| sheet | `#F2F4F3` | `#0E1A22` | page background (cool, never cream) |
| plate | `#FFFFFF` | `#16252F` | raised surfaces: panels, dialogs |
| ink | `#15232D` | `#E8EEF0` | text, primary buttons (ink plates with sheet text) |
| ink-muted | `#4E5D66` | `#A3B3BA` | secondary text (≥ 4.5:1 on sheet and plate) |
| rule | `#C9D2D6` | `#2E4250` | borders, dividers, map grid |
| signal | `#F5C211` | `#F5C211` | one accent: focus ring, "you are here", the selected station |

Lines (categorical, sub-networks and groups only, never status): `#D1495B` red, `#1E7F6D` green,
`#2B59C3` blue, `#E08E0B` orange, `#7B4BB7` violet, `#3D8FB8` sky. Each passes 3:1 against sheet
and plate as a line colour; labels are always ink, never coloured text.

Status keeps success / warning / danger / info, but is always colour **and** shape **and** word:
station symbols are a filled ring (in service), a hollow ring (not measured), a ring with a bar
(blocked), a dashed ring (interrupted). Never a bare dot.

Type: **Overpass** (variable, OFL), the open typeface derived from highway signage, for everything;
**Overpass Mono** for keys, addresses and codes only, self-hosted from the `@fontsource-variable`
packages with their licence files. One family, two cuts. Scale (rem, 16px root):
0.75 caption, 0.875 body, 1 lead, 1.25 title, 1.75 page title, 2.5 the single overview figure.
Sentence case everywhere, no tracked caps, no eyebrows. Line length ≤ 75 characters in prose.

Shape: plates 8px (enamel signage plates), controls 4px, 999px only for station symbols and
toggles. No drop shadows on plates; a 1px rule. One shadow token for overlays only. (A first draft
used 2px everywhere with hairline rules; that reads as the generic broadsheet look, so plates got
the rounded corners of real station signs.)

Motion: one moment only, the map drawing its lines on first load (respecting reduced motion).
Interaction motion only where it shows a change (a panel opening, a station selected).

## Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ NeroNet   Rete  Accesso  Sicurezza  Impostazioni        ⌕   tu ▾     │  top bar: 4 task groups
├──────────────────────────────────────────────────────────────────────┤
│  Rete › Mappa                                                       │
│  ┌────────────────────────────────────────────┐ ┌─────────────────┐  │
│  │   the map (transit diagram of the mesh)    │ │ station panel   │  │
│  │                                            │ │ (selected item) │  │
│  └────────────────────────────────────────────┘ └─────────────────┘  │
│  12 dispositivi in servizio, uno interrotto, nessuno bloccato.       │
└──────────────────────────────────────────────────────────────────────┘
```

- The left rail goes. A top bar with four task groups: **Rete** (Mappa, Dispositivi, Sotto-reti,
  Gateway e uscite), **Accesso** (Regole, Persone, Inviti, Federazione), **Sicurezza** (Rischio,
  Registro, Cancellazione dei dati), **Impostazioni**. Members never see admin groups; their portal
  is a separate, single-column space.
- Pages are left-aligned on a 12-column grid, max 1360px. Lists and tables stay where scanning
  rows is the job (Dispositivi, Registro), set in signage rhythm: generous row height, station
  symbol first, name in ink, everything else muted.
- The overview **is** the map, with one sentence of status under it, not a wall of stat cards.

## Words

One name per thing, everywhere: **dispositivo** (never nodo), **gateway**, **uscita**,
**sotto-rete**, **organizzazione**, **bloccato** (never isolato / in quarantena),
**cancellazione dei dati** (never autodistruzione), **Rimuovi i filtri**. Status words follow the
map: *in servizio*, *interrotto*, *non misurato*, *bloccato*. End users never see: key, CIDR,
endpoint, handshake, gateway, wstunnel, port.

## Three sizes, three designs

The admin console works at every width; each size has its own layout, not a squeezed desktop.

- **Desktop (≥ 1280px):** the top bar with the four groups, 1360px pages, full tables, dialogs.
- **Tablet (768–1279px), the iPad layout:** master–detail. A list on the left (devices, rules,
  people) and the selected item's detail on the right in the same view instead of a dialog; the four
  groups become a segmented tab row under the wordmark; touch targets ≥ 44px; hover-only affordances
  have a visible equivalent.
- **Phone (< 768px):** a bottom tab bar with the four groups (icon + word), reachable by thumb, and
  the account at the top right. Pages are one column; tables become station rows (symbol, name, one
  muted line) that open a full-screen detail; secondary actions live in a bottom sheet; the page's
  primary action sits in a sticky bar above the tab bar. The overview map turns vertical, like the
  poster of a single line on a station wall (after the map animation work lands).

No size blocks the console any more; the "use a wider window" screen goes.

## Waves

1. Tokens, Overpass, the top bar and the new information architecture; contrast gate extended to
   tints and hover surfaces; focus indicator fixes (a11y audit).
2. The map as overview; Dispositivi in signage rhythm; station symbols in every status.
3. The member portal: platform first, one primary action per screen, "waiting for your phone →
   connected", no jargon.
4. Terminology pass across all namespaces (it + en) after the functional fixes land.
