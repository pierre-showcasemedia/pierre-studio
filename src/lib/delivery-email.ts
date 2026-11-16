// The "your gallery is ready" delivery email, the business (the design tokens),
// email-safe. All styles inline (email clients strip <style>); fonts fall back
// to Georgia italic / Helvetica where Newsreader and Geist aren't available.
// Newsreader is embedded from Google Fonts for clients that load web fonts.
// Images always load from the public portal (emailAssetBase), never from a
// preview host, because preview hosts sit behind Vercel's login wall.
// Client copy rules: plain and warm, no em dashes, sentence case buttons.
import { brand, emailAssetBase, supportEmail, supportPhone } from "./brand";

const PAGE = "#F3F4F6"; // fog, behind the card
const PAPER = "#FFFFFF";
const FOG = "#F6F7F9";
const INK = "#0B0C0F";
const MUTED = "#5F646E";
const FAINT = "#8A8F98";
const LINE = "#E6E8EC";
const SERIF = "'Newsreader', Georgia, 'Times New Roman', serif";
const SANS = "'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type DeliveryEmailInput = {
  address: string; // "100 Example Lane, Springfield, CA"
  coverUrl: string; // long-lived public cover image URL
  portalUrl: string; // login/portal entry
  shareUrl: string | null; // public preview link, if a token exists
  invoiceUrl: string | null; // open invoice, if unpaid
  invoiceAmount: string | null; // "$1,250", if unpaid
  // Every open invoice on the listing. When there are two or more, each gets its
  // own row and button (e.g. a production balance plus a monthly fee).
  invoices?: { url: string; amount: string | null }[];
  // Open invoices paid another way (check, ACH transfer or cash): never a
  // button, one line each that payment is arranged with the business.
  otherPayments?: { how: string; amount: string | null }[]; // how: "by check", "by ACH transfer", "in cash"
  locked: boolean;
  clientFirstName: string | null;
  // Optional custom body (plain text, newlines preserved). Replaces the default
  // paragraph after the greeting, for rolling deliveries ("today: the film").
  bodyText?: string | null;
  headline?: string | null; // default "Your gallery is ready."
};

// The default body paragraph as plain text, shown in the admin's editable field.
export function defaultDeliveryBody(address: string, locked: boolean): string {
  const street = address.split(",")[0];
  return `Everything from the ${street} shoot is ready in your client portal. ${locked ? "Downloads unlock as soon as payment is received. " : ""}Sign in with your email to view and download everything. If you have any questions, just reply to this email.`;
}

export function deliveryEmailSubject(address: string): string {
  return `Your gallery is ready: ${address.split(",")[0]}`;
}

// The delivery email after a revision round (Oct 30 2026): the shoot page's
// "Email the client" opens the usual preview with this wording filled in, to
// edit and confirm like any delivery email. Nothing sends on its own.
export function revisionEmailWording(address: string, photos: number): { subject: string; headline: string; body: string } {
  const street = address.split(",")[0];
  const n = photos === 1 ? "one photo" : `${photos} photos`;
  return {
    subject: `Your revised photos are ready: ${street}`,
    headline: "Your revisions are in.",
    body: `We made the changes you asked for on ${n} from ${street}. ${photos === 1 ? "It is" : "They are"} in your client portal now, in the same place as before, ready to view and download. If anything still needs a touch, just reply to this email.`,
  };
}

export function deliveryEmailHtml(x: DeliveryEmailInput): string {
  const street = x.address.split(",")[0];
  const rest = x.address.split(",").slice(1).join(",").trim();
  const hello = x.clientFirstName ? `Hi ${esc(x.clientFirstName)},` : "Hello,";
  const assets = emailAssetBase();
  const logo = `${assets}${brand.logoBlack}`;
  const phone = supportPhone();
  const email = supportEmail();
  const site = brand.marketingUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const headline = esc(x.headline ?? "Your gallery is ready.").replace(/ (?=[^ ]+$)/, "&nbsp;");

  const invoiceList = x.invoices && x.invoices.length > 1
    ? x.invoices
    : x.invoiceUrl ? [{ url: x.invoiceUrl, amount: x.invoiceAmount }] : [];
  const many = invoiceList.length > 1;
  const others = x.otherPayments ?? [];

  const pill = (href: string, label: string, solid: boolean) =>
    `<a href="${href}" style="display:inline-block;margin:0 6px 10px;font-family:${SANS};font-size:14px;font-weight:500;line-height:1;color:${solid ? PAPER : INK};background:${solid ? INK : PAPER};border:1px solid ${INK};border-radius:999px;padding:15px 30px;text-decoration:none;">${label}</a>`;

  const ctaRow = `
        <tr><td align="center" style="padding:4px 44px 30px;">
          ${pill(x.portalUrl, "View your gallery", true)}${invoiceList.length === 1 ? pill(invoiceList[0].url, x.locked ? `Pay invoice${invoiceList[0].amount ? ` · ${esc(invoiceList[0].amount)}` : ""}` : "View invoice", false) : ""}
        </td></tr>`;

  // "Payment by check is arranged with the business (a total of $1,250)." One line per invoice.
  const otherLines = others
    .map((o) => `<p style="margin:${invoiceList.length ? "12px 0 0" : "0"};font-family:${SANS};font-size:13.5px;line-height:1.65;color:${INK};">Payment ${esc(o.how)} is arranged with ${brand.shortName}${o.amount ? ` (a total of ${esc(o.amount)})` : ""}. ${x.locked ? "Watermarks come off and full-resolution downloads unlock as soon as we receive it." : "Nothing is charged by card."}</p>`)
    .join("");
  const otherBlock = others.length
    ? `
        <tr><td style="padding:0 44px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FOG};border:1px solid ${LINE};border-radius:14px;">
            <tr><td style="padding:20px 24px;">
              <p style="margin:0 0 6px;font-family:${SANS};font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:${FAINT};">Payment</p>
              ${otherLines}
            </td></tr>
          </table>
        </td></tr>`
    : "";

  const invoiceBlock = invoiceList.length
    ? `
        <tr><td style="padding:0 44px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FOG};border:1px solid ${LINE};border-radius:14px;">
            <tr><td style="padding:20px 24px;">
              <p style="margin:0 0 6px;font-family:${SANS};font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:${FAINT};">${many ? "Invoices" : "Payment"}</p>
              <p style="margin:0${many ? " 0 12px" : ""};font-family:${SANS};font-size:13.5px;line-height:1.65;color:${INK};">
                ${many ? "Each invoice is linked below." : x.locked ? "Watermarks come off and full-resolution downloads unlock the moment payment is received." : "Your invoice is linked above for your records."}
              </p>
              ${many ? invoiceList.map((inv) => `<a href="${inv.url}" style="display:inline-block;margin:0 8px 8px 0;font-family:${SANS};font-size:13px;color:${INK};border:1px solid ${INK};border-radius:999px;padding:10px 20px;text-decoration:none;">${x.locked ? "Pay invoice" : "View invoice"}${inv.amount ? ` · ${esc(inv.amount)}` : ""}</a>`).join("") : ""}${otherLines}
            </td></tr>
          </table>
        </td></tr>`
    : otherBlock;

  const shareBlock = x.shareUrl
    ? `
        <tr><td style="padding:0 44px 30px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:14px;">
            <tr><td style="padding:18px 24px;">
              <p style="margin:0 0 4px;font-family:${SANS};font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:${FAINT};">Share with the homeowner</p>
              <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.65;color:${MUTED};">A view-only preview, no sign-in needed:<br/>
                <a href="${x.shareUrl}" style="color:${INK};text-decoration:underline;word-break:break-all;">${x.shareUrl}</a>
              </p>
            </td></tr>
          </table>
        </td></tr>`
    : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <title>${esc(deliveryEmailSubject(x.address))}</title>
  <!-- Newsreader for the headline where web fonts load (Apple Mail, iOS Mail); Gmail and Outlook fall back to Georgia. -->
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap" rel="stylesheet"/>
  <style>@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};">
    <tr><td align="center" style="padding:40px 16px 48px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- the wordmark -->
        <tr><td align="center" style="padding:0 0 26px;">
          <a href="${brand.marketingUrl}" style="text-decoration:none;">
            <img src="${logo}" width="132" height="56" alt="${brand.name}" style="display:block;margin:0 auto;border:0;"/>
          </a>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:${PAPER};border:1px solid ${LINE};border-radius:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">

            <!-- Cover -->
            <tr><td style="padding:10px 10px 0;">
              <a href="${x.portalUrl}" style="text-decoration:none;">
                <img src="${x.coverUrl}" width="580" alt="${esc(street)}" style="display:block;width:100%;height:auto;border:0;border-radius:12px;background:${FOG};"/>
              </a>
            </td></tr>

            <!-- Headline -->
            <tr><td align="center" style="padding:34px 44px 6px;">
              <p style="margin:0 0 12px;font-family:${SANS};font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:${FAINT};">Your gallery</p>
              <h1 style="margin:0;font-family:${SERIF};font-style:italic;font-weight:400;font-size:36px;line-height:1.15;letter-spacing:-.02em;color:${INK};">${headline}</h1>
            </td></tr>
            <tr><td align="center" style="padding:10px 44px 26px;">
              <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${MUTED};">${esc(street)}${rest ? `<span style="color:${FAINT};">&nbsp;·&nbsp;</span>${esc(rest)}` : ""}</p>
            </td></tr>

            <!-- Body -->
            <tr><td style="padding:0 44px 26px;">
              <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.75;color:${INK};">
                ${hello}<br/><br/>
                ${esc(x.bodyText ?? defaultDeliveryBody(x.address, x.locked)).replace(/\n/g, "<br/>")}
              </p>
            </td></tr>

            ${ctaRow}
            ${invoiceBlock}
            ${shareBlock}

            <!-- Footer -->
            <tr><td align="center" style="padding:26px 44px 30px;border-top:1px solid ${LINE};">
              <a href="${brand.marketingUrl}" style="text-decoration:none;">
                <img src="${logo}" width="96" height="41" alt="${brand.name}" style="display:block;margin:0 auto 10px;border:0;"/>
              </a>
              <p style="margin:0 0 10px;font-family:${SANS};font-size:12px;letter-spacing:.02em;color:${MUTED};">Real estate photography and film</p>
              <p style="margin:0;font-family:${SANS};font-size:12.5px;line-height:1.8;color:${MUTED};">
                <a href="tel:${phone.replace(/[^0-9+]/g, "")}" style="color:${MUTED};text-decoration:none;">${esc(phone)}</a>
                &nbsp;·&nbsp;<a href="mailto:${email}" style="color:${MUTED};text-decoration:none;">${esc(email)}</a>
                &nbsp;·&nbsp;<a href="${brand.marketingUrl}" style="color:${MUTED};text-decoration:none;">${esc(site)}</a>
              </p>
            </td></tr>

          </table>
        </td></tr>

        <!-- Fine print -->
        <tr><td align="center" style="padding:18px 24px 0;">
          <p style="margin:0;font-family:${SANS};font-size:11px;line-height:1.6;color:${FAINT};">You're receiving this because you booked a shoot with ${esc(brand.name)}.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
