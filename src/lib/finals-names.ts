// Corrected finals are matched to frames by filename (src/lib/finals.ts): the
// same base name, folder, extension and case aside, replaces that frame in
// place; any other name is added as a new frame. Nov 2 2026, 20 Dogwood:
// the editors' export came back renamed the business-20-Dogwood-N.jpg, so three
// drops on the listing's two shoots replaced nothing and added 94, then 171,
// new frames, and the second shoot's card moved to Final review beside the
// first. These helpers let the upload box say so before anything is stored,
// and point at the shoot of this listing whose frames the names DO match.
// Pure functions, no database: scripts/check-final-review.ts covers them.

export const frameBase = (name: string) => (name.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").toLowerCase();

export type SiblingShoot = { shootId: string; label: string; frameNames: string[] };

// The names that match no frame of this shoot.
export function strayNames(names: string[], frameNames: string[]): string[] {
  const known = new Set(frameNames.map(frameBase));
  return names.filter((n) => !known.has(frameBase(n)));
}

// How many of the names match frames on each other shoot of the listing,
// best match first. Empty when none do.
export function siblingMatches(names: string[], siblings: SiblingShoot[]): { shootId: string; label: string; matched: number }[] {
  const bases = names.map(frameBase);
  return siblings
    .map((s) => {
      const known = new Set(s.frameNames.map(frameBase));
      return { shootId: s.shootId, label: s.label, matched: bases.filter((b) => known.has(b)).length };
    })
    .filter((s) => s.matched > 0)
    .sort((a, b) => b.matched - a.matched);
}
