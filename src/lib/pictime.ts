// Pic-Time galleries (Nov 22 2026). Pierre keeps delivering on Pic-Time for
// the year he has paid; a listing can carry the link to its Pic-Time gallery.
// With one set, the portal page and the delivery email send the client there
// ("Open your gallery"), and the delivery email can go before any photos are
// uploaded to the studio. Client copy never names the vendor.

const HOST_RE = /(^|\.)pic-time\.com$/i;

// "" -> null (cleared). A valid https link on pic-time.com -> the cleaned
// link. Anything else -> an error to show the admin.
export function parsePicTimeUrl(raw: string): { ok: true; url: string | null } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: true, url: null };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "The Pic-Time link does not look like a web address. Paste the full link, starting with https://" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The Pic-Time link must start with https://" };
  if (!HOST_RE.test(u.hostname)) return { ok: false, error: "That link is not a Pic-Time address (it should end in pic-time.com)." };
  if (u.username || u.password) return { ok: false, error: "The Pic-Time link must not contain a username or password." };
  return { ok: true, url: u.toString() };
}
