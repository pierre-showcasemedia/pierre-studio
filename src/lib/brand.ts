// Brand + deployment settings. The business itself (name, contact, domains)
// is src/lib/business.ts; this file is the look (logos, watermark) and the
// env overrides. Everything environment-specific comes from env vars (see
// .env.example); the defaults are the business's public values, never secrets.
// Colors and fonts are the tokens at the top of src/app/globals.css.
import { business } from "./business";

export const brand = {
  name: business.name,
  shortName: business.shortName,
  legalName: business.legalName,
  signOff: business.signOff,
  // Public marketing site (linked from the footer and the share page).
  marketingUrl: process.env.NEXT_PUBLIC_MARKETING_URL || business.marketingUrl,
  // The wordmark for light pages (logoBlack) and for photos and dark
  // grounds (logoWhite). Swap the files in public/brand, keep the ratio here.
  logoBlack: "/brand/logo-dark.png",
  logoWhite: "/brand/logo-white.png",
  // White mark on transparent, used for the on-page share watermark and
  // baked into the locked preview derivatives by scripts/make-derivatives.py.
  watermark: "/brand/watermark.png",
  logoRatio: 2400 / 801,
};

// "example.com": the marketing site's host, for "example.com ↗" links.
export const marketingHost = (): string => brand.marketingUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
// The domain the business sends from ("example.com"), for calendar UIDs and
// telling the team's own addresses from a client's.
export const mailDomain = (): string => (business.supportEmail.split("@")[1] || "example.com").toLowerCase();

// Base URL of this app (magic links, delivery email links, cover images).
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || business.portalUrl).replace(/\/+$/, "");
}

// Sender for every outbound email (magic link, delivery, notifications).
export function emailFrom(): string {
  return process.env.EMAIL_FROM || business.emailFrom;
}

// Where client replies go (the sending address has no mailbox) and the
// address shown to clients when something fails.
export function supportEmail(): string {
  return process.env.SUPPORT_EMAIL || business.supportEmail;
}

// The business line is the only phone number clients ever see. Never put a
// personal number here or in SUPPORT_PHONE.
export const BUSINESS_LINE: string = business.phone;
export function supportPhone(): string {
  return process.env.SUPPORT_PHONE?.trim() || BUSINESS_LINE;
}

function emailList(raw: string | undefined): string[] {
  return (raw || "")
    .split(/[,\s;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

// Team inboxes that get approve / revision-request notifications.
// Falls back to ADMIN_EMAILS when NOTIFY_EMAILS is unset.
export function notifyEmails(): string[] {
  const list = emailList(process.env.NOTIFY_EMAILS);
  return list.length ? list : emailList(process.env.ADMIN_EMAILS);
}

// Always CCed on every delivery email: DELIVERY_CC (comma separated, optional).
export function deliveryCc(): string[] {
  return [...new Set(emailList(process.env.DELIVERY_CC))];
}

// Images inside emails (logo, cover) must load from a public address. Previews
// sit behind Vercel's login wall, so always use the live portal unless overridden.
export function emailAssetBase(): string {
  return (process.env.EMAIL_ASSET_BASE || business.portalUrl).replace(/\/+$/, "");
}
