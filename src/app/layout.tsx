import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kinnect",
  description:
    "A family operating system — shared agreements, mood check-ins, school goals, and a points & rewards system.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
