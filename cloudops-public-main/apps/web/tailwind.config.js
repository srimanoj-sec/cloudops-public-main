/**
 * CloudOps design tokens → Tailwind.
 *
 * Every colour is a CSS variable holding an RGB triplet (see src/styles/index.css),
 * so opacity modifiers work (`bg-accent/12`) and a second theme is a variable swap.
 * Use these semantic names — never raw palette colours — in components.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: token('surface'),
        raised: token('raised'),
        overlay: token('overlay'),
        hover: token('hover'),
        line: {
          DEFAULT: token('line'),
          subtle: token('line-subtle'),
          strong: token('line-strong'),
        },
        fg: {
          DEFAULT: token('fg'),
          secondary: token('fg-secondary'),
          muted: token('fg-muted'),
          faint: token('fg-faint'),
        },
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          active: token('accent-active'),
          fg: token('accent-fg'),
        },
        success: token('success'),
        warning: token('warning'),
        danger: token('danger'),
        info: token('info'),
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // [size, { lineHeight, letterSpacing, fontWeight }]
        display: ['2rem', { lineHeight: '2.5rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        h1: ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.015em', fontWeight: '600' }],
        h2: ['1.125rem', { lineHeight: '1.625rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        h3: ['0.9375rem', { lineHeight: '1.375rem', letterSpacing: '-0.005em', fontWeight: '600' }],
        h4: ['0.875rem', { lineHeight: '1.25rem', fontWeight: '600' }],
        'body-lg': ['0.9375rem', { lineHeight: '1.5rem' }],
        body: ['0.875rem', { lineHeight: '1.25rem' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.125rem' }],
        caption: ['0.75rem', { lineHeight: '1rem' }],
        label: ['0.75rem', { lineHeight: '1rem', fontWeight: '500' }],
        overline: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.08em', fontWeight: '500' }],
        readout: ['1.75rem', { lineHeight: '2rem', letterSpacing: '-0.02em', fontWeight: '500' }],
        'readout-sm': ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em', fontWeight: '500' }],
      },
      borderRadius: {
        xs: '4px', // badges, chips, inline code
        sm: '6px', // buttons, inputs, menu items
        md: '8px', // panels, cards, popovers
        lg: '12px', // dialogs, large containers
      },
      boxShadow: {
        // Elevation: 0 = flat on canvas, 1 = panel, 2 = popover/menu, 3 = dialog/toast.
        1: '0 1px 2px rgb(0 0 0 / 0.24)',
        2: '0 8px 24px -4px rgb(0 0 0 / 0.5), 0 2px 6px rgb(0 0 0 / 0.3)',
        3: '0 24px 64px -12px rgb(0 0 0 / 0.65), 0 4px 12px rgb(0 0 0 / 0.35)',
      },
      spacing: {
        sidebar: '232px',
        rail: '60px',
        topbar: '52px',
      },
      maxWidth: {
        page: '1600px',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'dialog-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(-4px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'drawer-in': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
        'signal-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out both',
        'dialog-in': 'dialog-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'pop-in': 'pop-in 140ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'drawer-in': 'drawer-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'toast-in': 'toast-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
        shimmer: 'shimmer 1.6s linear infinite',
        'signal-pulse': 'signal-pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
