// The sign-in email: a 15-minute magic link sent through Resend. Used by the
// portal login route (the client asked) and by the admin "Send sign-in link"
// action (the team sends it for them). Never reveals whether an address has
// an account: callers decide who gets one.
// Layout (Oct 20 2026): the booking email's look (src/lib/booking-email.ts),
// cut down to one job: the dark header band with the white logo, a short
// note, one "Go to your portal" button, and the light footer band. All styles
// inline, table layout. Client copy rules: plain and warm, sentence case, no
// em dashes, no exclamation marks.
import { Resend } from "resend";
import { issueLoginToken } from "./login-tokens";
import { brand, emailAssetBase, emailFrom, siteUrl, supportEmail } from "./brand";
import { business } from "./business";

// The booking email's palette and type.
const PAGE = "#EEECE8";
const PAPER = "#FFFFFF";
const FOG = "#F6F5F2";
const INK = "#0B0C0F";
const MUTED = "#5F646E";
const FAINT = "#8A8F98";
const LINE = "#E6E8EC";
const SERIF = "'Newsreader', Georgia, 'Times New Roman', serif";
const SANS = "'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const SIGN_IN_SUBJECT = `Your sign-in link for ${brand.name}`;
const INTRO = `Here is your link to sign in to your ${brand.name} portal. It works for the next 15 minutes.`;
const IGNORE = "Didn't ask for this? You can ignore this email. Nothing changes on your account.";

export function signInEmailHtml(link: string): string {
  const logo = `${emailAssetBase()}${brand.logoWhite}`;
  const logoW = 132;
  const logoH = Math.round(logoW / brand.logoRatio);
  const site = brand.marketingUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <meta name="supported-color-schemes" content="light"/>
  <title>${esc(SIGN_IN_SUBJECT)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap" rel="stylesheet"/>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap');
    @media only screen and (max-width:480px) {
      .st-outer { padding:20px 10px 32px !important; }
      .st-pad { padding-left:24px !important; padding-right:24px !important; }
      .st-h1 { font-size:28px !important; }
      .st-button { display:block !important; text-align:center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};">
    <tr><td class="st-outer" align="center" style="padding:40px 16px 48px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PAPER};border-radius:14px;border-collapse:separate;">

        <tr><td class="st-pad" bgcolor="${INK}" style="background:${INK};border-radius:14px 14px 0 0;padding:24px 40px;">
          <a href="${brand.marketingUrl}" style="text-decoration:none;">
            <img src="${logo}" width="${logoW}" height="${logoH}" alt="${brand.name}" style="display:block;border:0;width:${logoW}px;height:${logoH}px;"/>
          </a>
        </td></tr>

        <tr><td class="st-pad" style="padding:40px 40px 0;">
          <p style="margin:0 0 14px;font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:${FAINT};">Client portal</p>
          <h1 class="st-h1" style="margin:0 0 16px;font-family:${SANS};font-weight:700;font-size:32px;line-height:1.15;letter-spacing:-.02em;color:${INK};">Your sign-in <em style="font-family:${SERIF};font-style:italic;font-weight:400;letter-spacing:-.01em;">link.</em></h1>
        </td></tr>

        <tr><td class="st-pad" style="padding:0 40px 26px;">
          <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.65;color:${INK};">${esc(INTRO)}</p>
        </td></tr>

        <tr><td class="st-pad" style="padding:0 40px 30px;">
          <a class="st-button" href="${esc(link)}" style="display:inline-block;font-family:${SANS};font-size:15px;font-weight:600;line-height:20px;color:${PAPER};background:${INK};border:1px solid ${INK};border-radius:8px;padding:14px 26px;text-decoration:none;">Go to your portal</a>
        </td></tr>

        <tr><td class="st-pad" style="padding:0 40px 36px;">
          <p style="margin:0 0 12px;font-family:${SANS};font-size:13px;line-height:1.6;color:${MUTED};">${esc(IGNORE)}</p>
          <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${FAINT};">Button not working? Copy this link into your browser:<br/><a href="${esc(link)}" style="color:${FAINT};text-decoration:underline;word-break:break-all;">${esc(link)}</a></p>
        </td></tr>

        <tr><td class="st-pad" bgcolor="${FOG}" style="background:${FOG};border-top:1px solid ${LINE};border-radius:0 0 14px 14px;padding:22px 40px 24px;">
          <p style="margin:0 0 6px;font-family:${SANS};font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:${INK};">Bespoke media, crafted to sell.</p>
          <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">${esc(brand.legalName)}&nbsp;·&nbsp;${esc(business.city)}&nbsp;·&nbsp;<a href="${brand.marketingUrl}" style="color:${MUTED};text-decoration:underline;">${esc(site)}</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function signInEmailText(link: string): string {
  return [`Hello,`, "", INTRO, "", `Go to your portal: ${link}`, "", IGNORE, "", `${brand.name}`].join("\n");
}

// The in-portal path to land on (opts.next) is bound to the token row, not
// carried in the URL, so the link cannot be edited into landing elsewhere.
export async function sendSignInLink(email: string, opts: { next?: string } = {}): Promise<void> {
  const clean = email.trim().toLowerCase();
  const token = await issueLoginToken(clean, opts.next ?? null);
  const link = `${siteUrl()}/api/portal/verify?token=${encodeURIComponent(token)}`;
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: emailFrom(),
    replyTo: supportEmail(), // the sending address has no mailbox
    to: clean,
    subject: SIGN_IN_SUBJECT,
    html: signInEmailHtml(link),
    text: signInEmailText(link),
  });
}
