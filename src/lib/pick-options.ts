// Rows for the searchable picker (src/components/admin/SearchSelect.tsx),
// the same everywhere: a client reads "Name" over "Company · email" (two
// agents can share a name, so the email always shows), a listing reads its
// street over the rest of the address and the client.
import type { PickOption } from "@/components/admin/SearchSelect";

type ClientLike = { id: string; email: string; name: string | null; company?: string | null };
type ListingLike = { id: string; address: string; clientName?: string | null; clientEmail?: string | null };

export function clientPick(c: ClientLike): PickOption {
  const name = c.name?.trim();
  return { value: c.id, label: name || c.email, sub: [c.company?.trim(), name ? c.email : null].filter(Boolean).join(" · ") || null };
}

export function listingPick(l: ListingLike): PickOption {
  const [street, ...rest] = l.address.split(",");
  const who = l.clientName ?? l.clientEmail ?? null;
  return { value: l.id, label: street.trim() || l.address, sub: [rest.join(",").trim(), who].filter(Boolean).join(" · ") || null, keywords: l.clientEmail ?? null };
}
