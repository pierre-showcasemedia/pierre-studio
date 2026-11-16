"use client";
// QC grid for a shoot: approve or reject each frame, approve all, open a
// bigger view with keyboard shortcuts (arrows, A, R, Esc). Polls the status
// route while the pipeline is working and refreshes the page as it moves.
//
// v1.2: every frame carries the automatic QC result (score, issues, notes),
// the grid can filter to flagged frames and sort by score, frames can be
// selected and downloaded for editing, and badges show corrected finals.
//
// Oct 2026: every frame reads "Client visible" or "Internal only" (with the
// reason: src/lib/visibility.ts) and toggles between the two, one at a time
// or for a selection (setMediaVisibility). "Internal only" lists everything
// the client cannot see, and downloads as one zip. Admins and the QA team.
//
// Oct 28 2026 (the owner: "clean up this process ... much more efficient for our
// QC team, and then for us for final approval, and then for getting them out
// to the client"): the grid is split into sections, Gallery (the editing
// service's frames), Revised (every corrected frame the editors sent back;
// called Final review until Nov 3 2026, the coordinator: "the reuploaded photos
// should be in a Revised category") and Twilight, then any other section, each with Select all and a
// collapse. Every frame has a checkbox (shift-click selects a run), and a
// bar at the bottom acts on the selection: Publish, Unpublish, Approve,
// Reject, Download, Delete (admins). Publishing is live at once
// (src/lib/frame-publish.ts publishes the shoot with them if it never was).
//
// Oct 30 2026 (the owner: revised photos "get blended together with all of the
// other QC photos, and then they're hard for us to find"): the photos a client
// asked to change sit in their own Revision section at the very top
// (src/lib/revision-frames.ts), each with the client's note and whether the
// fix is in. "Publish N fixed" sends just those; the opened frame shows the
// note and flips between Before and After (B).
//
// Oct 28 2026 (phones): an opened frame fills the screen (FrameViewer).
// Swipe sideways for the next or previous frame, down to close; Reject,
// Approve and Publish sit in one row in thumb reach, the automatic QC notes
// fold above them, and Download and Make twilight sit below.
//
// Nov 2 2026 (the owner: "ONLY approved photos should be published ... so NO
// MISTAKES are made as far as what clients can see"): one Publish bar on top
// of the grid says exactly how many approved photos go and where; every
// Publish (bar, selection, a photo's own button, the opened photo) sends
// approved photos only (src/lib/publish-plan.ts), and reports what is now
// visible to the client. Rejected photos drop into a Rejected section at the
// bottom, folded by default and never client visible; rejecting a live photo
// takes it off the listing. After the first delivery, new photos go to the
// client's "Revised images" section unless the team picks the main gallery.
// Sections fold with motion (.sr-fold). The opened photo keeps its own layer
// through any page transition (.srl view-transition-name), and QC marks no
// longer refresh the page, which is what made a photo close and reopen on R
// or A.
import { DownloadIcon } from "@/components/gallery/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminFrame } from "@/lib/admin-types";
import type { QcIssue, QcState, ShootStatus } from "@/db/schema";
import { approveAllFrames, setFrameQc } from "@/app/admin/actions";
import { setMediaVisibility } from "@/app/admin/visibility-actions";
import { deleteShootFrames, publishShootFrames } from "@/app/admin/frame-actions";
import { makeFrameTwilight } from "@/app/admin/twilight-actions";
import { canPublishFrom, fmtWhen, isActive } from "@/lib/shoot-status";
import type { RevisionFrame } from "@/lib/revision-frames";
import { approveAllSkips, ISSUE_LABELS, qcFixKey, qcFixProgress, worstSeverity, type QcFixDone } from "@/lib/qc-labels";
import { setQcFixDone } from "@/app/admin/qc-fix-actions";
import { DESTINATION_LABEL, defaultDestination, NOTHING_APPROVED, photoWord, publishedBanner, publishLabel, publishPlan, type Destination } from "@/lib/publish-plan";
import { VISIBILITY_HINT, VISIBILITY_LABEL, visibilityOf, type Visibility } from "@/lib/visibility";

const gradient = (hue: number) => `linear-gradient(135deg, hsl(${hue} 28% 74%), hsl(${(hue + 40) % 360} 34% 44%))`;

function FrameImage({ f, demo, big = false }: { f: AdminFrame; demo: boolean; big?: boolean }) {
  const src = f.thumbUrl ?? (demo ? null : `/api/studio/thumb/${f.id}`);
  if (!src) return <div className="adm-frame__img" style={{ background: gradient(f.hue), aspectRatio: big ? "3 / 2" : undefined }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <div className="adm-frame__img" style={{ aspectRatio: big ? "3 / 2" : undefined }}><img src={src} alt={f.filename} loading="lazy" /></div>;
}

const TONE: Record<string, string> = { block: "#D7342A", fix: "#9A6400", minor: "#0066D6" };

function ScoreBadge({ f }: { f: AdminFrame }) {
  if (f.qcScore == null) return null;
  const sev = worstSeverity(f.qcIssues) ?? (f.qcScore >= 8 ? "clean" : "minor");
  const color = sev === "clean" ? "#1A7F4B" : TONE[sev];
  return <span className="adm-frame__qc adm-pill adm-pill--on-image" title={f.qcSummary ?? ""} style={{ color }}>QC {f.qcScore}</span>;
}

// Nov 2 2026 (the coordinator: "make each fix a checkbox that our QC team can
// checkmark to notate that each flag has been done"): with onTick, every flag
// is a checkbox; a ticked one reads "Done by Name · time" (src/lib/qc-fixes.ts).
function IssueList({ issues, suggestions, summary, light = false, fixes, onTick }: { issues: QcIssue[] | null; suggestions: string[] | null; summary: string | null; light?: boolean; fixes?: Record<string, QcFixDone>; onTick?: (fixKey: string, done: boolean) => void }) {
  if (!issues && !summary) return null;
  return (
    <div style={{ fontSize: 13, lineHeight: 1.55, color: light ? "rgba(255,255,255,.9)" : "inherit" }}>
      {summary && <p style={{ margin: 0 }}>{summary}</p>}
      {issues && issues.length > 0 && (onTick ? (
        <ul className="qc-fixes">
          {issues.map((i, k) => {
            const key = qcFixKey(i);
            const d = fixes?.[key];
            return (
              <li key={k} className={`qc-fix${d ? " is-done" : ""}`}>
                <label className="qc-fix__label">
                  <input type="checkbox" className="qc-fix__box" checked={Boolean(d)} onChange={(e) => onTick(key, e.target.checked)} />
                  <span className="qc-fix__text"><span style={{ color: TONE[i.severity], fontWeight: 500 }}>{i.severity}</span> · {ISSUE_LABELS[i.type]}: {i.note}</span>
                </label>
                {d && <span className="qc-fix__by">Done by {d.name ?? d.by} · {fmtWhen(d.at)}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {issues.map((i, k) => (
            <li key={k}><span style={{ color: TONE[i.severity], fontWeight: 500 }}>{i.severity}</span> · {ISSUE_LABELS[i.type]}: {i.note}</li>
          ))}
        </ul>
      ))}
      {suggestions && suggestions.length > 0 && (
        <p style={{ margin: "6px 0 0", opacity: .85 }}>Suggested: {suggestions.join(" ")}</p>
      )}
    </div>
  );
}

type Filter = "all" | "internal" | "client" | "flagged" | "pending" | "approved" | "rejected";

function VisBadge({ v, onImage = false }: { v: Visibility; onImage?: boolean }) {
  return (
    <span className={`vis-badge${onImage ? " vis-badge--on-image" : ""}`} data-vis={v === "client" ? "client" : "internal"} title={VISIBILITY_HINT[v]}>
      <span className="vis-badge__long">{v === "client" ? "Client visible" : "Internal only"}</span>
      {/* A phone's frame card has room for one word. */}
      <span className="vis-badge__short" aria-hidden>{v === "client" ? "Live" : "Internal"}</span>
    </span>
  );
}

// twilight (Oct 27 2026): "Make twilight" in the opened frame runs the
// Champagne preset on it (admins and Photo QC; null hides the button, a reason
// shows it greyed out with that reason).
type SectionKey = string; // "revision" | "gallery" | "final" | "twilight" | "s:<name>" | "rejected"
// A rejected frame sits in Rejected whatever else it is (Nov 2 2026).
const sectionKey = (f: AdminFrame): SectionKey => (f.qcState === "rejected" ? "rejected" : f.corrected ? "final" : !f.section ? "gallery" : f.section === "Twilight" ? "twilight" : `s:${f.section}`);
const SECTION_ORDER = (k: SectionKey) => (k === "revision" ? -1 : k === "gallery" ? 0 : k === "final" ? 1 : k === "twilight" ? 2 : k === "rejected" ? 9 : 3);
const sectionLabel = (k: SectionKey) => (k === "revision" ? "Revision" : k === "gallery" ? "Gallery" : k === "final" ? "Revised" : k === "twilight" ? "Twilight" : k === "rejected" ? "Rejected" : k.slice(2));

// The client's revision round on this shoot (the shoot page reads it).
export type RevisionView = { frames: Record<string, RevisionFrame>; summary: string };
const plural = (n: number, w = "frame") => `${n} ${w}${n === 1 ? "" : "s"}`;

export default function ShootReview({ shootId, listingId, status, frames: initial, demo, shootPublished, twilight = null, admin = false, revision = null }: { shootId: string; listingId: string; status: ShootStatus; frames: AdminFrame[]; demo: boolean; shootPublished: boolean; twilight?: { reason: string | null } | null; admin?: boolean; revision?: RevisionView | null }) {
  const router = useRouter();
  const [frames, setFrames] = useState<AdminFrame[]>(initial);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [published, setPublished] = useState(shootPublished);
  const visOf = useCallback((f: AdminFrame) => visibilityOf({ ...f, shootId }, published), [shootId, published]);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<"order" | "score">("order");
  const [busy, setBusy] = useState(false);
  const [twilightAsked, setTwilightAsked] = useState<Set<string>>(new Set());
  const askTwilight = async (f: AdminFrame) => {
    setTwilightAsked((s) => new Set(s).add(f.id));
    try {
      const r = await makeFrameTwilight(f.id);
      setNote(r);
      if (!r.ok) setTwilightAsked((s) => { const n = new Set(s); n.delete(f.id); return n; });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Could not start the twilight." });
      setTwilightAsked((s) => { const n = new Set(s); n.delete(f.id); return n; });
    }
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastPick, setLastPick] = useState<string | null>(null);
  // Rejected starts folded: it is the pile nobody ships.
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(() => new Set(["rejected"]));
  const [qcLive, setQcLive] = useState<{ done: number | null; total: number | null } | null>(null);
  // Where new photos go: the main gallery for the first delivery, Revised
  // images after it (swaps, fixes, additions), unless the team picks otherwise.
  const [destPick, setDest] = useState<Destination | null>(null);
  const dest: Destination = destPick ?? defaultDestination(published);
  // The server page keys this component on the shoot's updatedAt + frame
  // count, so fresh frames arrive as a remount rather than a prop sync.

  const live = isActive(status);
  useEffect(() => {
    if (!live) return;
    let last = "";
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/studio/shoots/${shootId}/status`, { cache: "no-store" });
        const j = await r.json();
        if (j.qcTotal != null) setQcLive({ done: j.qcDone ?? j.qcChecked ?? 0, total: j.qcTotal });
        const sig = `${j.status}:${j.photoCount}:${j.frameCount}:${j.qcChecked ?? ""}:${j.error ?? ""}`;
        if (last && sig !== last) router.refresh();
        last = sig;
      } catch {}
    }, 8000);
    return () => clearInterval(t);
  }, [live, shootId, router]);

  const flagged = useCallback((f: AdminFrame) => f.qcState === "rejected" || worstSeverity(f.qcIssues) !== null, []);

  const counts = useMemo(() => ({
    pending: frames.filter((f) => f.qcState === "pending").length,
    approvable: frames.filter((f) => f.qcState === "pending" && !approveAllSkips(f)).length,
    approved: frames.filter((f) => f.qcState === "approved").length,
    rejected: frames.filter((f) => f.qcState === "rejected").length,
    flagged: frames.filter(flagged).length,
    waiting: frames.filter((f) => visOf(f) === "waiting").length,
    held: frames.filter((f) => visOf(f) === "held").length,
    internal: frames.filter((f) => visOf(f) !== "client").length,
    live: frames.filter((f) => visOf(f) === "client").length,
    corrected: frames.filter((f) => f.corrected).length,
  }), [frames, flagged, visOf]);
  // What the Publish bar sends: approved, not live, not held back by hand.
  const plan = useMemo(() => publishPlan(frames, { shootPublished: published }), [frames, published]);

  // Publish: only the approved frames among ids go live, at once
  // (src/lib/frame-publish.ts). Rejected and unreviewed frames are left out
  // and the note says so. hideOthers is "Publish finals only". A first
  // publish reloads the page with a banner, since the shoot itself changes.
  // A stopped shoot (failed) publishes too: the photos the editors delivered
  // by hand, once approved (src/lib/shoot-status.ts canPublishFrom).
  const canPublish = canPublishFrom(status);
  const publish = useCallback(async (ids: string[], opts: { hideOthers?: boolean; dest?: Destination; includeHeld?: boolean } = {}) => {
    if (!ids.length || !canPublish) return;
    const where = opts.dest ?? dest;
    const p = publishPlan(frames, { pick: ids, includeHeld: opts.includeHeld, shootPublished: published });
    if (!p.ids.length) { setNote({ ok: false, text: NOTHING_APPROVED }); return; }
    const set = new Set(p.ids);
    setFrames((fs) => fs.map((f) => (set.has(f.id) ? { ...f, published: true, held: false, revision: where === "revised" && !f.section ? true : f.revision } : opts.hideOthers && f.qcState !== "rejected" ? { ...f, published: false, held: true } : f)));
    setPublished(true);
    if (demo) { setNote({ ok: true, text: `Demo mode: ${publishedBanner({ live: p.ids.length, dest: where, skipped: p })} Nothing saved.` }); return; }
    try {
      const r = await publishShootFrames({ shootId, ids: p.ids, hideOthers: opts.hideOthers, destination: where });
      if (!r.ok) { setNote({ ok: false, text: r.error }); router.refresh(); return; }
      if (r.firstPublish) { router.replace(`/admin/shoots/${shootId}?firstLive=${r.live ?? p.ids.length}&dest=${where}${r.hidden ? `&hidden=${r.hidden}` : ""}`); return; }
      setNote({ ok: true, text: publishedBanner({ live: r.live ?? p.ids.length, dest: where, hidden: r.hidden, skipped: r.skipped ?? p }) });
    } catch {
      setNote({ ok: false, text: "Could not reach the server. Check the connection and try again." });
      router.refresh();
    }
  }, [demo, shootId, router, canPublish, dest, frames, published]);

  // Unpublish: off the listing, kept internal (held). Optimistic.
  const unpublish = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const set = new Set(ids);
    const n = ids.length;
    setFrames((fs) => fs.map((f) => (set.has(f.id) ? { ...f, published: false, held: true } : f)));
    if (demo) { setNote({ ok: true, text: `Demo mode: ${plural(n)} moved to internal only, nothing saved.` }); return; }
    try {
      const r = await setMediaVisibility({ shootId, listingId, ids, to: "internal", via: "shoot" });
      if (!r.ok) { setNote({ ok: false, text: r.error }); router.refresh(); return; }
      setNote({ ok: true, text: `${plural(n)} moved to internal only. The client no longer sees ${n === 1 ? "it" : "them"}.` });
    } catch {
      setNote({ ok: false, text: "Could not reach the server. Check the connection and try again." });
      router.refresh();
    }
  }, [demo, shootId, listingId, router]);

  const remove = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    if (!window.confirm(`Delete ${plural(ids.length)} from this shoot? They leave the backend and the client gallery. The files stay in storage.`)) return;
    const set = new Set(ids);
    setFrames((fs) => fs.filter((f) => !set.has(f.id)));
    setSelected(new Set());
    if (demo) { setNote({ ok: true, text: `Demo mode: ${plural(ids.length)} removed, nothing saved.` }); return; }
    try {
      const r = await deleteShootFrames({ shootId, ids });
      if (!r.ok) { setNote({ ok: false, text: r.error }); router.refresh(); return; }
      router.replace(`/admin/shoots/${shootId}?deleted=${r.deleted ?? ids.length}#frames`);
    } catch {
      setNote({ ok: false, text: "Could not reach the server. Check the connection and try again." });
      router.refresh();
    }
  }, [demo, shootId, router]);

  // Approve or reject. A rejected photo leaves the listing at once (the
  // server does the same). Optimistic; the server never refreshes this page
  // for a mark, so the opened photo stays put.
  const mark = useCallback(async (ids: string[], state: QcState) => {
    const set = new Set(ids);
    const pulled = state === "rejected" ? frames.filter((f) => set.has(f.id) && visOf(f) === "client").length : 0;
    setFrames((fs) => fs.map((f) => (set.has(f.id) ? (state === "rejected" ? { ...f, qcState: state, published: false } : { ...f, qcState: state }) : f)));
    if (pulled) setNote({ ok: true, text: `${plural(pulled, "photo")} rejected and taken off the listing. The client no longer sees ${pulled === 1 ? "it" : "them"}.` });
    if (demo) return;
    try { await setFrameQc(shootId, ids, state); } catch { router.refresh(); }
  }, [demo, shootId, router, frames, visOf]);

  // Tick a QC flag done, or untick it (Nov 2 2026). Optimistic with the
  // staff member's own email until the server answers with the saved row.
  const tickFix = useCallback(async (mediaId: string, fixKey: string, done: boolean) => {
    const setFix = (v: QcFixDone | null) => setFrames((fs) => fs.map((f) => {
      if (f.id !== mediaId) return f;
      const next = { ...(f.qcFixes ?? {}) };
      if (v) next[fixKey] = v; else delete next[fixKey];
      return { ...f, qcFixes: next };
    }));
    const before = frames.find((f) => f.id === mediaId)?.qcFixes?.[fixKey] ?? null;
    setFix(done ? before ?? { by: "you", name: "you", at: new Date().toISOString() } : null);
    try {
      const r = await setQcFixDone({ shootId, mediaId, fixKey, done });
      if (r.ok) setFix(r.done);
      else { setFix(before); setNote({ ok: false, text: r.error }); }
    } catch {
      setFix(before);
      setNote({ ok: false, text: "Could not save that tick. Try again." });
    }
  }, [shootId, frames]);

  const approveAll = async () => {
    setBusy(true);
    // A photo with a block flag stays for a person (approveAllSkips, Nov 3 2026).
    setFrames((fs) => fs.map((f) => (f.qcState === "pending" && !approveAllSkips(f) ? { ...f, qcState: "approved" } : f)));
    if (!demo) { try { await approveAllFrames(shootId); } catch {} }
    setBusy(false);
  };

  const visible = useMemo(() => {
    let v = frames.filter((f) =>
      filter === "all" ? true
      : filter === "flagged" ? flagged(f)
      : filter === "internal" ? visOf(f) !== "client"
      : filter === "client" ? visOf(f) === "client"
      : f.qcState === filter
    );
    if (sort === "score") v = [...v].sort((a, b) => (a.qcScore ?? 11) - (b.qcScore ?? 11) || a.sort - b.sort);
    return v;
  }, [frames, filter, sort, flagged, visOf]);

  const sections = useMemo(() => {
    const m = new Map<SectionKey, AdminFrame[]>();
    for (const f of visible) { const k = f.qcState === "rejected" ? "rejected" : revision?.frames[f.id] ? "revision" : sectionKey(f); if (!m.has(k)) m.set(k, []); m.get(k)!.push(f); }
    return [...m.entries()].sort((a, b) => SECTION_ORDER(a[0]) - SECTION_ORDER(b[0]) || a[0].localeCompare(b[0]));
  }, [visible, revision]);
  // The lightbox and shift-click walk the frames in the order they show.
  const ordered = useMemo(() => sections.flatMap(([k, l]) => (collapsed.has(k) ? [] : l)), [sections, collapsed]);

  // A click toggles one frame; shift-click sets the whole run from the last one picked.
  const pick = (id: string, shift: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      const a = shift && lastPick ? ordered.findIndex((f) => f.id === lastPick) : -1;
      const b = ordered.findIndex((f) => f.id === id);
      if (a >= 0 && b >= 0 && a !== b) {
        const on = !s.has(id);
        for (const f of ordered.slice(Math.min(a, b), Math.max(a, b) + 1)) { if (on) n.add(f.id); else n.delete(f.id); }
        return n;
      }
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    setLastPick(id);
  };
  const allIn = (list: AdminFrame[]) => list.length > 0 && list.every((f) => selected.has(f.id));
  const selectList = (list: AdminFrame[]) => setSelected((s) => { const all = list.every((f) => s.has(f.id)); const n = new Set(s); for (const f of list) { if (all) n.delete(f.id); else n.add(f.id); } return n; });
  const toggleSection = (k: SectionKey) => setCollapsed((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // Approved finals not live yet: what "Publish finals only" sends.
  const finals = frames.filter((f) => f.corrected);
  const finalsPlan = useMemo(() => publishPlan(frames.filter((f) => f.corrected), { shootPublished: published }), [frames, published]);
  // Revision photos whose fix is in, approved and not live yet: what "Publish N fixed" sends.
  const revFixedIds = useMemo(() => publishPlan(frames.filter((f) => revision?.frames[f.id]?.fixedAt), { shootPublished: published }).ids, [frames, revision, published]);
  const selPlan = useMemo(() => publishPlan(frames, { pick: selected, includeHeld: true, shootPublished: published }), [frames, selected, published]);
  const publishFinals = () => {
    const others = frames.filter((f) => !finalsPlan.ids.includes(f.id) && visOf(f) === "client").length;
    if (!finalsPlan.ids.length) { setNote({ ok: false, text: NOTHING_APPROVED }); return; }
    if (!window.confirm(`Publish the ${finalsPlan.ids.length} approved final ${photoWord(finalsPlan.ids.length)} to the client now${others ? ` and take the other ${plural(others, "live photo")} of this shoot off the listing` : ""}? Every other photo of this shoot moves to internal only. Nothing is deleted.`)) return;
    void publish(finalsPlan.ids, { hideOthers: true });
  };
  const downloadHref = (scope: "all" | "flagged" | "internal" | "selected", ids?: string[]) => `/api/studio/shoots/${shootId}/download?scope=${scope}${ids?.length ? `&ids=${ids.join(",")}` : ""}`;

  // Lightbox keys
  useEffect(() => {
    if (open == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") setOpen((i) => (i == null ? i : Math.min(ordered.length - 1, i + 1)));
      if (e.key === "ArrowLeft") setOpen((i) => (i == null ? i : Math.max(0, i - 1)));
      const f = ordered[open];
      if (f && (e.key === "a" || e.key === "A")) mark([f.id], "approved");
      if (f && (e.key === "r" || e.key === "R")) mark([f.id], "rejected");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, ordered, mark]);
  // The large photos either side of the opened one, warmed by the viewer.
  const preload = useMemo(() => (open == null ? [] : [open - 1, open + 1, open + 2].map((i) => ordered[i]?.largeUrl ?? null)), [open, ordered]);

  if (!frames.length) {
    return (
      <p className="muted" style={{ fontSize: 14, padding: "14px 0" }}>
        {live ? "Frames appear here as soon as editing finishes pulling them in." : "No frames on this shoot yet."}
      </p>
    );
  }

  // Demo mode shows the controls; the routes answer 503 without storage.
  const canDownload = true;
  const publishTitle = !canPublish ? "Available once the frames are in and QC has run." : plan.ids.length ? "Only approved photos go to the client. Rejected and unreviewed photos stay internal only." : counts.pending ? "Nothing approved yet. Approve the photos that should ship; rejected and unreviewed photos never go." : "Every approved photo is already live.";

  return (
    <div className={selected.size ? "sr-selecting" : undefined} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14 }}>
      {canPublish && (
        <div className="sr-publish" id="publish" role="region" aria-label="Publish">
          <div className="sr-publish__facts">
            <span className="kicker" style={{ margin: 0 }}>Publish</span>
            <span className="sr-publish__fact" data-tone="ok" title="Approved and not on the listing yet: what Publish sends."><strong>{plan.ids.length}</strong> approved to publish</span>
            <span className="sr-publish__fact" title="What the client sees now."><strong>{counts.live}</strong> live</span>
            <span className="sr-publish__fact" data-tone="bad" title="Never visible to the client. Un-reject a photo to review it again."><strong>{counts.rejected}</strong> rejected, never visible</span>
            <span className="sr-publish__fact" title="Not reviewed yet. They stay internal until approved; Publish leaves them out."><strong>{counts.pending}</strong> unreviewed, stay internal</span>
            {counts.held > 0 && <span className="sr-publish__fact" title="Moved to internal only by hand. Publish leaves them alone."><strong>{counts.held}</strong> held back</span>}
          </div>
          <div className="sr-publish__act">
            {published && (
              <div className="sr-publish__dest" title="The first delivery went to the main gallery. Swaps, fixes and additions after it go to Revised images, a section of its own at the top of the client's gallery, so everyone can tell what changed.">
                <span className="muted">New photos go to</span>
                <div className="adm-seg" role="radiogroup" aria-label="Where new photos go">
                  {(["revised", "gallery"] as Destination[]).map((d) => (
                    <button key={d} type="button" role="radio" aria-checked={dest === d} className={dest === d ? "is-active" : ""} onClick={() => setDest(d)}>{DESTINATION_LABEL[d]}</button>
                  ))}
                </div>
              </div>
            )}
            <button type="button" className="btn btn-primary" disabled={!plan.ids.length} onClick={() => void publish(plan.ids)} title={publishTitle}>{publishLabel(plan.ids.length, published ? dest : "gallery")}</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
        <div className="adm-seg" role="tablist" aria-label="Filter frames" style={{ flexWrap: "wrap" }}>
          {([
            ["all", `All ${frames.length}`],
            ["internal", `Internal only ${counts.internal}`],
            ["client", `Client visible ${counts.live}`],
            ["flagged", `Flagged ${counts.flagged}`],
            ["pending", `To review ${counts.pending}`],
            ["approved", `Approved ${counts.approved}`],
            ["rejected", `Rejected ${counts.rejected}`],
          ] as [Filter, string][]).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? "is-active" : ""} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <div className="adm-actions sr-tools" style={{ alignItems: "center" }}>
          <div className="adm-seg" aria-label="Sort frames">
            <button type="button" className={sort === "order" ? "is-active" : ""} onClick={() => setSort("order")}>Gallery order</button>
            <button type="button" className={sort === "score" ? "is-active" : ""} onClick={() => setSort("score")} disabled={!frames.some((f) => f.qcScore != null)}>Worst first</button>
          </div>
          {counts.approvable > 0 && <button type="button" className="adm-chip adm-chip--ok" disabled={busy} onClick={approveAll} title={`Marks every unreviewed photo approved${counts.pending > counts.approvable ? `, except the ${counts.pending - counts.approvable} with a block flag: open those and approve them one by one` : ""}. Nothing is published until you press Publish.`}>Approve all {counts.approvable} remaining</button>}
          {live && <span className="adm-pill" style={{ background: "rgba(0,102,214,.09)", color: "#0066D6" }}><span className="adm-dot adm-dot--live" />{status === "qc" && qcLive?.total != null ? `QC ${qcLive.done ?? 0} of ${qcLive.total}` : "Live"}</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
        <div className="vis-strip">
          <span><span className="vis-badge" data-vis="client">Client visible</span> <strong>{counts.live}</strong></span>
          <span><span className="vis-badge" data-vis="internal">Internal only</span> <strong>{counts.internal}</strong></span>
          {counts.waiting ? <span>{counts.waiting} approved, not published</span> : null}
          {counts.held ? <span>{counts.held} held back</span> : null}
          {counts.corrected ? <span>{counts.corrected} corrected</span> : null}
        </div>
        <div className="adm-actions sr-tools" style={{ alignItems: "center" }}>
          {counts.internal > 0 && <a className="adm-chip adm-chip--quiet" href={downloadHref("internal")} title="Zip of every frame the client cannot see, at full resolution"><DownloadIcon />Download internal ({counts.internal})</a>}
          <a className="adm-chip adm-chip--quiet" href={downloadHref("all")} title="Zip of every frame at full resolution"><DownloadIcon />Download all for editing</a>
          {counts.flagged > 0 && <a className="adm-chip adm-chip--quiet" href={downloadHref("flagged")} title="Zip of flagged and rejected frames"><DownloadIcon />Download flagged ({counts.flagged})</a>}
          <button type="button" className="adm-chip adm-chip--quiet" onClick={() => selectList(ordered)} disabled={!ordered.length}>{allIn(ordered) ? "Clear selection" : `Select all ${ordered.length} shown`}</button>
        </div>
      </div>

      {note && <p className={`adm-banner ${note.ok ? "adm-banner--ok" : "adm-banner--bad"}`} style={{ margin: 0 }} role="status">{note.text}</p>}

      {sections.map(([key, list]) => {
        const shut = collapsed.has(key);
        const liveN = list.filter((f) => visOf(f) === "client").length;
        const blurb =
          key === "revision" ? revision?.summary
          : key === "final" ? "Re-uploaded by the editors. Internal only until published. Run QC again on them, tick each flag, then send for final review."
          : key === "gallery" && finals.length ? "Photos not re-uploaded yet. Publish finals only hides them from the client."
          : key === "rejected" ? "Never visible to the client. Un-reject a photo to review it again."
          : "";
        return (
          <section key={key} id={key === "final" ? "revised" : key === "revision" ? "revision" : key === "rejected" ? "rejected" : undefined} className={`sr-section${key === "final" ? " sr-section--final" : key === "revision" ? " sr-section--revision" : key === "rejected" ? " sr-section--rejected" : ""}`} aria-label={sectionLabel(key)}>
            <header className="sr-section__head">
              <div className="sr-section__title">
                <span className="kicker" style={{ margin: 0 }}>{sectionLabel(key)} · {list.length}</span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {blurb}
                  {liveN && key !== "revision" ? `${blurb ? " " : ""}${liveN} client visible.` : ""}
                </span>
              </div>
              <div className="adm-actions" style={{ alignItems: "center" }}>
                {key === "revision" && canPublish && revFixedIds.length > 0 && <button type="button" className="btn btn-primary" onClick={() => void publish(revFixedIds, { dest: "revised" })} title="The approved fixes go live in the client's Revised images section. Nothing else changes.">{publishLabel(revFixedIds.length, "revised", { fixed: true })}</button>}
                {key === "final" && canPublish && finalsPlan.ids.length > 0 && <button type="button" className="btn btn-primary" onClick={publishFinals} title="The approved finals go live in the client gallery; every other photo of this shoot moves to internal only. Nothing is deleted.">{publishLabel(finalsPlan.ids.length, published ? dest : "gallery", { finals: true })}</button>}
                {!shut && <button type="button" className="adm-chip adm-chip--quiet" onClick={() => selectList(list)}>{allIn(list) ? "Deselect all" : `Select all ${list.length}`}</button>}
                <button type="button" className="adm-chip adm-chip--quiet" onClick={() => toggleSection(key)} aria-expanded={!shut} aria-controls={`fold-${key}`}>{shut ? "Show" : "Collapse"}</button>
              </div>
            </header>
            {/* The frames stay in the page while folded, so the fold can ease shut and open (admin-visibility.css .sr-fold). */}
            <div className="sr-fold" data-open={shut ? "false" : "true"} id={`fold-${key}`}>
              <div className="sr-fold__in" inert={shut}>
                <div className="adm-frames">
                  {list.map((f) => {
                    const idx = ordered.indexOf(f);
                    const sev = worstSeverity(f.qcIssues);
                    const fixTally = qcFixProgress(f.qcIssues, f.qcFixes);
                    const isSel = selected.has(f.id);
                    const vis = visOf(f);
                    return (
                      <figure key={f.id} id={`frame-${f.id}`} className={`adm-frame is-${f.qcState}${isSel ? " is-selected" : ""}`} style={{ margin: 0 }}>
                        <button type="button" onClick={(e) => (selected.size && (e.metaKey || e.ctrlKey || e.shiftKey) ? pick(f.id, e.shiftKey) : setOpen(idx))} style={{ display: "block", border: 0, padding: 0, background: "none", cursor: "zoom-in", width: "100%" }} aria-label={`Open ${f.filename}`}>
                          <FrameImage f={f} demo={demo} />
                        </button>
                        <button type="button" className={`sr-check${isSel ? " is-on" : ""}`} onClick={(e) => pick(f.id, e.shiftKey)} aria-pressed={isSel} aria-label={`${isSel ? "Deselect" : "Select"} ${f.filename}`} title="Select (shift-click selects a run)">{isSel ? "✓" : ""}</button>
                        <ScoreBadge f={f} />
                        <span className="sr-pills">
                          {f.qcState !== "pending" && <span className="adm-pill adm-pill--on-image" style={{ color: f.qcState === "approved" ? "#1A7F4B" : "#D7342A" }}>{f.qcState}</span>}
                          {f.corrected && <span className="adm-pill adm-pill--on-image" style={{ color: "#0B0C0F" }}>corrected</span>}
                          {f.revision && vis === "client" && <span className="adm-pill adm-pill--on-image" style={{ color: "#0066D6" }}>revised images</span>}
                        </span>
                        <div className="adm-frame__vis">
                          <VisBadge v={vis} />
                          {/* Publish only ever shows on an approved photo; a rejected or unreviewed photo has no way onto the listing from here. */}
                          {vis === "client" ? (
                            <button type="button" className="vis-toggle" data-to="internal" onClick={() => unpublish([f.id])} title="Take it off the listing and keep it internal">Unpublish</button>
                          ) : f.qcState === "approved" && canPublish ? (
                            <button type="button" className="vis-toggle" data-to="client" onClick={() => publish([f.id], { includeHeld: true })} title={`Publish this approved photo to the listing now${published && dest === "revised" && !f.section ? ", in Revised images" : ""}`}>Publish</button>
                          ) : null}
                        </div>
                        {vis !== "client" && <div className="adm-frame__why" title={VISIBILITY_HINT[vis]}>{VISIBILITY_LABEL[vis]}</div>}
                        <figcaption className="adm-frame__name" title={f.filename}>{f.filename}</figcaption>
                        {revision?.frames[f.id] && <AskNote info={revision.frames[f.id]} live={vis === "client"} />}
                        {(f.qcSummary || sev) && (
                          <div className="adm-frame__note" style={{ color: sev ? TONE[sev] : "var(--color-ink-soft)" }} title={f.qcIssues?.map((i) => `${i.severity}: ${i.note}`).join("\n") ?? ""}>
                            {sev ? `${sev}: ` : ""}{f.qcIssues?.[0]?.note ?? f.qcSummary}
                          </div>
                        )}
                        {fixTally.total > 0 && fixTally.done > 0 && (
                          <div className={`adm-frame__fixes${fixTally.done === fixTally.total ? " is-all" : ""}`}>{fixTally.done === fixTally.total ? (fixTally.total === 1 ? "Fix done" : `All ${fixTally.total} fixes done`) : `${fixTally.done} of ${fixTally.total} fixes done`}</div>
                        )}
                        <div className="adm-frame__acts">
                          <button type="button" className={f.qcState === "approved" ? "is-on-approve" : ""} onClick={() => mark([f.id], f.qcState === "approved" ? "pending" : "approved")} aria-pressed={f.qcState === "approved"}>Approve</button>
                          <button type="button" className={f.qcState === "rejected" ? "is-on-reject" : ""} onClick={() => mark([f.id], f.qcState === "rejected" ? "pending" : "rejected")} aria-pressed={f.qcState === "rejected"} title={f.qcState === "rejected" ? "Un-reject: back to unreviewed" : "Reject: never visible to the client; a live photo leaves the listing"}>{f.qcState === "rejected" ? "Rejected" : "Reject"}</button>
                          {canDownload && <a className="adm-frame__dl" href={`/api/studio/shoots/${shootId}/download?file=${f.id}`} title="Download this frame at full resolution" aria-label={`Download ${f.filename}`}><DownloadIcon /></a>}
                        </div>
                      </figure>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        );
      })}

      {selected.size > 0 && (
        <div className="sr-bar" role="toolbar" aria-label="Selected frames">
          <span className="sr-bar__n">{selected.size} selected</span>
          <button type="button" className="btn btn-primary sr-bar__btn" disabled={!canPublish || !selPlan.ids.length} onClick={() => { void publish([...selected], { includeHeld: true }); setSelected(new Set()); }} title={selPlan.ids.length ? `Publishes the ${selPlan.ids.length} approved of the selection to the listing now${selPlan.rejected + selPlan.pending ? `; ${selPlan.rejected + selPlan.pending} rejected or unreviewed stay internal` : ""}` : "Nothing approved in the selection. Approve first; rejected and unreviewed photos never go to the client."}>Publish {selPlan.ids.length} approved</button>
          <button type="button" className="btn btn-ghost sr-bar__btn" onClick={() => { void unpublish([...selected].filter((id) => { const f = frames.find((x) => x.id === id); return f && visOf(f) === "client"; })); setSelected(new Set()); }} title="Take the live ones off the listing and keep them internal">Unpublish</button>
          <button type="button" className="btn btn-ghost sr-bar__btn" onClick={() => { void mark([...selected], "approved"); }}>Approve</button>
          <button type="button" className="btn btn-ghost sr-bar__btn" onClick={() => { void mark([...selected], "rejected"); }} title="Never visible to the client; live photos leave the listing">Reject</button>
          <a className="btn btn-ghost sr-bar__btn" href={downloadHref("selected", [...selected])}><DownloadIcon />Download</a>
          {admin && <button type="button" className="btn btn-ghost sr-bar__btn sr-bar__del" onClick={() => remove([...selected])}>Delete</button>}
          <button type="button" className="btn btn-ghost sr-bar__btn" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {open != null && ordered[open] && (
        <FrameViewer
          f={ordered[open]}
          index={open}
          total={ordered.length}
          demo={demo}
          vis={visOf(ordered[open])}
          note={note}
          canPublish={canPublish}
          onClose={() => setOpen(null)}
          onGo={(d) => setOpen((i) => (i == null ? i : Math.min(ordered.length - 1, Math.max(0, i + d))))}
          onMark={(state) => mark([ordered[open].id], state)}
          onPublish={() => void publish([ordered[open].id], { includeHeld: true })}
          onUnpublish={() => void unpublish([ordered[open].id])}
          downloadHref={canDownload ? `/api/studio/shoots/${shootId}/download?file=${ordered[open].id}` : null}
          twilight={twilight && ordered[open].section !== "Twilight" ? { reason: twilight.reason, asked: twilightAsked.has(ordered[open].id), ask: () => askTwilight(ordered[open]) } : null}
          ask={revision?.frames[ordered[open].id] ?? null}
          preload={preload}
          onTick={(fixKey, done) => void tickFix(ordered[open].id, fixKey, done)}
        />
      )}
    </div>
  );
}

// On a revision photo's card: what the client asked, and whether it is fixed.
function AskNote({ info, live }: { info: RevisionFrame; live: boolean }) {
  return (
    <div className="sr-ask">
      <span className={`sr-ask__state${info.fixedAt ? (live ? " is-live" : " is-fixed") : ""}`}>{info.fixedAt ? (live ? "Fixed, live" : "Fixed, check it") : "Waiting for the fix"}</span>
      <p className="sr-ask__note" title={info.notes.join("\n")}>{info.notes[0] ?? "General request"}</p>
    </div>
  );
}

// One frame, full screen (Oct 28 2026). On a computer: arrows at the sides,
// keys A, R, arrows and Esc (ShootReview listens). On a phone: swipe for the
// next or previous frame, swipe down to close, and the three decisions in one
// row at the bottom. Built on the listing preview's frame (.amg-lb). The
// publish button follows the rule: live → Unpublish; approved → Publish;
// unreviewed or rejected → nothing goes from here.
function FrameViewer({ f, index, total, demo, vis, note, canPublish, onClose, onGo, onMark, onPublish, onUnpublish, downloadHref, twilight, ask, preload, onTick }: {
  f: AdminFrame;
  index: number;
  total: number;
  demo: boolean;
  vis: Visibility;
  note: { ok: boolean; text: string } | null;
  canPublish: boolean;
  onClose: () => void;
  onGo: (d: number) => void;
  onMark: (state: QcState) => void;
  onPublish: () => void;
  onUnpublish: () => void;
  downloadHref: string | null;
  twilight: { reason: string | null; asked: boolean; ask: () => void } | null;
  ask: RevisionFrame | null; // on the client's revision: their note, and the file the fix replaced
  preload: (string | null)[]; // the neighbours' large photos
  onTick: (fixKey: string, done: boolean) => void; // a QC flag done or not
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Before (the file the fix replaced) or After, per frame; B flips it.
  const [beforeOf, setBeforeOf] = useState<string | null>(null);
  const before = Boolean(ask?.beforeHref) && beforeOf === f.id;
  const flip = () => setBeforeOf((b) => (b === f.id ? null : f.id));
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  // Z, or a click on the photo: the original at one image pixel per screen
  // pixel, centred on the point clicked. Per frame, so the next frame opens
  // fitted again.
  const [zoomAt, setZoomAt] = useState<{ id: string; x: number; y: number } | null>(null);
  const zoom = zoomAt?.id === f.id ? zoomAt : null;
  const fullSrc = before ? null : f.fullUrl ?? (demo ? null : `/api/studio/frame/${f.id}?size=full`);
  const sev = worstSeverity(f.qcIssues);
  const fixes = qcFixProgress(f.qcIssues, f.qcFixes);
  const live = vis === "client";
  const publishable = canPublish && f.qcState === "approved";

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    document.documentElement.classList.add("amg-noscroll");
    return () => {
      document.documentElement.classList.remove("amg-noscroll");
      if (d?.open) d.close();
    };
  }, []);

  // Warm the neighbours so the arrow keys feel instant.
  useEffect(() => {
    for (const u of preload) if (u) new Image().src = u;
  }, [preload]);

  // Z toggles the zoom; Escape leaves it before it would close the viewer
  // (capture phase, ahead of the grid's own key handler on window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && zoom) {
        e.preventDefault();
        e.stopPropagation();
        setZoomAt(null);
      } else if ((e.key === "z" || e.key === "Z") && fullSrc) {
        setZoomAt(zoom ? null : { id: f.id, x: 0.5, y: 0.5 });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoom, fullSrc, f.id]);

  return (
    <dialog
      ref={ref}
      className="amg-lb srl"
      aria-label={f.filename}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => {
        if ((e.key === "b" || e.key === "B") && ask?.beforeHref && !e.metaKey && !e.ctrlKey) flip();
      }}
    >
      <div className="amg-lb__top">
        <div className="amg-lb__meta">
          <div className="amg-lb__name">{f.filename}</div>
          <div className="amg-lb__sub">
            <span className="adm-mono">{index + 1} / {total}</span> · {live ? "Client visible" : VISIBILITY_LABEL[vis]}{f.corrected ? " · corrected" : ""}{f.revision && live ? " · Revised images" : ""}
          </div>
        </div>
        <button type="button" className="amg-lb__icon amg-lb__mobile-nav" onClick={() => onGo(-1)} disabled={index === 0} aria-label="Previous frame"><ViewerIcon d="M14.5 5.5L8 12l6.5 6.5" /></button>
        <button type="button" className="amg-lb__icon amg-lb__mobile-nav" onClick={() => onGo(1)} disabled={index === total - 1} aria-label="Next frame"><ViewerIcon d="M9.5 5.5L16 12l-6.5 6.5" /></button>
        <button type="button" className="amg-lb__icon" onClick={onClose} aria-label="Close" autoFocus><ViewerIcon d="M6 6l12 12M18 6L6 18" /></button>
      </div>

      <div
        className={`amg-lb__stage${zoom ? " is-zoomed" : ""}`}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        onPointerDown={(e) => { if (!zoom && e.pointerType !== "mouse") swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || s.id !== e.pointerId || zoom) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) onGo(dx < 0 ? 1 : -1);
          else if (dy > 90 && dy > Math.abs(dx) * 1.5) onClose();
        }}
        onPointerCancel={() => { swipe.current = null; }}
      >
        <button type="button" className="amg-lb__icon amg-lb__nav amg-lb__nav--prev" onClick={() => onGo(-1)} disabled={index === 0} aria-label="Previous frame"><ViewerIcon d="M14.5 5.5L8 12l6.5 6.5" /></button>
        <div className="amg-lb__frame" key={f.id}>
          {before && ask?.beforeHref ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ask.beforeHref} alt={`${f.filename}, before the fix`} draggable={false} />
          ) : (
            <StageImage f={f} demo={demo} zoomable={Boolean(fullSrc)} onZoom={(x, y) => setZoomAt({ id: f.id, x, y })} />
          )}
          {ask?.beforeHref && <span className="srl-which">{before ? "Before" : "After"}</span>}
          {zoom && fullSrc && <ZoomView src={fullSrc} alt={f.filename} at={zoom} onClose={() => setZoomAt(null)} />}
        </div>
        <button type="button" className="amg-lb__icon amg-lb__nav amg-lb__nav--next" onClick={() => onGo(1)} disabled={index === total - 1} aria-label="Next frame"><ViewerIcon d="M9.5 5.5L16 12l-6.5 6.5" /></button>
      </div>

      <div className="srl-foot">
        {ask && (
          <div className="srl-ask">
            <div className="srl-ask__head">
              <span className="srl-ask__title">Client asked</span>
              <span className={`srl-ask__state${ask.fixedAt ? " is-fixed" : ""}`}>{ask.fixedAt ? `Fixed ${fmtWhen(ask.fixedAt)}` : "Waiting for the fix"}</span>
              {ask.beforeHref && (
                <button type="button" className="srl-ask__flip" onClick={flip} aria-pressed={before}>
                  {before ? "Show after" : "Show before"}<kbd>B</kbd>
                </button>
              )}
            </div>
            {ask.notes.length ? ask.notes.map((n) => <p key={n} className="srl-ask__note">{n}</p>) : <p className="srl-ask__note is-general">A general request: no note on this photo.</p>}
          </div>
        )}
        {(f.qcSummary || f.qcIssues?.length) && (
          <details className="srl-qc" key={f.id} open={sev === "block" || sev === "fix"}>
            <summary>
              <span className="srl-qc__title">Automatic QC{f.qcScore != null ? ` · ${f.qcScore} / 10` : ""}</span>
              {sev && <span className="srl-qc__sev" style={{ color: TONE[sev] }}>{sev}</span>}
              {fixes.total > 0 && <span className={`srl-qc__done${fixes.done === fixes.total ? " is-all" : ""}`}>{fixes.done} of {fixes.total} done</span>}
            </summary>
            <IssueList issues={f.qcIssues} suggestions={f.qcSuggestions} summary={f.qcSummary} light fixes={f.qcFixes} onTick={onTick} />
          </details>
        )}
        <div className="srl-row">
        <div className="srl-acts">
          <button type="button" className={`srl-act srl-act--reject${f.qcState === "rejected" ? " is-on" : ""}`} onClick={() => onMark(f.qcState === "rejected" ? "pending" : "rejected")} aria-pressed={f.qcState === "rejected"} title={f.qcState === "rejected" ? "Un-reject: back to unreviewed" : "Never visible to the client; a live photo leaves the listing"}>
            {f.qcState === "rejected" ? "Rejected" : "Reject"}<kbd>R</kbd>
          </button>
          <button type="button" className={`srl-act srl-act--approve${f.qcState === "approved" ? " is-on" : ""}`} onClick={() => onMark(f.qcState === "approved" ? "pending" : "approved")} aria-pressed={f.qcState === "approved"}>
            {f.qcState === "approved" ? "Approved" : "Approve"}<kbd>A</kbd>
          </button>
          {live ? (
            <button type="button" className="srl-act srl-act--publish is-live" onClick={onUnpublish} title="Take it off the listing and keep it internal">Unpublish</button>
          ) : (
            <button type="button" className="srl-act srl-act--publish" onClick={onPublish} disabled={!publishable} title={publishable ? "Publish this approved photo to the listing now" : f.qcState === "rejected" ? "Rejected photos never reach the client. Un-reject it first." : canPublish ? "Approve it first. Unreviewed photos never reach the client." : "Available once the frames are in and QC has run."}>
              {f.qcState === "rejected" ? "Never visible" : f.qcState === "pending" ? "Approve to publish" : "Publish to listing"}
            </button>
          )}
        </div>
        {(downloadHref || twilight || fullSrc) && (
          <div className="srl-more">
            {downloadHref && <a className="amg-lb__btn" href={downloadHref}><DownloadIcon />Download</a>}
            {twilight && (
              <button type="button" className="amg-lb__btn" onClick={twilight.ask} disabled={Boolean(twilight.reason) || twilight.asked} title={twilight.reason ?? "Runs the Champagne preset on this photo; the twilight joins the Twilight section."}>
                {twilight.asked ? "Twilight on its way" : "Make twilight"}
              </button>
            )}
            {fullSrc && (
              <button type="button" className={`amg-lb__btn${zoom ? " is-on" : ""}`} onClick={() => setZoomAt(zoom ? null : { id: f.id, x: 0.5, y: 0.5 })} aria-pressed={Boolean(zoom)} title="The original at one image pixel per screen pixel. Scroll or drag to look around; click the photo to fit it again.">
                {zoom ? "Fit to screen" : "Full resolution"}<kbd>Z</kbd>
              </button>
            )}
          </div>
        )}
        </div>
        {note && <p role="status" className={`srl-note${note.ok ? "" : " is-bad"}`}>{note.text}</p>}
      </div>
    </dialog>
  );
}

// The photo itself: the 2048px derivative, then the staff route that builds
// one when the pipeline did not (older uploads), then the 600px thumb as a
// last resort. Keyed by frame in the parent, so a new frame starts over.
function StageImage({ f, demo, zoomable, onZoom }: { f: AdminFrame; demo: boolean; zoomable: boolean; onZoom: (x: number, y: number) => void }) {
  const [step, setStep] = useState(0);
  const sources = [f.largeUrl, demo ? null : `/api/studio/frame/${f.id}?size=large`, f.thumbUrl ?? (demo ? null : `/api/studio/thumb/${f.id}`)].filter((s): s is string => Boolean(s));
  const src = sources[Math.min(step, sources.length - 1)];
  if (!src) return <div className="srl-demo" style={{ background: gradient(f.hue) }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={f.filename}
      draggable={false}
      className={zoomable ? "is-zoomable" : undefined}
      onError={() => setStep((s) => Math.min(s + 1, sources.length - 1))}
      onClick={(e) => {
        if (!zoomable) return;
        const p = pointOn(e.currentTarget, e.clientX, e.clientY);
        if (p) onZoom(p.x, p.y);
      }}
    />
  );
}

// Where a click landed on the picture inside a contained <img>, as fractions
// of the picture; null in the letterbox around it.
function pointOn(img: HTMLImageElement, cx: number, cy: number): { x: number; y: number } | null {
  const r = img.getBoundingClientRect();
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh || !r.width || !r.height) return null;
  const s = Math.min(r.width / nw, r.height / nh);
  const x = (cx - (r.left + (r.width - nw * s) / 2)) / (nw * s);
  const y = (cy - (r.top + (r.height - nh * s) / 2)) / (nh * s);
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

// The original at one image pixel per screen pixel (Z, or a click on the
// photo), scrolled to the point that was clicked. Scroll or drag to look
// around; a click, Z or Escape fits the photo again. The fitted photo stays
// underneath until the original has loaded.
function ZoomView({ src, alt, at, onClose }: { src: string; alt: string; at: { x: number; y: number }; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  return (
    <div
      ref={box}
      className={`srl-zoom${ready ? " is-ready" : ""}`}
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse" || e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        e.currentTarget.scrollLeft = d.left - dx;
        e.currentTarget.scrollTop = d.top - dy;
      }}
      onPointerCancel={() => { drag.current = null; }}
      onClick={() => {
        // A drag pans; only a plain click (or a tap) fits the photo again.
        const dragged = drag.current?.moved;
        drag.current = null;
        if (!dragged) onClose();
      }}
    >
      <div className="srl-zoom__in">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            const el = box.current;
            if (!el) return;
            // One image pixel per screen pixel, and never smaller than the fit.
            const one = img.naturalWidth / (window.devicePixelRatio || 1);
            const fit = Math.min(el.clientWidth, (el.clientHeight * img.naturalWidth) / img.naturalHeight);
            img.style.width = `${Math.max(one, fit)}px`;
            el.scrollLeft = at.x * img.clientWidth - el.clientWidth / 2;
            el.scrollTop = at.y * img.clientHeight - el.clientHeight / 2;
            setReady(true);
          }}
        />
      </div>
      {!ready && <span className="srl-zoom__wait">Loading the full resolution</span>}
    </div>
  );
}

function ViewerIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={d} />
    </svg>
  );
}
