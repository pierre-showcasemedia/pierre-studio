"use client";
// The Video board's columns (Oct 26 2026). Drag a card to another column on
// a computer, or use its Move to menu (phones, keyboards). The move shows at
// once and is saved by moveVideoCard; a refusal puts the card back with a
// note. A card opens its page, which holds the video side of the booking:
// the whole card is the link (Nov 5 2026; it used to be the street only, so
// a tap on the tags or the red revision border did nothing), the Move to
// menu at the foot is the one part that is not.
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { moveVideoCard } from "@/app/admin/video/actions";
import type { VideoCard, VideoStage } from "@/lib/video-board";
import { BoardTabs } from "./BoardTabs";
import { StageSelect } from "./StageSelect";
import "@/styles/admin-video.css";

const STAGES: { key: VideoStage; label: string; hint: string }[] = [
  { key: "queue", label: "In queue", hint: "Not shot yet, or no footage in" },
  { key: "editing", label: "In editing", hint: "Footage in Dropbox, being cut" },
  { key: "review", label: "In review", hint: "A cut uploaded, check it" },
  { key: "sent", label: "Sent to client", hint: "Delivered, with the agent" },
  { key: "complete", label: "Complete", hint: "3 days after delivery, last 30 days" },
];

const day = (ymd: string | null) => {
  // Never let one odd date take the whole board down.
  if (typeof ymd !== "string" || !ymd) return null;
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};
const initials = (email: string) => email.split("@")[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

export function VideoBoard({ cards: initial }: { cards: VideoCard[] }) {
  const [cards, setCards] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<VideoStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const byStage = useMemo(() => {
    const m = new Map<VideoStage, VideoCard[]>(STAGES.map((s) => [s.key, []]));
    for (const c of cards) m.get(c.stage)?.push(c);
    return m;
  }, [cards]);

  // On a phone the board shows one column at a time: open where the work is
  // (a cut to check, then whatever is being cut, then the queue).
  const firstStage = (["review", "editing", "queue"] as VideoStage[]).find((k) => (byStage.get(k)?.length ?? 0) > 0) ?? "queue";

  const move = (id: string, stage: VideoStage) => {
    const before = cards.find((c) => c.id === id);
    if (!before || before.stage === stage) return;
    setError(null);
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, stage, stageChangedAt: new Date().toISOString() } : c)));
    start(async () => {
      const r = await moveVideoCard(id, stage).catch(() => ({ ok: false, error: "That did not save. Try again." }));
      if (!r.ok) {
        setCards((cs) => cs.map((c) => (c.id === id ? before : c)));
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
      <BoardTabs id="vb-board" initial={firstStage} tabs={STAGES.map((s) => ({ key: s.key, label: s.label, count: byStage.get(s.key)?.length ?? 0, hot: s.key === "review" }))}>
      <div className="vb-board" aria-label="Video board">
        {STAGES.map((s) => {
          const list = byStage.get(s.key) ?? [];
          return (
            <section
              key={s.key}
              data-col={s.key}
              className={`vb-col${over === s.key && dragging ? " is-over" : ""}`}
              aria-label={s.label}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== s.key) setOver(s.key);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === s.key ? null : o));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain") || dragging;
                setOver(null);
                setDragging(null);
                if (id) move(id, s.key);
              }}
            >
              <header className="vb-col__head">
                <span className="vb-col__label">{s.label}</span>
                <span className="vb-col__n">{list.length}</span>
              </header>
              <p className="vb-col__hint">{s.hint}</p>
              <div className="vb-col__cards">
                {list.length === 0 && <div className="vb-empty">Nothing here</div>}
                {list.map((c) => (
                  <article
                    key={c.id}
                    className={`vb-card${dragging === c.id ? " is-dragging" : ""}${c.revision && c.revision.status !== "done" ? " has-revision" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", c.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(c.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                  >
                    <Link href={`/admin/video/${c.id}`} className="vb-card__body" draggable={false} aria-label={`Open ${c.street}`}>
                    <span className="vb-card__link">
                      <span className="vb-card__street">{c.nda ? `${c.street} · NDA` : c.street}</span>
                      <span className="vb-card__client">{c.clientName ?? "No client"}</span>
                    </span>
                    <div className="vb-card__meta">
                      {day(c.shootDate) && <span>Shot {day(c.shootDate)}</span>}
                      {day(c.launchDate) && <span>Launch {day(c.launchDate)}</span>}
                    </div>
                    {c.services.length > 0 && (
                      <div className="vb-card__tags">
                        {c.services.slice(0, 4).map((x) => (
                          <span key={x} className="vb-tag">
                            {x}
                          </span>
                        ))}
                        {c.speed && <span className="vb-tag vb-tag--speed">{c.speed}</span>}
                      </div>
                    )}
                    <div className="vb-card__foot">
                      <span className="vb-card__flags">
                        {c.revision && c.revision.status !== "done" && (
                          <span className="vb-flag vb-flag--rev" title={`${c.revision.comments} timestamped note${c.revision.comments === 1 ? "" : "s"}`}>
                            Revision {c.revision.round}
                          </span>
                        )}
                        <span className={`vb-flag${c.footage ? " vb-flag--ok" : ""}`}>{c.footage ? "Footage in" : "No footage yet"}</span>
                        {c.films > 0 && (
                          <span className="vb-flag">
                            {c.films} film{c.films === 1 ? "" : "s"}
                            {c.filmsLive ? `, ${c.filmsLive} live` : ""}
                          </span>
                        )}
                      </span>
                      {c.assignee ? (
                        <span className="vb-who" title={c.assignee}>
                          {initials(c.assignee)}
                        </span>
                      ) : (
                        <span className="vb-who vb-who--none" title="Not assigned">
                          ?
                        </span>
                      )}
                    </div>
                    </Link>
                    <StageSelect value={c.stage} stages={STAGES} name={c.street} onChange={(stage) => move(c.id, stage)} />
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      </BoardTabs>
    </>
  );
}
