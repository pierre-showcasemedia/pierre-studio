import type { Metadata } from "next";
import { Suspense, ViewTransition } from "react";
import localFont from "next/font/local";
import ImageGuard from "@/components/ImageGuard";
import NavProgress from "@/components/motion/NavProgress";
import RevealObserver from "@/components/motion/RevealObserver";
import { brand, siteUrl } from "@/lib/brand";
import "./globals.css";

// Showcase Media's type, as on Pierre's current site: Manrope for UI and body,
// Instrument Sans for headings and names, Geist Mono for sizes and dates. All self-hosted: builds never depend on a Google
// Fonts fetch.
const sans = localFont({
  src: "./fonts/manrope.woff2",
  variable: "--ff-sans",
  weight: "200 800",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/geist-mono.woff2",
  variable: "--ff-mono",
  weight: "100 900",
  display: "swap",
});

const serif = localFont({
  src: "./fonts/instrument-sans.woff2",
  variable: "--ff-serif",
  weight: "400 700",
  display: "swap",
});

const heading = localFont({
  src: "./fonts/instrument-sans.woff2",
  variable: "--ff-serif-hero",
  weight: "400 700",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: `Client Portal | ${brand.name}`,
    template: `%s | ${brand.name}`,
  },
  description: `Your photography, tours and video from ${brand.name}.`,
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
