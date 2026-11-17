import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Match Cut",
  description: "Turn a YouTube reference into a Cardboard edit prompt.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
