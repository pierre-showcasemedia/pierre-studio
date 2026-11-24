import type { NextConfig } from "next";
import { business } from "./src/lib/business";

// The studio: the admin and the client portal only. No marketing pages, no host
// rewrites; the root route redirects to /portal (see src/app/page.tsx).

// Security headers (Oct 21 2026). Everything but the full Content Security
// Policy is enforced. The full CSP ships as Report-Only: Next's hydration
// needs inline scripts, the upload wizard PUTs straight to R2, and the
// Dropbox and Titus drop-ins open popups from scripts on their own hosts,
// none of which can be verified end to end without the real accounts. The
// report-only policy lists the hosts the app really uses, so a violation
// shows in the browser console on a preview before the policy is enforced.
// A small CSP that is safe everywhere is enforced alongside it.
const R2 = "https://*.r2.cloudflarestorage.com";
const DROPBOX = "https://www.dropbox.com https://*.dropboxapi.com";
const TITUS = "https://assets.gotitus.com https://*.gotitus.com";
// Nov 18 2026: Google sign-in (Save to Google Drive) and the Drive Picker (Import from Google Drive).
const GOOGLE = "https://accounts.google.com https://apis.google.com https://docs.google.com https://www.googleapis.com";

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${DROPBOX} ${TITUS} ${GOOGLE}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  `img-src 'self' data: blob: ${R2} ${business.portalUrl} https://*.vercel.app`,
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' ${R2} ${DROPBOX} ${TITUS} ${GOOGLE}`,
  `frame-src 'self' ${DROPBOX} ${TITUS} ${GOOGLE}`,
  `media-src 'self' blob: ${R2}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const CSP_ENFORCED = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"].join("; ");

const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Content-Security-Policy", value: CSP_ENFORCED },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];

const nextConfig: NextConfig = {
  // Page changes cross-fade through React's <ViewTransition> (root layout);
  // since Next 16.4 / React 19.3 that needs no config flag.
  // Nothing in the portal identifies its framework on purpose.
  poweredByHeader: false,
  // Team SOPs (/admin/sops) read their markdown from disk at request time
  // (src/lib/sop-content.ts): ship the folder with those routes.
  outputFileTracingIncludes: {
    "/admin/sops": ["./src/content/sops/*.md"],
    "/admin/sops/*": ["./src/content/sops/*.md"],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
