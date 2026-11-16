// The Photo QC board (Oct 26 2026, src/lib/photo-qc.ts): every photo shoot
// from editing to published, plus the open photo revisions, as cards like
// the Video board. A card opens the shoot page (frames with the automatic QC
// notes, approve or reject, publish) or the revision; a shoot's card ends in
// the status bar that moves it to another column (Nov 6 2026,
// src/components/admin/PhotoQcBoard.tsx). Admins and the Photo QC team; it is
// the Photo QC team's home.
import { requireStaff } from "@/lib/admin";
import { PHOTO_QC_COLUMNS, photoQcBoard } from "@/lib/photo-qc";
import AutoRefresh from "@/components/AutoRefresh";
import { PageHead } from "@/components/admin/bits";
import { PhotoQcBoard } from "@/components/admin/PhotoQcBoard";
import "@/styles/admin-video.css";

export const dynamic = "force-dynamic";

export default async function PhotoQcPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  await requireStaff();
  const sp = await searchParams;
  const board = await photoQcBoard();
  const waiting = board.review.length;
  const finalN = board.final.length;
  // On a phone the board shows one column at a time: open on the work.
  const boardKey = PHOTO_QC_COLUMNS.map((c) => board[c.key].map((x) => `${x.id.slice(0, 6)}${x.pick?.at ?? ""}`).join(",")).join("|");
  const firstCol = finalN ? "final" : waiting ? "review" : (PHOTO_QC_COLUMNS.find((c) => board[c.key].length)?.key ?? "review");
  return (
    <section className="wrap adm-page" style={{ maxWidth: 1480 }}>
      <PageHead
        eyebrow="Photo QC"
        title="Photo QC."
        lede={`Every photo shoot from editing to the gallery. A shoot lands in Ready for QC once its frames are back and the automatic QC has run: open it to approve, reject and publish. When the editors send corrected photos, the shoot moves to Final review for the last pass. ${waiting ? `${waiting} ready for QC.` : "Nothing waiting for QC."}${finalN ? ` ${finalN} in final review.` : ""}${board.revisions.length ? ` ${board.revisions.length} open photo revision${board.revisions.length === 1 ? "" : "s"}.` : ""}`}
      />
      {sp.denied && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>That page is not part of Photo QC, so you are back here.</p>}
      {/* The pipeline moves cards on its own: refresh while anything is in editing. */}
      {board.editing.length > 0 && <AutoRefresh ms={30_000} times={60} />}
      {/* A new key when the server's board changes, so a refresh shows it. */}
      <PhotoQcBoard key={boardKey} board={board} columns={PHOTO_QC_COLUMNS} initial={firstCol} />
    </section>
  );
}
