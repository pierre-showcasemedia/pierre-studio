// The Video board (Oct 26 2026, src/lib/video-board.ts): every shoot with
// video as a card in five stages, for admins and video editors. A video
// editor lands here and sees nothing else in the admin.
import { fileStoreName } from "@/lib/file-store";
import { videoBoardLede } from "@/lib/file-store-copy";
import { desc } from "drizzle-orm";
import { db, hasDb, schema } from "@/db";
import { requireVideo } from "@/lib/admin";
import { videoBoard } from "@/lib/video-board";
import { PageHead } from "@/components/admin/bits";
import RefreshOnReturn from "@/components/admin/RefreshOnReturn";
import { VideoBoard } from "@/components/admin/VideoBoard";
import { addVideoCard } from "./actions";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { listingPick } from "@/lib/pick-options";
import "@/styles/admin-video.css";

export const dynamic = "force-dynamic";

export default async function AdminVideo({ searchParams }: { searchParams: Promise<{ denied?: string; saved?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  const staff = await requireVideo();
  const sp = await searchParams;
  const admin = staff.role === "admin";
  const [cards, listings] = await Promise.all([
    videoBoard(),
    admin && hasDb() ? db().query.listings.findMany({ columns: { id: true, address: true }, orderBy: [desc(schema.listings.createdAt)], limit: 500 }) : Promise.resolve([]),
  ]);
  const open = cards.filter((c) => c.stage !== "complete").length;
  const revisions = cards.filter((c) => c.revision && c.revision.status !== "done").length;
  const boardKey = `${cards.length}:${cards.map((c) => `${c.id.slice(0, 4)}${c.stage[0]}`).join("")}`;
  return (
    <section className="wrap adm-page" style={{ maxWidth: 1480 }}>
      <RefreshOnReturn />
      <PageHead
        eyebrow="Video"
        title="Video."
        lede={videoBoardLede(fileStoreName(), open, revisions)}
      />
      {sp.denied && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>That page is not part of the Video board, so you are back here.</p>}
      {sp.saved === "removed" && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Card removed.</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}

      <VideoBoard key={boardKey} cards={cards} />

      {admin && (
        <details className="adm-card" style={{ marginTop: 22, maxWidth: 720 }}>
          <summary style={{ cursor: "pointer", fontSize: 13.5, fontWeight: 500 }}>Add a card by hand</summary>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, margin: "10px 0 12px" }}>
            Cards appear on their own when a booking with a film or reel comes in, or when raw video is uploaded. Add one here for a shoot that came in another way.
          </p>
          <form action={addVideoCard} className="flex flex-wrap items-end" style={{ gap: 10 }}>
            <div className="field" style={{ margin: 0, flex: "1 1 320px" }}>
              <label htmlFor="vc-listing">Listing</label>
              <SearchSelect id="vc-listing" name="listingId" required options={listings.map(listingPick)} placeholder="Choose a listing" title="Choose a listing" searchPlaceholder="Search address or client" />
            </div>
            <button type="submit" className="btn btn-primary">Add card →</button>
          </form>
        </details>
      )}
    </section>
  );
}
