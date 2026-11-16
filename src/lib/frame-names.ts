// Names and storage keys for frames the editing service hands back (Oct 2026).
//
// The bug this exists for (Oct 20 2026, 456 Test Street): every import named
// its frames "<Street>-01.jpg", "<Street>-02.jpg" ... and wrote them to
// listings/<slug>/edited/<name>. A second shoot on the same listing therefore
// wrote straight over the first shoot's files: the published frame kept its
// media row (and the client's revision note on it) but now showed the new
// photo, and the original was gone from storage. Thumbnails, previews, MLS and
// cover files are keyed by the file's name alone (media-keys.ts drops the
// folder), so a frame could also clash with a hand-uploaded file of the same
// name.
//
// Now a shoot's frames continue the numbering after every frame already on the
// listing from other shoots or uploads ("<Street>-25.jpg" after 24), and any
// name whose original or derivative files another media row already uses gets
// the shoot's short id added, so an import never overwrites anything.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { derivativeKey } from "./media-keys";

const pad = (n: number) => String(n).padStart(2, "0");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fileOf = (key: string) => key.split("/").pop() ?? key;

export type FrameNamer = { at: (n: number) => { filename: string; key: string } };

// stem "456-Test-Street" (or "456-Test-Street-Twilight"), dir the folder the
// originals go in ("listings/<slug>/edited"). n counts from 1 within the shoot.
export async function frameNamer(p: { listingId: string; shootId: string; stem: string; dir: string }): Promise<FrameNamer> {
  const rows = await db().query.media.findMany({ where: eq(schema.media.listingId, p.listingId), columns: { r2Key: true, shootId: true } });
  const others = rows.filter((r) => r.shootId !== p.shootId);
  const takenKeys = new Set(others.map((r) => r.r2Key));
  const takenDerivs = new Set(others.map((r) => derivativeKey(r.r2Key, "thumb")));
  const re = new RegExp(`^${escapeRe(p.stem)}-(\\d+)(?:-[a-z0-9]+)?\\.[a-z0-9]+$`, "i");
  // Day frames must not count the twilight ones ("<Street>-Twilight-01").
  const base = others.reduce((max, r) => {
    const m = re.exec(fileOf(r.r2Key));
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const short = p.shootId.replace(/-/g, "").slice(0, 6).toLowerCase();
  return {
    at(n: number) {
      const plain = `${p.stem}-${pad(base + n)}.jpg`;
      const plainKey = `${p.dir}/${plain}`;
      if (!takenKeys.has(plainKey) && !takenDerivs.has(derivativeKey(plainKey, "thumb"))) return { filename: plain, key: plainKey };
      const alt = `${p.stem}-${pad(base + n)}-${short}.jpg`;
      return { filename: alt, key: `${p.dir}/${alt}` };
    },
  };
}
