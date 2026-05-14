/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        swath: {
          bg: "#0d1117",
          panel: "#161b22",
          border: "#30363d",
          text: "#c9d1d9",
          muted: "#8b949e",
          accent: "#58a6ff"
        }
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "SF Mono", "Menlo", "Monaco", "monospace"]
      }
    }
  },
  plugins: []
};
