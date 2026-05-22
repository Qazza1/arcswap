/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",

  content: [
    "./*.html",
    "./src/**/*.{ts,js}",
  ],

  safelist: ["hidden", "visible", "block", "flex", "grid"],

  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#2563eb",
          hover:   "#1d4ed8",
          dim:     "rgba(37,99,235,0.1)",
        },
        success: {
          DEFAULT: "#059669",
          dim:     "rgba(5,150,105,0.1)",
        },
        danger: {
          DEFAULT: "#dc2626",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },

  plugins: [],
};
