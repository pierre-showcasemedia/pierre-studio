"use client";
// The Photo QC board's columns and cards (Oct 26 2026; a client component
// since Nov 6 2026 so a card moves at once). A card opens the shoot page or
// the revision; every card, revision cards too, ends in the status bar, the
// Video board's menu (StageSelect): pick a column and the card moves there, saved by
// setPhotoQcStatus. A refusal puts the card back with a note, as on Video.
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { setPhotoQcStatus } from "@/app/admin/photo-qc-actions";
import type { PhotoQcCard, PhotoQcColumn } from "@/lib/photo-qc";
import { fmtDate, fmtWhen } from "@/lib/shoot-status";
import { BoardTabs } from "./BoardTabs";
import { StageSelect } from "./StageSelect";
import "@/styles/admin-video.css";

type Columns = readonly { key: PhotoQcColumn; label: string; hint: string }[];

const initials = (email: string) => email.split("@")[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

function Card({ c, col, columns, onMove }: { c: PhotoQcCard; col: PhotoQcColumn; columns: Columns; onMove: (c: PhotoQcCard, to: PhotoQcColumn) => void }) {
  const flags: { t: string; tone?: "ok" | "rev" | "warn" }[] = [];
  if (c.qc) {
    if (c.qc.blocked) flags.push({ t: `${c.qc.blocked} blocked`, tone: "rev" });
    if (c.qc.fix) flags.push({ t: `${c.qc.fix} to fix`, tone: "warn" });
    if (!c.qc.blocked && !c.qc.fix) flags.push({ t: "QC clean", tone: "ok" });
  }
  if (c.waiting) flags.unshift({ t: `${c.waiting} to publish`, tone: "warn" });
  if (col === "final") flags.unshift({ t: "Final pass", tone: "warn" });
  // Oct 30 2026: a client's revision round on the shoot (its own section on the shoot page).
  const rev = c.revision && (c.revision.fixed || c.revision.waiting) ? c.revision : null;
  if (rev) flags.unshift({ t: rev.fixed ? `Revision · ${rev.fixed} fixed` : `Revision · ${rev.waiting} to fix`, tone: "rev" });
  return (
    <article className={`vb-card pqc-card${col === "review" || col === "final" ? " pqc-card--go" : ""}${col === "stopped" || col === "revisions" ? " has-revision" : ""}`}>
    <Link href={c.href} className="vb-card__body" aria-label={`Open ${c.street}`}>
      <span className="vb-card__link">
        <span className="vb-card__street">{c.nda ? `${c.street} · NDA` : c.street}</span>
        <span className="vb-card__client">{c.clientName ?? "No client"}</span>
      </span>
      <span className="vb-card__meta">
        {col === "editing" && <span>{c.step}</span>}
        {c.at && <span>{col === "editing" ? "Uploaded" : col === "review" ? "Ready" : col === "final" ? "Sent" : col === "published" ? "Published" : col === "revisions" ? "Sent" : "Stopped"} {fmtWhen(c.at)}</span>}
      </span>
      <span className="vb-card__tags">
        {/* Nov 2 2026 (20 Dogwood): the shoot's upload date on every card, and
            "Shoot 1 of 2" when a listing has more than one shoot on the board, so two
            shoot days never read as a duplicate listing. In editing the line above
            already says Uploaded and when. */}
        {c.nth ? (
          <span className="vb-tag vb-tag--speed">Shoot {c.nth.n} of {c.nth.of} · uploaded {fmtDate(c.uploadedAt)}</span>
        ) : c.uploadedAt && col !== "editing" ? (
          <span className="vb-tag">Uploaded {fmtDate(c.uploadedAt)}</span>
        ) : null}
        {c.frames != null && <span className="vb-tag">{c.frames} {col === "editing" ? "photos in" : "frames"}</span>}
        {c.twilight > 0 && <span className="vb-tag">{c.twilight} twilight</span>}
        {c.corrected != null && c.corrected > 0 && <span className="vb-tag vb-tag--speed">{c.corrected} corrected</span>}
        {c.photos != null && <span className="vb-tag">{c.photos} photo{c.photos === 1 ? "" : "s"}</span>}
        {col === "revisions" && <span className="vb-tag vb-tag--speed">{c.step}</span>}
        {c.qc?.avg != null && <span className="vb-tag vb-tag--speed">QC {c.qc.avg.toFixed(1)}</span>}
      </span>
      {c.error && <span className="pqc-error">{c.error.slice(0, 140)}</span>}
      <span className="vb-card__foot">
        <span className="vb-card__flags">
          {flags.map((f) => (
            <span key={f.t} className={`vb-flag${f.tone === "ok" ? " vb-flag--ok" : f.tone === "rev" ? " vb-flag--rev" : f.tone === "warn" ? " pqc-flag--warn" : ""}`}>{f.t}</span>
          ))}
          {col === "revisions" && c.by && <span className="vb-flag">{c.by}</span>}
        </span>
        {c.by && col !== "revisions" && <span className="vb-who" title={c.by}>{initials(c.by)}</span>}
      </span>
      {rev?.fixed ? (
        <span className="pqc-go">Check the {rev.fixed} revised, then publish →</span>
      ) : (
        <>
          {col === "review" && <span className="pqc-go">{c.waiting ? "Publish the corrected frames →" : "Review the frames →"}</span>}
          {col === "final" && <span className="pqc-go">Final pass, then publish →</span>}
        </>
      )}
      {col === "revisions" && c.href.includes("#revision") && <span className="pqc-go">Open the photos →</span>}
    </Link>
    {/* Nov 6 2026: the status bar, as on the Video board. */}
    {c.menu && (
      <div className="pqc-status" title={c.pick ? `Moved here by ${c.pick.by ?? "the team"} on ${fmtWhen(c.pick.at)}` : undefined}>
        <StageSelect value={col} stages={columns} name={c.street} onChange={(to) => onMove(c, to)} />
      </div>
    )}
    </article>
  );
}

export function PhotoQcBoard({ board, columns, initial }: { board: Record<PhotoQcColumn, PhotoQcCard[]>; columns: Columns; initial: PhotoQcColumn }) {
  const [cards, setCards] = useState(() => columns.flatMap((col) => board[col.key].map((c) => ({ c, col: col.key }))));
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const byCol = useMemo(() => {
    const m = new Map<PhotoQcColumn, PhotoQcCard[]>(columns.map((col) => [col.key, []]));
    for (const x of cards) m.get(x.col)?.push(x.c);
    return m;
  }, [cards, columns]);

  const move = (card: PhotoQcCard, to: PhotoQcColumn) => {
    const before = cards.find((x) => x.c === card);
    const menu = card.menu;
    if (!before || before.col === to || !menu) return;
    setError(null);
    setCards((xs) => xs.map((x) => (x.c === card ? { ...x, col: to } : x)));
    start(async () => {
      const r = await setPhotoQcStatus(menu, to).catch(() => ({ ok: false, error: "That did not save. Try again." }));
      if (!r.ok) {
        setCards((xs) => xs.map((x) => (x.c === card ? before : x)));
        setError(r.error ?? "That did not save. Try again.");
      }
    });
  };

  return (
    <>
      {error && (
        <p className="adm-banner adm-banner--bad" role="alert" style={{ marginTop: 18 }}>
          {error}
        </p>
      )}
      <BoardTabs id="pqc-board" initial={initial} tabs={columns.map((c) => ({ key: c.key, label: c.label, count: byCol.get(c.key)?.length ?? 0, hot: c.key === "review" || c.key === "final" }))}>
      <div className="vb-board pqc-board" aria-label="Photo QC board">
        {columns.map((col) => {
          const list = byCol.get(col.key) ?? [];
          return (
            <section key={col.key} data-col={col.key} className={`vb-col${(col.key === "review" || col.key === "final") && list.length ? " pqc-col--hot" : ""}`} aria-label={col.label}>
              <header className="vb-col__head">
                <span className="vb-col__label">{col.label}</span>
                <span className="vb-col__n">{list.length}</span>
              </header>
              <p className="vb-col__hint">{col.hint}</p>
              <div className="vb-col__cards">
                {list.length === 0 && <div className="vb-empty">Nothing here</div>}
                {list.map((c) => <Card key={c.id} c={c} col={col.key} columns={columns} onMove={move} />)}
              </div>
            </section>
          );
        })}
      </div>
      </BoardTabs>
    </>
  );
}
