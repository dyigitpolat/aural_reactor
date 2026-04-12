import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "InterVariable",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        accent: {
          DEFAULT: "#7c5cff",
          hot: "#ff3d71",
          cool: "#2bd4c3",
        },
      },
      animation: {
        pulse: "pulse 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
