import type { Config } from "tailwindcss";

/**
 * Kinnect visual language (see build brief > UI reference).
 * Parent accent is coral, child accent is lavender.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: "#FAF7F2",
        dark: "#1A1A2E",
        coral: "#E8634A",
        sage: "#7BAE9A",
        gold: "#D4A853",
        lavender: "#9B8EC4",
      },
      fontFamily: {
        serif: ["Georgia", "Cambria", "Times New Roman", "serif"],
      },
      borderRadius: {
        card: "1.25rem",
      },
      boxShadow: {
        soft: "0 10px 30px -12px rgba(26, 26, 46, 0.18)",
      },
    },
  },
  plugins: [],
};

export default config;
