import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SwiftInbox — a WhatsApp assistant that answers for you",
  description:
    "Your WhatsApp answered day and night, in the languages your customers use. From R300 a month for small businesses in Krugersdorp and the West Rand.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A5C36",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-ZA">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
