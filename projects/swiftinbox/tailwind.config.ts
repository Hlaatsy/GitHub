import type { Config } from "tailwindcss";

/* Two greens do the work. WhatsApp green is the product's one loud colour --
   it means "this is the channel your customer is already in" -- so it is
   reserved for actions and for anything representing a live conversation.
   Emerald is the quiet one: headings, deep surfaces, anything that should
   read as the business rather than the chat. */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        whatsapp: {
          DEFAULT: "#25D366",
          600: "#1EB955",
          700: "#179C46",
          wash: "#E8FBF0",
        },
        emerald: {
          ink: "#0A5C36",
          deep: "#073F25",
          wash: "#EAF4EF",
        },
        ink: "#0C1F17",
        muted: "#5B7468",
        line: "#DCE8E1",
        paper: "#F7FBF9",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
