// POST { email } → email a one-time, 15-minute sign-in link via Resend
// (src/lib/login-link.ts). Always answers the same { ok: true } (no account
// enumeration); links only go to known clients, partners and staff (admins
// and the QA team).
//
// Rate limited (Oct 21 2026, src/lib/rate-limit.ts): 5 requests per 15
// minutes per email and 20 per 15 minutes per caller address. Past either
// limit the answer is the same { ok: true } and no email goes out, so a
// burst of requests neither floods an inbox nor reveals whether the address
// is on file. Demo mode (no database) hands the link straight back for the
// UI review and, past the limit, hands back no link.
import { clientExists, isDemo } from "@/lib/portal-data";
import { isStaffAllowed } from "@/lib/admin-allow";
import { isPartnerEmail } from "@/lib/partner";
import { sendSignInLink } from "@/lib/login-link";
import { issueLoginToken } from "@/lib/login-tokens";
import { clientIp, rateLimitHit, rateLimitKeyForEmail, rateLimitKeyForIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL = 5;
const PER_IP = 20;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const quiet = () => Response.json({ ok: true });

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const clean = String(body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(clean) || clean.length > 254) {
      return Response.json({ ok: false, error: "invalid email" }, { status: 400 });
    }
    // Both counters take the hit on every request so a flood keeps counting.
    const [byIp, byEmail] = await Promise.all([
      rateLimitHit(rateLimitKeyForIp(clientIp(request)), PER_IP, WINDOW_MS),
      rateLimitHit(rateLimitKeyForEmail(clean), PER_EMAIL, WINDOW_MS),
    ]);
    const limited = !byIp.allowed || !byEmail.allowed;
    if (limited) console.warn(`[login] rate limited (${!byIp.allowed ? "ip" : "email"}): ip=${clientIp(request)} count=${!byIp.allowed ? byIp.count : byEmail.count}`);
    if (isDemo()) {
      // No database: nothing to protect, so hand the sign-in link straight
      // back (relative, so it stays on this host) and the UI can be reviewed.
      if (limited) return Response.json({ ok: true, demo: true, limited: true });
      const token = await issueLoginToken(clean);
      return Response.json({ ok: true, demo: true, link: `/api/portal/verify?token=${encodeURIComponent(token)}` });
    }
    if (limited) return quiet();
    if (!(await isStaffAllowed(clean)) && !isPartnerEmail(clean) && !(await clientExists(clean))) {
      return quiet(); // don't reveal who has an account
    }
    await sendSignInLink(clean);
    return quiet();
  } catch (e) {
    console.error("portal login:", e);
    return Response.json({ ok: false, error: "failed" }, { status: 500 });
  }
}
