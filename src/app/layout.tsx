import type { Metadata } from "next";
import { Suspense, ViewTransition } from "react";
import localFont from "next/font/local";
import ImageGuard from "@/components/ImageGuard";
import NavProgress from "@/components/motion/NavProgress";
import RevealObserver from "@/components/motion/RevealObserver";
import { brand, siteUrl } from "@/lib/brand";
import "./globals.css";

// the design tokens type: Geist for UI and body, Newsreader italic for headings,
// Cormorant Garamond italic for supporting names (property addresses on cards).
const sans = localFont({
  src: "./fonts/geist.woff2",
  variable: "--ff-sans",
  weight: "100 900",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/geist-mono.woff2",
  variable: "--ff-mono",
  weight: "100 900",
  display: "swap",
});

// Serifs are self-hosted too (latin subsets of the variable fonts Google
// serves). Builds must never depend on a Google Fonts fetch: that fetch
// failed and sank two deployments on Oct 16 2026.
const serif = localFont({
  src: [
    { path: "./fonts/cormorant-garamond.woff2", weight: "300 700", style: "normal" },
    { path: "./fonts/cormorant-garamond-italic.woff2", weight: "300 700", style: "italic" },
  ],
  variable: "--ff-serif",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

const heading = localFont({
  src: "./fonts/newsreader-italic.woff2",
  variable: "--ff-serif-hero",
  weight: "200 800",
  style: "italic",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: `Client Portal | ${brand.name}`,
    template: `%s | ${brand.name}`,
  },
  description: `Your listing photography and film from ${brand.name}.`,
  // Private portal: never indexed.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${mono.variable} ${serif.variable} ${heading.variable}`}>
      <body>
        <ImageGuard />
        <RevealObserver />
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        {/* Every navigation cross-fades the page (.page-swap in globals.css).
            One wrapper element takes React's transition name, so the headers
            inside keep their own view-transition-name and stay put. */}
        <ViewTransition update="page-swap" default="none">
          <div className="page-root">{children}</div>
        </ViewTransition>
      </body>
    </html>
  );
}
