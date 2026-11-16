// Derivative R2 keys, by convention from the original's key.
//   original: listings/<slug>/photos/<name>.jpg
//   derived:  listings/<slug>/d/<variant>/<name>.jpg
// Variants: thumb, thumb-wm, preview, preview-wm, mls ("-wm" = the business watermark,
// served while the listing's downloads are locked). cover and cover-wm exist
// only for a listing's cover photo (3200px hero), made on demand by
// ensureCoverDerivative in src/lib/derivatives.ts.
export type DerivativeVariant = "thumb" | "thumb-wm" | "preview" | "preview-wm" | "mls" | "cover" | "cover-wm";

export function derivativeKey(originalKey: string, variant: DerivativeVariant): string {
  const parts = originalKey.split("/");
  const file = parts.pop()!;
  parts.pop(); // drop "photos" (or "video")
  const base = file.replace(/\.[^.]+$/, "") + ".jpg";
  return [...parts, "d", variant, base].join("/");
}
