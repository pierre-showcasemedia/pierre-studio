import Link from "next/link";
import type { RevisionStatus } from "@/db/schema";
import { adminRevisions, adminUnplacedTexts } from "@/lib/admin-data";
import { revisionShoots } from "@/lib/revision-frames";
import { fmtWhen } from "@/lib/shoot-status";
import { dismissUnplacedText, setRevisionKind, setRevisionStatus } from "../actions";
import { fmtTimecode } from "@/lib/video-board";
import { Empty, PageHead } from "@/components/admin/bits";
import { requireStaff } from "@/lib/admin";
import "@/styles/admin-revisions.css";

const LABEL: Record<RevisionStatus, string> = { new: "New", in_progress: "In progress", done: "Done" };
const COLOR: Record<RevisionStatus, { bg: string; fg: string }> = {
  new: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  in_progress: { bg: "rgba(154,100,0,.10)", fg: "#9A6400" },
  done: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B" },
};

// Every revision is tagged PHOTO or VIDEO (Oct 26 2026).
const KIND: Record<"photo" | "video", { label: string; bg: string; fg: string }> = {
  photo: { label: "Photo", bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  video: { label: "Video", bg: "rgba(91,63,181,.10)", fg: "#5B3FB5" },
};

export default async function AdminRevisions({ searchParams }: { searchParams: Promise<{ show?: string; kind?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  // Admins and the Photo QC team (Oct 26 2026). The Photo QC team sees the
  // photo requests only, no client emails, no texts the intake could not
  // place (phone numbers) and no client gallery link (that is view as).
  const staff = await requireStaff();
  const admin = staff.role === "admin";
  const { show, kind } = await searchParams;
  const k = !admin ? "photo" : kind === "photo" || kind === "video" ? kind : null;
  const [all, unplaced] = await Promise.all([adminRevisions(), admin ? adminUnplacedTexts() : Promise.resolve([])]);
  const rows = (show === "all" ? all : all.filter((r) => r.status !== "done")).filter((r) => !k || (r.mediaKind ?? "photo") === k);
  // Oct 30 2026: a photo request opens its photos on their shoot, notes beside them.
  const onShoot = await revisionShoots(rows.filter((r) => (r.mediaKind ?? "photo") === "photo"));
  const open = all.filter((r) => r.status !== "done").length;
  const openOf = (x: "photo" | "video") => all.filter((r) => r.status !== "done" && (r.mediaKind ?? "photo") === x).length;
  const href = (o: { show?: string | null; kind?: string | null }) => {
    const q = new URLSearchParams();
    const sh = o.show === undefined ? show : o.show;
    const kd = o.kind === undefined ? k : o.kind;
    if (sh === "all") q.set("show", "all");
    if (kd && admin) q.set("kind", kd);
    const qs = q.toString();
    return `/admin/revisions${qs ? `?${qs}` : ""}`;
  };
  const here = href({});
  return (
    <section className="wrap adm-page">
      <PageHead
        eyebrow={admin ? "Admin" : "Photo QC"}
        title="Revisions."
        lede={admin ? `Every revision request, newest first, tagged Photo or Video: from the gallery (a note on each photo, or notes at moments in a film), and from texts the intake read for us. ${open} open: ${openOf("photo")} photo, ${openOf("video")} video.` : `Every photo revision request, newest first: a note on each photo from the client's gallery, or a text the intake read for us. Fix the photos and upload them on the listing (same filename replaces the photo), then mark the request done. ${openOf("photo")} open.`}
      >
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          {admin && <div className="adm-seg" role="tablist" aria-label="Kind">
            <Link href={href({ kind: null })} className={!k ? "is-active" : ""} role="tab" aria-selected={!k}>Both</Link>
            <Link href={href({ kind: "photo" })} className={k === "photo" ? "is-active" : ""} role="tab" aria-selected={k === "photo"}>Photo</Link>
            <Link href={href({ kind: "video" })} className={k === "video" ? "is-active" : ""} role="tab" aria-selected={k === "video"}>Video</Link>
          </div>}
          <div className="adm-seg" role="tablist" aria-label="Show">
            <Link href={href({ show: null })} className={show !== "all" ? "is-active" : ""} role="tab" aria-selected={show !== "all"}>Open</Link>
            <Link href={href({ show: "all" })} className={show === "all" ? "is-active" : ""} role="tab" aria-selected={show === "all"}>All</Link>
          </div>
        </div>
      </PageHead>

      {unplaced.length > 0 && (
        <section className="adm-card adm-card--lg" style={{ display: "grid", gap: 12, marginTop: 26, borderColor: "rgba(154,100,0,.35)" }}>
          <div>
            <div style={{ fontWeight: 500, fontSize: 16 }}>Revision messages we couldn&rsquo;t place</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>These texts and emails ask for a revision, but the sender isn&rsquo;t on a client or the listing isn&rsquo;t clear. Add it to the right listing by hand, then dismiss it here.</div>
          </div>
          {unplaced.map((t) => (
            <div key={t.id} style={{ display: "grid", gap: 6, paddingTop: 12, borderTop: "1px solid var(--color-line)" }}>
              <div className="muted" style={{ fontSize: 13 }}>
                {t.clientName ?? t.clientEmail ?? t.from ?? "Unknown sender"}
                {t.clientName || t.clientEmail ? ` · ${t.from ?? ""}` : ""} · {t.source === "quo" ? "text" : t.source} · <span className="adm-mono">{fmtWhen(t.receivedAt)}</span>
                {t.photos > 0 ? ` · ${t.photos} photo${t.photos === 1 ? "" : "s"}` : ""}
              </div>
              {t.summary && <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6 }}>{t.summary}</p>}
              {t.body.trim() && <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap", borderLeft: "3px solid var(--color-line)", paddingLeft: 10 }}>{t.body}</p>}
              <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                <span className="adm-pill" style={{ background: "rgba(154,100,0,.10)", color: "#9A6400" }}>{t.reason || "Needs a look"}</span>
                <span style={{ flex: 1 }} />
                <form action={dismissUnplacedText.bind(null, t.id)}>
                  <button type="submit" className="adm-chip adm-chip--quiet">Dismiss</button>
                </form>
              </div>
            </div>
          ))}
        </section>
      )}

      {rows.length === 0 ? (
        <Empty>{show === "all" ? "No revision requests yet." : "No open revision requests. Nice."}</Empty>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 26 }}>
          {rows.map((r) => {
            const c = COLOR[r.status];
            const mk = r.mediaKind ?? "photo";
            const vc = r.videoComments ?? [];
            return (
              <article key={r.id} id={`rev-${r.id}`} className="adm-card adm-card--lg" style={{ display: "grid", gap: 12, scrollMarginTop: "calc(var(--adm-top, 0px) + 20px)" }}>
                <div className="flex flex-wrap items-start justify-between" style={{ gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/admin/listings/${r.listingId}`} style={{ fontWeight: 500, fontSize: 16 }}>{r.address.split(",")[0]}</Link>
                    <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                      {admin ? (
                        <>
                          <Link href={`/admin/clients?q=${encodeURIComponent(r.clientEmail)}`}>{r.clientName ?? r.clientEmail}</Link>
                          {r.clientName ? ` · ${r.clientEmail}` : ""}
                        </>
                      ) : (
                        r.clientName ?? "The client"
                      )}{" "}
                      · <span className="adm-mono">{fmtWhen(r.createdAt)}</span>
                    </div>
                  </div>
                  <span className="flex flex-wrap items-center" style={{ gap: 6 }}>
                    <span className="adm-pill" style={{ background: KIND[mk].bg, color: KIND[mk].fg }}>{KIND[mk].label}</span>
                    {r.source && <span className="adm-pill" style={{ background: "var(--color-fog)", color: "var(--color-ink-soft)" }}>{r.source === "quo" ? "By text" : r.source === "email" ? "By email" : r.source}</span>}
                    {r.needsReview && r.status !== "done" && <span className="adm-pill" style={{ background: "rgba(154,100,0,.10)", color: "#9A6400" }} title={r.reviewNote ?? undefined}>Needs a look</span>}
                    {r.status !== "done" && !r.submittedAt && <span className="adm-pill" style={{ background: "rgba(154,100,0,.10)", color: "#9A6400" }}>Client still adding notes</span>}
                    {r.status !== "done" && r.submittedAt && r.unsent > 0 && <span className="adm-pill" style={{ background: "rgba(154,100,0,.10)", color: "#9A6400" }}>{r.unsent} new, not sent yet</span>}
                    {r.items.length > 0 && <span className="adm-pill" style={{ background: "var(--color-fog)", color: "var(--color-ink-soft)" }}>{r.items.length} photo{r.items.length === 1 ? "" : "s"}</span>}
                    {vc.length > 0 && <span className="adm-pill" style={{ background: "var(--color-fog)", color: "var(--color-ink-soft)" }}>{vc.length} timestamped note{vc.length === 1 ? "" : "s"}</span>}
                    <span className="adm-pill" style={{ background: c.bg, color: c.fg }}>{LABEL[r.status]}</span>
                  </span>
                </div>
                {r.needsReview && r.reviewNote && r.status !== "done" && <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "#9A6400" }}>{r.reviewNote}</p>}
                {r.notes.trim() && <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{r.notes}</p>}
                {r.sourceText?.trim() && (
                  <div style={{ display: "grid", gap: 4 }}>
                    <span className="faint" style={{ fontSize: 11.5, letterSpacing: ".08em", textTransform: "uppercase" }}>What they wrote</span>
                    <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap", borderLeft: "3px solid var(--color-line)", paddingLeft: 10 }}>{r.sourceText}</p>
                  </div>
                )}
                {vc.length > 0 && (
                  <ol className="rv-items">
                    {vc.map((it) => (
                      <li key={it.id} className="rv-item rv-item--video">
                        <span className="rv-item__tc adm-mono">{fmtTimecode(it.atMs)}</span>
                        <span className="rv-item__body">
                          <span className="rv-item__file adm-mono">{it.filename}</span>
                          <span className="rv-item__note">{it.note}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                {r.items.length > 0 ? (
                  <ol className="rv-items">
                    {r.items.map((it, n) => {
                      const thumb = it.thumbUrl ?? (it.mediaId ? `/api/studio/thumb/${it.mediaId}` : null);
                      return (
                        <li key={it.id} className={`rv-item${it.sent ? "" : " is-unsent"}`}>
                          <span className="rv-item__n adm-mono">{n + 1}</span>
                          <span className="rv-item__thumb">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {thumb ? <img src={thumb} alt="" loading="lazy" /> : null}
                          </span>
                          <span className="rv-item__body">
                            <span className="rv-item__file adm-mono">{it.filename}</span>
                            <span className="rv-item__note">{it.note}</span>
                            <span className="rv-item__when">{fmtWhen(it.updatedAt)}{it.sent ? "" : " · not sent yet"}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  r.filenames.length > 0 && vc.length === 0 && (
                    <div className="flex flex-wrap" style={{ gap: 6 }}>
                      {r.filenames.map((f) => <span key={f} className="adm-mono" style={{ background: "var(--color-fog)", padding: "4px 8px", borderRadius: 6 }}>{f}</span>)}
                    </div>
                  )
                )}
                <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                  {(["new", "in_progress", "done"] as RevisionStatus[]).map((s) => (
                    <form key={s} action={setRevisionStatus.bind(null, r.id, s, here)}>
                      <button type="submit" className={`adm-chip${r.status === s ? " adm-chip--on" : " adm-chip--quiet"}`} disabled={r.status === s}>{LABEL[s]}</button>
                    </form>
                  ))}
                  <form action={setRevisionKind.bind(null, r.id, mk === "video" ? "photo" : "video", here)}>
                    <button type="submit" className="adm-chip adm-chip--quiet" title="For a request tagged the wrong way">Tag as {mk === "video" ? "photo" : "video"}</button>
                  </form>
                  <span style={{ flex: 1 }} />
                  {r.resolvedAt && <span className="faint" style={{ fontSize: 12 }}>done {fmtWhen(r.resolvedAt)}{r.resolvedBy ? ` by ${r.resolvedBy}` : ""}</span>}
                  {onShoot.get(r.id) && <Link href={`/admin/shoots/${onShoot.get(r.id)}#revision`} className="adm-chip adm-chip--on">Open the photos →</Link>}
                  <Link href={`/admin/listings/${r.listingId}`} className="adm-chip adm-chip--quiet">Listing →</Link>
                  {admin && <Link href={`/portal/${r.slug}`} className="adm-chip adm-chip--quiet" title="Open the gallery (view as the client first to see their view)">Gallery ↗</Link>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
