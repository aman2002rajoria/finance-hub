import type { Config } from "tailwindcss";

/*
 * Finance Hub design tokens (design.md §3–§5, §22), light + dark.
 *
 * Every colour is a CSS variable holding "R G B" channels, defined in
 * globals.css for :root (light) and [data-theme="dark"]. Using
 * `rgb(var(--c-x) / <alpha-value>)` keeps opacity modifiers working
 * (`bg-accent-500/20`) and makes every class follow the theme.
 *
 * The palette REPLACES Tailwind's defaults so stock blues and greys
 * can't creep in.
 */

const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const neutral = {
  bg: v("bg"),
  card: v("card"),
  surface: v("surface"),
  "surface-2": v("surface-2"),
  line: v("line"),
  ink: v("ink"),
  "ink-2": v("ink-2"),
  muted: v("muted"),
  faint: v("faint"),
};

const accent = {
  50: v("accent-50"),
  100: v("accent-100"),
  200: v("accent-200"),
  500: v("accent-500"),
  600: v("accent-600"),
  700: v("accent-700"),
  900: v("accent-900"),
  DEFAULT: v("accent-500"),
};

const success = { DEFAULT: v("success"), text: v("success-text"), tint: v("success-tint") };
const warning = { DEFAULT: v("warning"), text: v("warning-text"), tint: v("warning-tint") };
const danger = { DEFAULT: v("danger"), text: v("danger-text"), tint: v("danger-tint") };

const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#FFFFFF",
      black: "#000000",
      ...neutral,
      accent,
      success,
      warning,
      danger,
      // Data series (design.md §3.4): identical in both themes.
      data: {
        1: "#7C5CFF",
        2: "#00B86B",
        3: "#FF5A1F",
        4: "#E54B8C",
        5: "#00A3BF",
        6: "#FFB020",
        7: "#2F6BFF",
        other: "#A1A1A8",
      },
      // Legacy aliases from the old dark theme, remapped onto the new tokens.
      canvas: neutral.bg,
      fog: neutral.bg,
      elevated: neutral.surface,
      mist: neutral.surface,
      silver: neutral.line,
      border: { DEFAULT: neutral.line, light: neutral["surface-2"] },
      midnight: neutral.ink,
      dusk: neutral["ink-2"],
      subtle: neutral.muted,
      smoke: neutral.muted,
      negative: danger.text,
      info: neutral["ink-2"],
      hyacinth: neutral["ink-2"],
      electric: accent[700],
      cornflower: accent[700],
    },
    borderRadius: {
      none: "0",
      sm: "12px",
      DEFAULT: "12px",
      md: "12px",
      lg: "12px",
      s: "12px",
      m: "20px",
      l: "28px",
      xl: "32px",
      card: "20px",
      panel: "28px",
      full: "9999px",
      pill: "9999px",
    },
    boxShadow: {
      none: "none",
      flat: "var(--shadow-flat)",
      float: "var(--shadow-float)",
      lift: "var(--shadow-lift)",
      DEFAULT: "var(--shadow-flat)",
      sm: "var(--shadow-flat)",
      card: "var(--shadow-flat)",
      "card-nested": "none",
      md: "var(--shadow-float)",
      lg: "var(--shadow-float)",
      "card-md": "var(--shadow-float)",
      nav: "var(--shadow-float)",
      btn: "none",
      inset: "none",
    },
    fontFamily: {
      sans: ["var(--font-fira)", "system-ui", "sans-serif"],
      mono: ["var(--font-mono)", "ui-monospace", "monospace"],
    },
    fontWeight: {
      normal: "400",
      medium: "500",
      semibold: "600",
      bold: "800",
      extrabold: "800",
      black: "900",
    },
    extend: {
      fontSize: {
        display: ["56px", { lineHeight: "1.04", letterSpacing: "-0.01em" }],
        h1: ["40px", { lineHeight: "1.08", letterSpacing: "-0.01em" }],
        h2: ["28px", { lineHeight: "1.15", letterSpacing: "-0.005em" }],
        h3: ["20px", { lineHeight: "1.25" }],
        "body-l": ["19px", { lineHeight: "1.5" }],
        eyebrow: ["12px", { lineHeight: "1.2", letterSpacing: "0.08em" }],
        number: ["32px", { lineHeight: "1", letterSpacing: "-0.01em" }],
        badge: ["11px", { lineHeight: "1.2", letterSpacing: "0.04em" }],
        xs: ["13px", { lineHeight: "1.4" }],
        sm: ["14px", { lineHeight: "1.45" }],
        base: ["16px", { lineHeight: "1.5" }],
        micro: ["12px", { lineHeight: "1.3" }],
        tag: ["12px", { lineHeight: "1.3" }],
        caption: ["13px", { lineHeight: "1.4" }],
        "label-sm": ["13px", { lineHeight: "1.3" }],
        body: ["15px", { lineHeight: "1.5" }],
        "body-sm": ["14px", { lineHeight: "1.45" }],
        "body-md": ["16px", { lineHeight: "1.5" }],
        "card-title": ["19px", { lineHeight: "1.25" }],
        subheading: ["20px", { lineHeight: "1.25" }],
        section: ["26px", { lineHeight: "1.15", letterSpacing: "-0.005em" }],
        heading: ["36px", { lineHeight: "1.08", letterSpacing: "-0.01em" }],
        "heading-sm": ["28px", { lineHeight: "1.15", letterSpacing: "-0.005em" }],
        "page-title": ["40px", { lineHeight: "1.08", letterSpacing: "-0.01em" }],
        "metric-lg": ["32px", { lineHeight: "1", letterSpacing: "-0.01em" }],
        "metric-md": ["28px", { lineHeight: "1", letterSpacing: "-0.01em" }],
      },
      maxWidth: {
        page: "1320px",
        "page-lg": "1320px",
        "page-xl": "1320px",
        reading: "720px",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(.22,1,.36,1)",
        soft: "cubic-bezier(.22,1,.36,1)",
        spring: "var(--spring)",
      },
      transitionDuration: {
        DEFAULT: "200ms",
      },
    },
  },
  plugins: [],
};
export default config;
