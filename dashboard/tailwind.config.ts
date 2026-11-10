import type { Config } from "tailwindcss";

// Colours are CSS variables (see globals.css) so light and dark share one set of classes.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"), surface: v("surface"), subtle: v("subtle"), line: v("line"), ink: v("ink"), muted: v("muted"),
        brand: { DEFAULT: v("brand"), soft: v("brand-soft"), ink: v("brand-ink") },
        ok: { DEFAULT: v("ok"), soft: v("ok-soft") }, warn: { DEFAULT: v("warn"), soft: v("warn-soft") },
        bad: { DEFAULT: v("bad"), soft: v("bad-soft") }, info: { DEFAULT: v("info"), soft: v("info-soft") },
      },
      boxShadow: { card: "0 1px 2px rgb(16 24 40 / .05), 0 4px 14px rgb(16 24 40 / .05)" },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
    },
  },
  plugins: [],
};
export default config;
