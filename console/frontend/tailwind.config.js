/** @type {import('tailwindcss').Config} */

/*
 * Every colour utility resolves to a custom property declared in
 * src/styles/tokens.css. The alpha placeholder keeps the modifier syntax
 * working, so bg-surface-raised/60 and border-accent/30 still mean what they
 * say while the underlying value changes with the theme.
 */
const token = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;

const status = (name) => ({
  DEFAULT: token(name),
  subtle: token(`${name}-subtle`),
  strong: token(`${name}-strong`),
  contrast: token(`${name}-contrast`)
});

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // public/theme-init.js sets the attribute before first paint, from the stored
  // preference or prefers-color-scheme.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: token('surface'),
          raised: token('surface-raised'),
          sunken: token('surface-sunken'),
          hover: token('surface-hover'),
          inverse: token('surface-inverse')
        },
        border: {
          DEFAULT: token('border'),
          subtle: token('border-subtle'),
          strong: token('border-strong')
        },
        content: {
          DEFAULT: token('content'),
          muted: token('content-muted'),
          subtle: token('content-subtle'),
          inverse: token('content-inverse')
        },
        // text-muted and text-subtle read better than text-content-muted at the
        // call site, and secondary text is the most frequent colour in the console.
        muted: token('content-muted'),
        subtle: token('content-subtle'),
        accent: {
          DEFAULT: token('accent'),
          subtle: token('accent-subtle'),
          strong: token('accent-strong'),
          contrast: token('accent-contrast')
        },
        success: status('success'),
        warning: status('warning'),
        danger: status('danger'),
        info: status('info'),
        focus: token('focus'),
        scrim: token('scrim'),
        chart: {
          1: token('chart-1'),
          2: token('chart-2'),
          3: token('chart-3'),
          4: token('chart-4'),
          5: token('chart-5'),
          6: token('chart-6'),
          7: token('chart-7'),
          8: token('chart-8')
        },
        ramp: {
          1: token('ramp-1'),
          2: token('ramp-2'),
          3: token('ramp-3'),
          4: token('ramp-4'),
          5: token('ramp-5'),
          6: token('ramp-6')
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Noto Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      fontSize: {
        micro: ['var(--font-size-micro)', { lineHeight: 'var(--line-height-tight)' }],
        caption: ['var(--font-size-caption)', { lineHeight: 'var(--line-height-normal)' }],
        label: ['var(--font-size-label)', { lineHeight: 'var(--line-height-normal)' }],
        body: ['var(--font-size-body)', { lineHeight: 'var(--line-height-normal)' }],
        heading: ['var(--font-size-heading)', { lineHeight: 'var(--line-height-tight)' }],
        title: ['var(--font-size-title)', { lineHeight: 'var(--line-height-tight)' }],
        display: ['var(--font-size-display)', { lineHeight: 'var(--line-height-tight)' }],
        metric: ['var(--font-size-metric)', { lineHeight: 'var(--line-height-tight)' }]
      },
      borderRadius: {
        control: 'var(--radius-control)',
        card: 'var(--radius-card)'
      },
      boxShadow: {
        raised: 'var(--elevation-raised)',
        overlay: 'var(--elevation-overlay)',
        popover: 'var(--elevation-popover)'
      },
      zIndex: {
        sticky: 'var(--z-sticky)',
        drawer: 'var(--z-drawer)',
        overlay: 'var(--z-overlay)',
        popover: 'var(--z-popover)',
        toast: 'var(--z-toast)'
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        DEFAULT: 'var(--duration-normal)'
      },
      keyframes: {
        // The only motion in the system: an indeterminate progress shimmer and a
        // slow pulse for "waiting on the network". Both stop under
        // prefers-reduced-motion, see src/index.css.
        'pulse-subtle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' }
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' }
        }
      },
      animation: {
        'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite',
        shimmer: 'shimmer 1.6s ease-in-out infinite'
      }
    }
  },
  plugins: []
};
