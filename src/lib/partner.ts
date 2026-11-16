// Partner access. Partners sign in through the same magic link and see every
// PAID listing with full downloads, read-only: no invoices, no approve /
// request-revision. Their downloads land in the admin activity feed like any
// client's. Remove an email from PARTNER_EMAILS to revoke.
//
// Everything here is env-driven and empty by default:
//   PARTNER_EMAILS          comma-separated partner logins
//   PARTNER_EXCLUDED_IDS    listing ids partners must never see (NDA, confidential)
//   PARTNER_EXCLUDED_SLUGS  same, by slug. Exclusions match on id AND slug so a
//                           rename or a re-created listing can't slip through.

function list(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function partnerEmails(): string[] {
  return list(process.env.PARTNER_EMAILS);
}

export function isPartnerEmail(email: string): boolean {
  return partnerEmails().includes(email.trim().toLowerCase());
}

// v1.1: a listing flagged nda in the database is excluded too (set from the
// upload wizard), on top of the env lists.
export function partnerCanSee(l: { id: string; slug: string; downloadLocked: boolean; nda?: boolean | null }): boolean {
  if (l.nda) return false;
  const excludedIds = list(process.env.PARTNER_EXCLUDED_IDS);
  const excludedSlugs = list(process.env.PARTNER_EXCLUDED_SLUGS);
  return !l.downloadLocked && !excludedIds.includes(l.id.toLowerCase()) && !excludedSlugs.includes(l.slug.toLowerCase());
}
