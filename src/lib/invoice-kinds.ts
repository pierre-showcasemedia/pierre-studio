// Which invoices move the gallery lock (no imports, so the portal, the pages
// and the payments core share one list without pulling each other in).
// An exclusivity_monthly invoice (never unlocks), an "addon" invoice (items
// added after the booking's invoice was paid, Oct 21 2026) and an
// "additional_shoot" invoice (a second shoot's own, Oct 27 2026) never lock or
// unlock anything: the booking's own invoice governs downloads.
export const NON_GATING_INVOICE_TYPES = ["exclusivity_monthly", "addon", "additional_shoot"] as const;

export function gatesGallery(meta: { invoiceType?: string | null } | null | undefined): boolean {
  return !(NON_GATING_INVOICE_TYPES as readonly string[]).includes(meta?.invoiceType ?? "production");
}
