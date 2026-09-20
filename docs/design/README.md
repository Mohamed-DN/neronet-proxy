# The console design system

The console is a management tool for banks and public bodies. It is meant to be
sober, dense and calm: a screen an operator reads for eight hours, not a demo.
Data comes first, colour carries meaning and nothing else, and a figure that
was never measured says so.

Three files hold the system:

| File | What it holds |
|---|---|
| `console/frontend/src/styles/tokens.css` | Every colour, space, radius, elevation, type size and z-index, as custom properties, in a light and a dark set. |
| `console/frontend/tailwind.config.js` | The mapping from a Tailwind utility to a token. Nothing here invents a value. |
| `console/frontend/src/ui/` | The primitives. Controls, surfaces, overlays and the states below. |

[`tokens.md`](tokens.md) is generated from the token file by
`scripts/design/contrast.mjs` and lists every colour pair with its measured
contrast ratio. Run it after any token change:

```sh
node scripts/design/contrast.mjs          # report and gate, exits 1 below target
node scripts/design/contrast.mjs --write  # also regenerate tokens.md
```

## Rules

1. **No literal colours.** Not a hex, not a Tailwind palette shade. Every colour
   is a role: `bg-surface-raised`, `text-muted`, `border-border-strong`. A page
   that needs a colour the roles do not cover needs a new role, discussed, not a
   local exception.
2. **Colour means status, never decoration.** Green, amber, red and violet are
   reserved for `success`, `warning`, `danger` and `info`. Blue is the one
   accent: primary actions, links, selection. Nothing else is coloured.
3. **Status is colour, icon and word together.** Never colour alone. Use
   `StatusBadge`; it cannot be built without a word.
4. **Borders, not shadows.** Data surfaces are flat and separated by a border.
   A shadow means the thing floats above the page: a dialog, a menu, a toast.
5. **Numbers are tabular.** Every figure in a table or a metric lines up.
   Identifiers, addresses and keys are mono, through `CodeText`.
6. **Motion is functional.** It shows that something is loading or where a
   surface came from. Everything stops under `prefers-reduced-motion`.
7. **One focus ring.** `--color-focus`, applied by `:focus-visible` globally.
   Nothing removes an outline without drawing one of its own.

## The five states

Every surface that shows data can be in one of five states besides showing it.
They are different facts and must not blur into one another; the copy and the
colour of each are fixed by the primitives, not chosen per page.

| State | Meaning | Primitive | Role |
|---|---|---|---|
| loading | The request is in flight. Nothing is known yet. | `Skeleton`, plus a live region saying "Loading" | muted |
| empty | The request answered, and the answer is "none". | `EmptyState` | muted |
| error | The request failed. The operator can retry, and sees the real failure. | `ErrorState` | danger |
| not measured | The thing exists and no measurement of it has ever arrived. | `NotMeasured`, `Stat` with a `null` value, `StatusBadge status="not-measured"` | info |
| not implemented | The feature is absent, or behind a flag that is off. No amount of waiting produces data. | `NotImplementedState` | muted |

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

Inter for the interface, JetBrains Mono for anything a machine produced. Both
are served from this origin under the SIL Open Font Licence; the files and the
licence texts are in `console/frontend/public/fonts`. Only the Latin and Latin
Extended subsets are shipped, which cover English and Italian.

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
