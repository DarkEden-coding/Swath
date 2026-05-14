/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        swath: {
          bg: "#0d1117",
          panel: "#161b22",
          "panel-2": "#21262d",
          border: "#30363d",
          "border-strong": "#484f58",
          text: "#c9d1d9",
          muted: "#8b949e",
          "muted-2": "#6e7681",
          accent: "#58a6ff",
          "accent-strong": "#79c0ff",
          danger: "#f85149",
          good: "#3fb950",
          warn: "#d29922",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ['"JetBrains Mono"', '"Fira Code"', '"SF Mono"', "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        swath: "0 12px 34px rgba(0, 0, 0, 0.45)",
        "swath-lg": "0 18px 48px rgba(0, 0, 0, 0.45)",
        "swath-modal": "0 28px 80px rgba(0, 0, 0, 0.55)",
        "swath-float": "0 4px 12px rgba(0, 0, 0, 0.2)",
      },
    },
  },
  plugins: [],
};
