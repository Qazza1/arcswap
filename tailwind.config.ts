import type { Config } from "tailwindcss";

const config: Config = {
  // ── Dark mode: forced via class on <html> ──────────────────
  darkMode: "class",

  // ── Scan all HTML and TS files for class names ─────────────
  content: [
    "./*.html",
    "./src/**/*.{ts,js}",
    "./node_modules/preline/preline.js",
  ],

  theme: {
    extend: {
      // ── Brand colors ───────────────────────────────────────
      colors: {
        // Primary — solid professional blue (no neon)
        brand: {
          DEFAULT:  "#2563eb", // blue-600
          hover:    "#1d4ed8", // blue-700
          muted:    "#1e3a8a", // blue-900
          dim:      "rgba(37, 99, 235, 0.1)",
        },

        // Success — muted emerald (not neon green)
        success: {
          DEFAULT:  "#059669", // emerald-600
          muted:    "#064e3b", // emerald-900
          dim:      "rgba(5, 150, 105, 0.1)",
        },

        // Warning — amber, used sparingly
        warning: {
          DEFAULT:  "#d97706", // amber-600
          dim:      "rgba(217, 119, 6, 0.1)",
        },

        // Danger
        danger: {
          DEFAULT:  "#dc2626", // red-600
          dim:      "rgba(220, 38, 38, 0.1)",
        },

        // ── App surface colors (Slate/Zinc scale) ─────────────
        surface: {
          base:     "#0a0a0f", // deepest background
          DEFAULT:  "#0f1117", // primary background
          raised:   "#161b27", // cards, panels
          overlay:  "#1c2333", // dropdowns, modals
          border:   "#1e2a3a", // subtle borders
          "border-strong": "#2d3a50", // visible borders
        },

        // ── Text scale ────────────────────────────────────────
        ink: {
          DEFAULT:  "#e2e8f0", // slate-200 — primary text
          muted:    "#64748b", // slate-500 — secondary text
          subtle:   "#334155", // slate-700 — placeholder
          inverted: "#0f1117", // text on light backgrounds
        },
      },

      // ── Typography ─────────────────────────────────────────
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },

      // ── Border radius — flat enterprise feel ───────────────
      borderRadius: {
        none: "0",
        sm:   "0.25rem",  // 4px
        DEFAULT: "0.375rem", // 6px
        md:   "0.5rem",   // 8px
        lg:   "0.625rem", // 10px — max we use
        xl:   "0.75rem",  // 12px — modals only
        full: "9999px",   // pills/badges
      },

      // ── Spacing — 4pt grid ─────────────────────────────────
      spacing: {
        "4.5": "1.125rem",
        "13":  "3.25rem",
        "15":  "3.75rem",
        "18":  "4.5rem",
        "22":  "5.5rem",
      },

      // ── Box shadows — subtle, no glow ─────────────────────
      boxShadow: {
        sm:  "0 1px 2px 0 rgba(0,0,0,0.4)",
        DEFAULT: "0 2px 8px 0 rgba(0,0,0,0.4)",
        md:  "0 4px 16px 0 rgba(0,0,0,0.5)",
        lg:  "0 8px 32px 0 rgba(0,0,0,0.6)",
        none: "none",
      },

      // ── Typography scale ───────────────────────────────────
      fontSize: {
        "2xs": ["0.625rem",  { lineHeight: "0.875rem" }],
        xs:    ["0.75rem",   { lineHeight: "1rem" }],
        sm:    ["0.8125rem", { lineHeight: "1.25rem" }],
        base:  ["0.875rem",  { lineHeight: "1.5rem" }],
        md:    ["0.9375rem", { lineHeight: "1.5rem" }],
        lg:    ["1rem",      { lineHeight: "1.5rem" }],
        xl:    ["1.125rem",  { lineHeight: "1.75rem" }],
        "2xl": ["1.25rem",   { lineHeight: "1.75rem" }],
        "3xl": ["1.5rem",    { lineHeight: "2rem" }],
        "4xl": ["1.875rem",  { lineHeight: "2.25rem" }],
        "5xl": ["2.25rem",   { lineHeight: "2.5rem" }],
      },

      // ── Letter spacing ─────────────────────────────────────
      letterSpacing: {
        tightest: "-0.04em",
        tighter:  "-0.02em",
        tight:    "-0.01em",
        normal:   "0em",
        wide:     "0.04em",
        wider:    "0.08em",
        widest:   "0.12em",
      },
    },
  },

  plugins: [
    // Preline UI for interactive components
    require("preline/plugin"),
  ],
};

export default config;
