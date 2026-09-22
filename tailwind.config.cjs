/** @type {import('tailwindcss').Config} */
const v = (name) => `hsl(var(--${name}) / <alpha-value>)`;

module.exports = {
  darkMode: ['class'],
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /*
       * Midnight Aurora. Every colour is named for its role and resolves to a
       * variable in styles/globals.css, so the palette lives in one place.
       */
      colors: {
        // The dark application shell: title strip and sidebar.
        shell: {
          DEFAULT: v('shell'),
          deep: v('shell-deep'),
          hover: v('shell-hover'),
          active: v('shell-active'),
          raised: v('shell-raised'),
          line: v('shell-line'),
        },
        // Text on the shell. (Kept under the old name so sidebar code reads the same.)
        ink: {
          DEFAULT: v('shell-text'),
          soft: v('shell-text-soft'),
          muted: v('shell-text-muted'),
          faint: v('shell-text-faint'),
        },
        // The light working surfaces.
        canvas: v('canvas'),
        surface: v('surface'),
        subtle: v('subtle'),
        // Older names for the quiet fill inside light surfaces.
        sidebar: v('subtle'),
        'surface-raised': v('subtle'),
        line: {
          DEFAULT: v('line'),
          strong: v('line-strong'),
        },
        primary: {
          DEFAULT: v('primary'),
          hover: v('primary-hover'),
          muted: v('primary-muted'),
          ink: v('primary-ink'),
          foreground: v('on-primary'),
        },
        ai: {
          DEFAULT: v('ai'),
          ink: v('ai-ink'),
          muted: v('ai-muted'),
        },
        content: {
          DEFAULT: v('text'),
          strong: v('text-strong'),
          muted: v('text-muted'),
          faint: v('text-faint'),
        },
        accent: v('accent'),
        success: { DEFAULT: v('success'), ink: v('success-ink') },
        warning: { DEFAULT: v('warning'), ink: v('warning-ink') },
        danger: { DEFAULT: v('danger'), ink: v('danger-ink') },
      },
      borderRadius: {
        '2xl': '14px', // application window
        xl: '12px', // panels, composer, dialogs
        lg: '10px',
        md: '8px', // buttons, inputs
        sm: '6px', // reaction pills, chips
      },
      boxShadow: {
        panel: '0 0 0 1px rgb(2 6 16 / 0.35), 0 10px 30px -14px rgb(2 6 16 / 0.55)',
        composer: '0 1px 2px rgb(15 23 42 / 0.04)',
        'composer-focus': '0 0 0 3px hsl(var(--primary) / 0.16)',
        popover: '0 0 0 1px rgb(15 23 42 / 0.06), 0 8px 24px -8px rgb(15 23 42 / 0.2)',
        dialog: '0 0 0 1px rgb(15 23 42 / 0.06), 0 24px 64px -20px rgb(15 23 42 / 0.4)',
        focus: '0 0 0 3px hsl(var(--primary) / 0.16)',
      },
      fontFamily: {
        // Colour emoji fonts sit right after Inter: otherwise Windows reaches
        // Segoe UI first and draws emoji as tinted monochrome symbols.
        sans: [
          'Inter Variable',
          'Inter',
          'Apple Color Emoji',
          'Segoe UI Emoji',
          'Noto Color Emoji',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'sans-serif',
        ],
        emoji: ['Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'sans-serif'],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Cascadia Mono',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      // The type scale: labels 11, secondary 12, navigation and names 13,
      // message body 13.5, titles 15.
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }],
        xs: ['12px', { lineHeight: '16px' }],
        nav: ['13px', { lineHeight: '20px' }],
        body: ['13.5px', { lineHeight: '20px' }],
        title: ['15px', { lineHeight: '20px' }],
      },
      letterSpacing: {
        label: '0.06em',
      },
      transitionDuration: {
        fast: '120ms',
        base: '180ms',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
      },
      zIndex: {
        header: '10',
        dropdown: '30',
        overlay: '50',
        toast: '60',
        tooltip: '70',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(3px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'message-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(4px) scale(0.98)' },
          to: { opacity: '1', transform: 'none' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
        // A small halo that grows and fades from a status dot: "working".
        'pulse-ring': {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '80%, 100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        typing: {
          '0%, 60%, 100%': { opacity: '0.25', transform: 'translateY(0)' },
          '30%': { opacity: '1', transform: 'translateY(-1.5px)' },
        },
        flash: {
          '0%': { backgroundColor: 'hsl(var(--primary) / 0.14)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        'message-in': 'message-in 180ms cubic-bezier(0.2, 0.7, 0.3, 1)',
        'pop-in': 'pop-in 120ms ease-out',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.2, 0.7, 0.3, 1) infinite',
        typing: 'typing 1.2s ease-in-out infinite',
        flash: 'flash 1.6s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
