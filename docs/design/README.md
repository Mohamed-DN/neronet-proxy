# The console design system

The console is a management tool for banks and public bodies. It is meant to be
sober, dense and calm: a screen an operator reads for eight hours, not a demo.
Data comes first, colour carries meaning and nothing else, and a figure that
was never measured says so.

Its look is the one in [`DIRECTION-2026-11.md`](DIRECTION-2026-11.md): the network
as a transit map. Where that file and this one differ on appearance (palette,
type, shape, layout), the direction wins; the system rules below (tokens only,
status is colour and shape and word, five data states, "not measured" is never
zero) are unchanged. This file describes what is built, wave by wave.

The [radial mesh topology](mesh-topology.md) describes how the network map
separates policy connections from observed paths and lists its current limits.

Three files hold the system:

| File                                     | What it holds                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `console/frontend/src/styles/tokens.css` | Every colour, space, radius, elevation, type size and z-index, as custom properties, in a light and a dark set. |
| `console/frontend/tailwind.config.js`    | The mapping from a Tailwind utility to a token. Nothing here invents a value.                                   |
| `console/frontend/src/ui/`               | The primitives. Controls, surfaces, overlays and the states below.                                              |

[`tokens.md`](tokens.md) is generated from the token file by
`scripts/design/contrast.mjs` and lists every colour pair with its measured
contrast ratio. Run it after any token change:

```sh
node scripts/design/contrast.mjs          # report and gate, exits 1 below target
node scripts/design/contrast.mjs --write  # also regenerate tokens.md
```

## Rules

1. **No literal colours.** Not a hex, not a Tailwind palette shade, not
   `bg-white`. Every colour is a role: `bg-plate`, `text-ink-muted`,
   `border-border-strong`. The new names are `sheet`, `plate`, `ink`,
   `ink-muted`, `rule`, `signal` and `line-*`; the older `surface`,
   `content`, `accent`, `border` and `focus` stay as aliases of them. A page
   that needs a colour the roles do not cover needs a new role, discussed, not a
   local exception. (`paper` exists because a QR code needs a white ground.)
2. **Colour means status, never decoration.** Green, amber, red and violet are
   reserved for `success`, `warning`, `danger` and `info`. The primary action
   is an ink plate with sheet text. The one yellow, the `signal`, marks the
   focus ring, "you are here" and the selected station, and is never text. The
   six line colours tell sub-networks and groups apart, never status, and their
   labels stay ink.
3. **Status is colour, shape and word together.** Never colour alone. The
   station symbols are a filled ring (in service), a hollow ring (not measured),
   a ring with a bar (blocked) and a dashed ring (interrupted). Use
   `StationStatus` (symbol and word); it cannot be built without a word. A
   status is never a pill and a number is never in a coloured box.
4. **Plates, not shadows.** A plate (panel, table body, dialog) is flat, 8px
   rounded and separated by a 1px rule. Controls are 4px. The one shadow token
   is for things that float above the page: a menu, a dialog, a toast. No
   gradients.
5. **Numbers are tabular.** Every figure in a table or a metric lines up.
   Identifiers, addresses and keys are mono, through `CodeText`.
6. **Motion is functional.** It shows that something is loading or where a
   surface came from. Everything stops under `prefers-reduced-motion`.
7. **One focus ring, two-tone.** `:focus-visible` draws a 2px ink band against
   the control and a 2px `signal` ring outside it (`.focus-ring` does the same
   where an outline would be clipped). The signal alone is 1.5:1 on the light
   sheet; the ink band is what holds 3:1 in both themes. A highlighted option in
   a Select or a menu draws the same pair inside its own box (`.option-ring`),
   because the hover tint is 1.1:1 against the plate. Nothing removes an outline
   without drawing one of its own.
8. **A busy button keeps focus.** `Button loading` is `aria-disabled`, not
   `disabled`, and swallows the click and the form submission: a keyboard user
   who pressed it does not lose their place.

## The five states

Every surface that shows data can be in one of five states besides showing it.
They are different facts and must not blur into one another; the copy and the
colour of each are fixed by the primitives, not chosen per page.

| State           | Meaning                                                                                  | Primitive                                                                      | Role   |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| loading         | The request is in flight. Nothing is known yet.                                          | `Skeleton`, plus a live region saying "Loading"                                | muted  |
| empty           | The request answered, and the answer is "none".                                          | `EmptyState`                                                                   | muted  |
| error           | The request failed. The operator can retry, and sees the real failure.                   | `ErrorState`                                                                   | danger |
| not measured    | The thing exists and no measurement of it has ever arrived.                              | `NotMeasured`, `Stat` with a `null` value, `StatusBadge status="not-measured"` | info   |
| not implemented | The feature is absent, or behind a flag that is off. No amount of waiting produces data. | `NotImplementedState`                                                          | muted  |

**Not measured is the one that matters.** The control plane knows about things
it has never measured: a node's disk encryption, a circuit count, a throughput
figure. This console has shown plausible constants in their place before. A
value that was not measured is `null` from the database to the screen, and is
drawn as the words "Not measured" in the reader's language - never as `0`,
never as a dash, never as a healthy green tick.

`stateOf(value)` in `src/ui/dataState.ts` classifies a value: `null`,
`undefined` and `NaN` are not measured; `0`, `''` and `false` are data.

`unknown` is a sixth thing and is not the same as not measured: a value
arrived and could not be classified. A node whose posture was never reported
is not a node with unknown posture.

## Station symbols and the map (wave 2)

`StationSymbol` (`src/ui/StationSymbol.tsx`) draws the six symbols in
`currentColor`: filled ring (in service), hollow ring (not measured), ring with a
bar (blocked), dashed ring (interrupted), rounded-square double ring (interchange,
a gateway) and ring with an outward tick (terminus, an exit). It is decorative
unless given a `label`, and sits beside a visible word. `StationStatus` pairs the
symbol, in its status colour, with the word in ink. The Devices table, the map
page's list, device panel and legend, and the top-bar status line use it.

The overview (`routes/pages/OverviewRoute.tsx`) is the map. `transitModel.ts`
turns the topology page's own inventory into lines (sub-networks, one of the six
line tokens each, by sorted key) and stations (a gateway is an interchange, an
exit a terminus, a device that is not in service takes its status symbol).
`charts/transitLayout.ts` is the pure geometry: horizontal, vertical and 45
degree segments only, labels above and below in turn, a long line wrapping with
45 degree chamfers, stations spread up to 128px apart when the map is sparse.
`charts/TransitMap.tsx` draws the lines as SVG and the stations as real buttons
over it, each named with its status in words. Above 60 devices each line is one
station with a count; a `details` list of every device is the fallback for a
screen reader. The lines draw themselves once on first load, only under
`prefers-reduced-motion: no-preference`. With one device or none the page shows
a single line and "Add a device".

`Segmented` is a radio group with arrow keys, Home and End, for one choice out of
a few (the Devices filter). `Table density="signage"` is the 52px row rhythm.

## The shell

There is no left rail. A top bar (`src/components/TopBar.tsx`) carries the
wordmark (it links to the overview), four task groups, search,
notifications and the account (which holds language and theme), and under them one line that says in words how
the network is doing:

| Group    | Pages                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| Network  | Map, Devices, Sub-networks, Virtual computers (only when its feature flag is on) |
| Access   | Rules, People, Federation                                                        |
| Security | Risk, Log, Data erasure, Three-stop routes                                       |
| Settings | a link, not a menu                                                               |

`src/routes/navModel.ts` is the only place the groups are defined. It reads
`services/roles.ts` (`ACCESS`), so a role never sees an entry for a page it
cannot use, and a group with nothing in it for a role is not drawn. The account
menu holds "My devices" (the member portal), "Send a file", the glossary and
sign-out. The armed data erasure and the blocked-device count are indicators in
the status line, each with its words.

The groups and the account are disclosure menus (`src/ui/Disclosure.tsx`, the
WAI-ARIA disclosure pattern for navigation): Enter or Space opens one, the arrow
keys, Home and End move through it, Escape closes it and returns focus to the
trigger, and a click outside or tabbing out closes it. Choosing a page closes it
and leaves focus to the page's own heading. The notifications panel is the same
component as a dialog. Radix menu and popover were tried first and cost 27 KB
gzip in the entry chunk, over the bundle budget, for what is a toggle, a list and
Escape.

The page title block (`PageHeader`) draws the breadcrumb the shell provides
("Network > Map"), so a page never spells out its own.

## Themes and density

Light and dark, both meeting WCAG 2.1 AA. The choice is light, dark, or
following the operating system, and it is kept per browser.

`public/theme-init.js` sets `data-theme` on the document before the first paint,
from the stored preference or `prefers-color-scheme`. It is a separate file and
not an inline script because the console is served under `script-src 'self'`.
`src/theme/ThemeProvider.tsx` owns the choice after that and reads the same
storage keys; the two must stay in step.

Table density is comfortable or compact, stored beside the theme.

## Typography

Overpass, the open typeface derived from highway signage, for everything;
Overpass Mono for keys, addresses and codes only (`CodeText`). Both are variable
fonts from the `@fontsource-variable` packages, bundled by Vite and served from
this origin under the SIL Open Font Licence; the licence texts are in
`console/frontend/public/fonts`. Only the Latin and Latin Extended subsets are
declared (`src/styles/fonts.css`), which cover English and Italian.

The scale is in rem on a 16px root: caption 0.75, body 0.875, lead 1, title
1.25, page title 1.75 and the single overview figure 2.5. The older `micro`,
`label`, `heading`, `display` and `metric` sizes resolve onto it, and nothing is
set below the caption: no `text-[10px]` or `text-[11px]`. Sentence case
everywhere: no uppercase transform, no tracked caps, no eyebrows. Prose lines
stay at 75 characters or fewer.

No font may be loaded from a third party. It would put the address of every
operator who opens the console in a foreign log, and the strict
`default-src 'self'` policy the console is served under blocks it anyway.

## Charts

`src/ui/tokens.ts` exposes the palette to code that needs a colour string or a
number rather than a class: Recharts and the three.js topology. Use
`chartSeries()`, `seriesColor(index)` and `chartRamp()`; do not write a hex into
a chart.

The eight categorical colours are checked in `CIE L*a*b*` under normal vision
and under simulated protanopia, deuteranopia and tritanopia, and each holds 3:1
against the plot surface. Eight colours cannot all be told apart by a dichromat
whatever the palette - the reference Okabe-Ito set fails the same check - so a
chart labels its series directly and never leaves the meaning in the colour.

## Internationalisation

Italian and English, through `react-i18next`, namespaced by area: `ui` for the
primitives, `chrome` for the shell, one namespace per page area as each is
translated. `document.documentElement.lang` follows the choice.

Numbers, dates, bytes, throughput and relative times go through the formatters
in `src/i18n/format.ts`, which wrap `Intl`. They return `null` for a missing
value, so the caller draws "not measured" rather than a formatted zero.

## Accessibility

WCAG 2.1 AA is the target, and parts of it are enforced rather than intended:

- `scripts/design/contrast.mjs` gates every colour pair, in both themes.
- `eslint-plugin-jsx-a11y` runs as an error over `src/ui`.
- Every primitive has a Vitest test that drives it from the keyboard and asserts
  on its accessible name, role and state, and is run through `axe-core` in both
  themes.
- A skip link is the first element in the tab order.

`scripts/design/contrast.mjs` gates 204 pairs per run across both themes: text
on the sheet, plate, wells and hover surfaces, every status colour on those and
on its `/10` and `/15` tints, line colours at 3:1, and the focus pairs. It
exits 1 on any miss.

The pages are not there yet. They carry the accessibility backlog measured on
2026-09-19 - eight ARIA attributes across twelve thousand lines - and each page
clears its own share in its own work package. The primitives exist so that the
clearing is a migration and not a rewrite.

## Looking at it

```sh
scripts/dev/start-console.sh    # or: cd console/frontend && npm run dev
```

Then open `/__design`. Every primitive, in every state, with the theme and
language switches at the top. The gallery is development-only: the guard in
`main.jsx` is statically false in a production build, so it is not in a bundle
an operator can load.
