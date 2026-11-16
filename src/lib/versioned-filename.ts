// A free filename next to the ones already taken (Nov 5 2026). A video editor
// who uploads a cut under a name the listing already has (a revision exported
// with the same name, a second drop of the same file) gets "name-v2.mp4",
// then "-v3" and so on, so the new cut always lands, internal only, and the
// film a client may be watching is never written over. A name that already
// ends in "-vN" counts up from N. No dependencies: the route calls it on
// safe filenames (src/lib/r2.ts safeFilename), and it can be run on its own.
export function versionedFilename(name: string, taken: (candidate: string) => boolean, max = 99): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const m = /^(.*?)-v(\d+)$/i.exec(stem);
  const base = m ? m[1] : stem;
  let n = m ? Number(m[2]) + 1 : 2;
  for (let i = 0; i < max; i++, n++) {
    const candidate = `${base}-v${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}
