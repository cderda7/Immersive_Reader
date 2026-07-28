import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "./globals.css";

// Lexend: designed specifically to improve reading proficiency/fluency,
// a reasonable strong default for a dyslexia-informed reading tool.
// Swap here (single source of truth) if a different default is preferred.
const lexend = Lexend({
  subsets: ["latin"],
  variable: "--font-reading",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Immersive Reader",
  description: "Syllable-paced reading practice for grades 7-12.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={lexend.variable}>{children}</body>
    </html>
  );
}
