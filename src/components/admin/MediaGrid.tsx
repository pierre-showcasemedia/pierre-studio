"use client";
// The admin media manager on the listing page (Oct 2026). One photo grid per
// group (main gallery first, then each named section, then revised), drag to
// reorder within a group, select for bulk actions, a menu on every tile, and a
// light preview with previous and next.
//
// Drag: mouse drags a tile after a few pixels of movement. Touch holds a tile
// for a moment (so the page still scrolls normally) or drags the grip handle
// at once. Keyboard: Space picks the focused tile up, arrows move it, Space
// drops, Escape cancels; a live region says what happened. Dropping saves the
// group's order straight away (reorderMedia).
//
// Every change is optimistic: the grid updates at once, the server action
// answers, and fresh server rows replace the local copy once nothing is in
// flight (a failure puts the server's version back). Demo mode (no database)
// runs the same interface on public frames and saves nothing.
//
// Oct 2026: every file reads "Client visible" or "Internal only" (with the
// reason, src/lib/visibility.ts), a filter shows all, client visible or
// internal only, and the tile menu, the preview and the selection bar move
// files between the two (setMediaVisibility). "Download internal" and
// "Download selected" zip the photos for editing. The QA team uses the same
// grid without Delete (role).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AdminMediaRow } from "@/lib/admin-types";
import { groupAnchor, groupMedia, type MediaGroup } from "@/lib/media-groups";
import type { MediaActionResult } from "@/app/admin/crud-actions";
import { bulkMediaInline, reorderMedia, updateMediaInline } from "@/app/admin/crud-actions";
import { setCover as setCoverAction } from "@/app/admin/actions";
import { setMediaVisibility } from "@/app/admin/visibility-actions";
import { fmtBytes } from "@/lib/shoot-status";
import { VISIBILITY_HINT, VISIBILITY_LABEL, visibilityOf, type Visibility } from "@/lib/visibility";

// ---- Groups -----------------------------------------------------------------
// Photos first, then each named section, then the revised files
// (src/lib/media-groups.ts, shared with the page's sticky nav). Each group is
// a section with an anchor the nav jumps to.

type Group = MediaGroup<AdminMediaRow>;

const visOf = (m: AdminMediaRow): Visibility => visibilityOf(m, m.shootPublished);
const isLive = (m: AdminMediaRow) => visOf(m) === "client";

type Badge = { label: string; tone: "cover" | "hidden" | "qc" | "bad" | "plain" | "client" | "internal"; title?: string };
function badgesFor(m: AdminMediaRow, cover: boolean): Badge[] {
  const out: Badge[] = [];
  const v = visOf(m);
  out.push(v === "client" ? { label: "Client visible", tone: "client", title: VISIBILITY_HINT.client } : { label: "Internal only", tone: "internal", title: `${VISIBILITY_LABEL[v]}. ${VISIBILITY_HINT[v]}` });
  if (cover) out.push({ label: "Cover", tone: "cover" });
  if (v === "pending") out.push({ label: "Not reviewed", tone: "qc", title: VISIBILITY_HINT.pending });
  else if (v === "rejected") out.push({ label: "Rejected", tone: "bad", title: VISIBILITY_HINT.rejected });
  else if (v === "waiting") out.push({ label: "Not published yet", tone: "qc", title: VISIBILITY_HINT.waiting });
  else if (v === "held") out.push({ label: "Held back", tone: "hidden", title: VISIBILITY_HINT.held });
  if (m.corrected) out.push({ label: "Corrected", tone: "plain" });
  return out;
}

type ViewFilter = "all" | "client" | "internal";
const passes = (m: AdminMediaRow, f: ViewFilter) => (f === "all" ? true : f === "client" ? isLive(m) : !isLive(m));

const moveItem = (ids: string[], from: number, to: number) => {
  const next = ids.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
};
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2,.8,.2,1)";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---- Icons (inline, currentColor) --------------------------------------------

const Svg = ({ children, vb = "0 0 24 24" }: { children: React.ReactNode; vb?: string }) => (
  <svg viewBox={vb} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">{children}</svg>
);
const IconDots = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>;
const IconCheck = () => <Svg><path d="M5 12.5l4.2 4.2L19 7" strokeWidth={2.6} /></Svg>;
const IconPlay = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z" /></svg>;
const IconGrip = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>;
const IconStar = () => <Svg><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9 1 5.6L12 16.6l-5.1 2.6 1-5.6-4-3.9 5.6-.8z" /></Svg>;
const IconEye = () => <Svg><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></Svg>;
const IconEyeOff = () => <Svg><path d="M4 4l16 16" /><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1" /><path d="M9.9 9.9a2.8 2.8 0 0 0 4.2 4.2" /></Svg>;
const IconDownload = () => <Svg><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" /></Svg>;
const IconEdit = () => <Svg><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="M14 8l2.5 2.5" /></Svg>;
const IconTrash = () => <Svg><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 12.2h9L17.5 7" /></Svg>;
const IconExpand = () => <Svg><path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6" /></Svg>;
const IconClose = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
const IconLeft = () => <Svg><path d="M14.5 5.5L8 12l6.5 6.5" /></Svg>;
const IconRight = () => <Svg><path d="M9.5 5.5L16 12l-6.5 6.5" /></Svg>;

function FilmFace() {
  return (
    <span className="amg-film">
      <span className="amg-film__play"><IconPlay /></span>
      <span className="amg-film__label">Film</span>
    </span>
  );
}

// ---- Types ------------------------------------------------------------------

type Props = { listingId: string; rows: AdminMediaRow[]; coverKey: string | null; demo: boolean; storage: boolean; role?: "admin" | "qa" };
type Status = { kind: "saving" | "saved" | "error" | "demo"; text: string };
type BulkDo = "hide" | "show" | "revision" | "unrevision" | "section" | "delete";
type DragView = { id: string; x: number; y: number; w: number; h: number };
type Lifted = { id: string; key: string; title: string; start: string[] };
type Session = {
  id: string;
  key: string;
  name: string;
  pointerId: number;
  touch: boolean;
  handle: boolean;
  x0: number;
  y0: number;
  x: number;
  y: number;
  gx: number; // grab offset inside the tile
  gy: number;
  w: number;
  h: number;
  active: boolean;
  timer: number | null;
  raf: number | null;
  slots: { x: number; y: number }[]; // slot centres, page coordinates, fixed for the drag
  bounds: { l: number; t: number; r: number; b: number };
  start: string[];
  order: string[];
  off: () => void;
};

export default function MediaGrid({ listingId, rows, coverKey, demo, storage, role = "admin" }: Props) {
  const helpId = useId();
  const canDelete = role === "admin";
  const [filter, setFilter] = useState<ViewFilter>("all");
  const [items, setItems] = useState(rows);
  const [cover, setCoverKey] = useState(coverKey);
  const [seen, setSeen] = useState<AdminMediaRow[] | null>(rows);
  const [busy, setBusy] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  const [lifted, setLifted] = useState<Lifted | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [sectionDraft, setSectionDraft] = useState("");
  const [thumbStage, setThumbStage] = useState<Readonly<Record<string, 1 | 2>>>({});

  // Fresh rows from the server (every server render sends a new array)
  // replace the local copy, but only once nothing is in flight or held.
  if (seen !== rows && busy === 0 && !drag && !lifted) {
    setSeen(rows);
    setItems(rows);
    setCoverKey(coverKey);
    const ids = new Set(rows.map((r) => r.id));
    setSelected((s) => ([...s].every((id) => ids.has(id)) ? s : new Set([...s].filter((id) => ids.has(id)))));
  }

  // A filter shows part of each group; drag to reorder needs the whole group,
  // so it only runs on "All".
  const groups = useMemo(() => groupMedia(items.filter((m) => passes(m, filter))), [items, filter]);
  const canDrag = filter === "all";
  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  // While a tile is held, its group renders in the held order.
  const view = useMemo(
    () =>
      groups.map((g) => {
        if (!override || override.key !== g.key) return g;
        const list = override.ids.map((id) => byId.get(id)).filter((m): m is AdminMediaRow => Boolean(m));
        return list.length === g.rows.length ? { ...g, rows: list } : g;
      }),
    [groups, override, byId]
  );
  const sectionNames = useMemo(() => [...new Set(items.map((m) => m.section).filter((s): s is string => Boolean(s)))].sort(), [items]);
  const selectedIds = useMemo(() => view.flatMap((g) => g.rows.filter((m) => selected.has(m.id)).map((m) => m.id)), [view, selected]);
  const counts = useMemo(
    () => ({
      live: items.filter(isLive).length,
      internal: items.filter((m) => !isLive(m)).length,
      internalPhotos: items.filter((m) => !isLive(m) && m.kind === "photo").length,
      held: items.filter((m) => visOf(m) === "held").length,
      waiting: items.filter((m) => visOf(m) === "waiting").length,
      qc: items.filter((m) => visOf(m) === "pending" || visOf(m) === "rejected").length,
    }),
    [items]
  );

  const tileEls = useRef(new Map<string, HTMLDivElement>());
  const gridEls = useRef(new Map<string, HTMLDivElement>());
  const flipFrom = useRef<Map<string, { x: number; y: number }> | null>(null);
  const session = useRef<Session | null>(null);
  const liftEl = useRef<HTMLDivElement | null>(null);
  const suppressUntil = useRef(0);
  const refocus = useRef<string | null>(null);

  const say = useCallback((t: string) => setAnnouncement(t), []);

  // ---- FLIP: tiles glide to their new places --------------------------------

  // Remember where tiles are now (page coordinates); the layout effect below
  // animates them from there to wherever the next render puts them.
  const snapshot = useCallback((ids: Iterable<string>) => {
    const m = flipFrom.current ?? new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const el = tileEls.current.get(id);
      if (!el || m.has(id)) continue;
      const r = el.getBoundingClientRect();
      m.set(id, { x: r.left + window.scrollX, y: r.top + window.scrollY });
    }
    flipFrom.current = m;
  }, []);

  useLayoutEffect(() => {
    const first = flipFrom.current;
    if (first) {
      flipFrom.current = null;
      if (!reducedMotion()) {
        for (const [id, p] of first) {
          const el = tileEls.current.get(id);
          if (!el) continue;
          for (const a of el.getAnimations()) a.cancel();
          const r = el.getBoundingClientRect();
          const dx = p.x - (r.left + window.scrollX);
          const dy = p.y - (r.top + window.scrollY);
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 220, easing: EASE });
        }
      }
    }
    const f = refocus.current;
    if (f) {
      refocus.current = null;
      const el = tileEls.current.get(f);
      if (el) {
        if (document.activeElement !== el) el.focus({ preventScroll: true });
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
  });

  // Saved and demo notes fade on their own; errors stay a little longer.
  useEffect(() => {
    if (!status || status.kind === "saving") return;
    const t = window.setTimeout(() => setStatus((s) => (s === status ? null : s)), status.kind === "error" ? 7000 : 2600);
    return () => window.clearTimeout(t);
  }, [status]);

  // A drag in progress when the grid unmounts (navigation) lets go cleanly.
  useEffect(() => {
    const s = session;
    return () => {
      s.current?.off();
      document.documentElement.classList.remove("amg-dragging");
    };
  }, []);

  // ---- Saving ----------------------------------------------------------------

  const runOp = useCallback(async (op: () => Promise<MediaActionResult>, saving: string, saved: string) => {
    setBusy((b) => b + 1);
    setStatus({ kind: "saving", text: saving });
    let r: MediaActionResult;
    try {
      r = await op();
    } catch {
      r = { ok: false, error: "Could not reach the server. Check the connection and try again." };
    }
    setStatus(r.ok ? { kind: "saved", text: saved } : { kind: "error", text: r.error });
    if (!r.ok) setSeen(null); // put the server's version back
    setBusy((b) => b - 1);
  }, []);

  const commitOrder = useCallback(
    (ids: string[]) => {
      const pos = new Map(ids.map((id, i) => [id, (i + 1) * 10]));
      setItems((prev) => prev.map((m) => (pos.has(m.id) ? { ...m, sort: pos.get(m.id)! } : m)));
      setOverride(null);
      if (demo) {
        setStatus({ kind: "demo", text: "Demo mode: order not saved" });
        return;
      }
      void runOp(() => reorderMedia(listingId, ids), "Saving order", "Order saved");
    },
    [demo, listingId, runOp]
  );

  // ---- Pointer drag (mouse, pen, touch) --------------------------------------

  const placeLift = useCallback(() => {
    const s = session.current;
    const el = liftEl.current;
    if (s && el) el.style.transform = `translate3d(${s.x - s.gx}px, ${s.y - s.gy}px, 0)`;
  }, []);

  // The slot under the pointer takes the held tile. Slots are the grid's
  // places measured once at pick-up, so tiles gliding around never confuse it.
  const hitTest = useCallback(() => {
    const s = session.current;
    if (!s || !s.active) return;
    const px = s.x + window.scrollX;
    const py = s.y + window.scrollY;
    const b = s.bounds;
    const pad = 56;
    if (px < b.l - pad || px > b.r + pad || py < b.t - pad || py > b.b + pad) return;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < s.slots.length; i++) {
      const d = (s.slots[i].x - px) ** 2 + (s.slots[i].y - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const cur = s.order.indexOf(s.id);
    if (best < 0 || best === cur) return;
    snapshot(s.order);
    s.order = moveItem(s.order, cur, best);
    setOverride({ key: s.key, ids: s.order });
  }, [snapshot]);

  const activate = useCallback(() => {
    const s = session.current;
    if (!s || s.active) return;
    const grid = gridEls.current.get(s.key);
    if (!grid) return;
    s.active = true;
    if (s.timer) { window.clearTimeout(s.timer); s.timer = null; }
    const g = grid.getBoundingClientRect();
    const ox = g.left + window.scrollX;
    const oy = g.top + window.scrollY;
    s.bounds = { l: ox, t: oy, r: ox + g.width, b: oy + g.height };
    s.slots = s.order.map((id) => {
      const el = tileEls.current.get(id);
      const media = el?.firstElementChild as HTMLElement | null;
      return el ? { x: ox + el.offsetLeft + el.offsetWidth / 2, y: oy + el.offsetTop + (media?.offsetHeight ?? el.offsetHeight) / 2 } : { x: -1e9, y: -1e9 };
    });
    suppressUntil.current = Number.POSITIVE_INFINITY;
    document.documentElement.classList.add("amg-dragging");
    if (s.touch && typeof navigator.vibrate === "function") navigator.vibrate(8);
    setMenuId(null);
    setDrag({ id: s.id, x: s.x - s.gx, y: s.y - s.gy, w: s.w, h: s.h });
    setOverride({ key: s.key, ids: s.order });
    // Auto-scroll near the top (under the sticky header and section nav) and
    // the bottom (above the phone tab bar).
    const tick = () => {
      const t = session.current;
      if (!t || !t.active) return;
      const vh = window.innerHeight;
      const zone = 72;
      const topEdge = 120 + zone;
      const bottomEdge = vh - (window.innerWidth < 760 ? 80 : 0) - zone;
      let dy = 0;
      if (t.y < topEdge) dy = -Math.ceil(Math.min(1, (topEdge - t.y) / zone) ** 2 * 20);
      else if (t.y > bottomEdge) dy = Math.ceil(Math.min(1, (t.y - bottomEdge) / zone) ** 2 * 20);
      if (dy) {
        window.scrollBy({ top: dy, behavior: "instant" });
        hitTest();
      }
      t.raf = window.requestAnimationFrame(tick);
    };
    s.raf = window.requestAnimationFrame(tick);
  }, [hitTest]);

  const end = useCallback(
    (commit: boolean) => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      if (s.timer) window.clearTimeout(s.timer);
      if (s.raf) window.cancelAnimationFrame(s.raf);
      s.off();
      document.documentElement.classList.remove("amg-dragging");
      if (!s.active) return;
      // The click that follows a drop must not open the preview.
      suppressUntil.current = performance.now() + 400;
      const final = commit ? s.order : s.start;
      snapshot(s.order);
      const lift = liftEl.current?.firstElementChild?.getBoundingClientRect();
      if (lift && flipFrom.current) flipFrom.current.set(s.id, { x: lift.left + window.scrollX, y: lift.top + window.scrollY });
      setDrag(null);
      if (commit && !sameOrder(final, s.start)) {
        commitOrder(final);
        say(`Dropped ${s.name} at position ${final.indexOf(s.id) + 1} of ${final.length}.`);
      } else {
        setOverride(null);
        if (!commit) say(`Move canceled. ${s.name} is back where it was.`);
      }
    },
    [commitOrder, say, snapshot]
  );

  const onPointerDown = (e: React.PointerEvent<HTMLElement>, m: AdminMediaRow, key: string, ids: string[], handle: boolean) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!canDrag || session.current || lifted || ids.length < 2) return;
    if (!handle && (e.target as HTMLElement).closest("[data-nodrag]")) return;
    const tile = tileEls.current.get(m.id);
    const media = tile?.firstElementChild as HTMLElement | null;
    if (!tile || !media) return;
    if (handle) e.stopPropagation();
    const r = media.getBoundingClientRect();
    const touch = e.pointerType === "touch";
    const s: Session = {
      id: m.id, key, name: m.filename, pointerId: e.pointerId, touch, handle,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      gx: e.clientX - r.left, gy: e.clientY - r.top, w: r.width, h: r.height,
      active: false, timer: null, raf: null, slots: [], bounds: { l: 0, t: 0, r: 0, b: 0 },
      start: ids, order: ids, off: () => {},
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== s.pointerId) return;
      s.x = ev.clientX;
      s.y = ev.clientY;
      if (!s.active) {
        const d = Math.hypot(s.x - s.x0, s.y - s.y0);
        // A finger that moves before the hold completes is scrolling the page.
        if (touch && !handle) { if (d > 10) end(false); return; }
        if (d < (handle ? 2 : 6)) return;
        activate();
        if (!s.active) return;
      }
      if (ev.cancelable) ev.preventDefault();
      placeLift();
      hitTest();
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === s.pointerId) end(true); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === s.pointerId) end(false); };
    // Once a touch drag is live, the page must not scroll under the finger.
    const touchmove = (ev: TouchEvent) => { if (s.active && ev.cancelable) ev.preventDefault(); };
    const scroll = () => hitTest();
    const key2 = (ev: KeyboardEvent) => { if (ev.key === "Escape" && s.active) { ev.preventDefault(); end(false); } };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", touchmove, { passive: false });
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("keydown", key2);
    s.off = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", touchmove);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("keydown", key2);
    };
    if (touch && !handle) s.timer = window.setTimeout(activate, 360);
    session.current = s;
  };

  // ---- Keyboard drag ---------------------------------------------------------

  const heldOrder = (l: Lifted) => (override?.key === l.key ? override.ids : l.start);

  const pickUp = (m: AdminMediaRow, g: Group) => {
    if (!canDrag) { say("Show all files to change the order."); return; }
    const ids = g.rows.map((r) => r.id);
    if (ids.length < 2) { say(`${m.filename} is the only file in ${g.title}.`); return; }
    setLifted({ id: m.id, key: g.key, title: g.title, start: ids });
    setOverride({ key: g.key, ids });
    setMenuId(null);
    say(`Picked up ${m.filename}, position ${ids.indexOf(m.id) + 1} of ${ids.length} in ${g.title}. Arrow keys move it, Space drops it, Escape cancels.`);
  };

  const moveLifted = (delta: number) => {
    if (!lifted) return;
    const ids = heldOrder(lifted);
    const i = ids.indexOf(lifted.id);
    const j = Math.max(0, Math.min(ids.length - 1, i + delta));
    if (i < 0 || i === j) return;
    snapshot(ids);
    refocus.current = lifted.id;
    setOverride({ key: lifted.key, ids: moveItem(ids, i, j) });
    say(`Position ${j + 1} of ${ids.length}.`);
  };

  const dropLifted = () => {
    if (!lifted) return;
    const ids = heldOrder(lifted);
    const name = byId.get(lifted.id)?.filename ?? "File";
    setLifted(null);
    if (!sameOrder(ids, lifted.start)) {
      commitOrder(ids);
      say(`Dropped ${name} at position ${ids.indexOf(lifted.id) + 1} of ${ids.length}.`);
    } else {
      setOverride(null);
      say(`Dropped ${name}. The order did not change.`);
    }
  };

  const cancelLifted = () => {
    if (!lifted) return;
    snapshot(heldOrder(lifted));
    refocus.current = lifted.id;
    setLifted(null);
    setOverride(null);
    say(`Move canceled. ${byId.get(lifted.id)?.filename ?? "The file"} is back at position ${lifted.start.indexOf(lifted.id) + 1}.`);
  };

  // A held tile drops where it is when focus or a press goes elsewhere. The
  // tile's own moves can blur it for a moment (React moves the node); the
  // layout effect hands focus straight back, so only real moves away count.
  const dropRef = useRef(dropLifted);
  useLayoutEffect(() => {
    dropRef.current = dropLifted;
  });
  useEffect(() => {
    if (!lifted) return;
    const tile = () => tileEls.current.get(lifted.id);
    const onFocusIn = (e: FocusEvent) => {
      const el = tile();
      if (el && e.target !== el) dropRef.current();
    };
    const onDown = (e: PointerEvent) => {
      const el = tile();
      if (el && !el.contains(e.target as Node)) dropRef.current();
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [lifted]);

  const colsOf = (key: string) => {
    const g = gridEls.current.get(key);
    if (!g) return 1;
    return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length);
  };

  // ---- Selection, menus, actions ---------------------------------------------

  const toggleSelect = (id: string, range: boolean, ids: string[]) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (range && anchor && anchor !== id && ids.includes(anchor)) {
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(id);
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) n.add(x);
      } else if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    setAnchor(id);
  };

  const selectGroup = (g: Group, all: boolean) => {
    setSelected((prev) => {
      const n = new Set(prev);
      for (const r of g.rows) {
        if (all) n.delete(r.id);
        else n.add(r.id);
      }
      return n;
    });
  };

  // Client visible / Internal only: its own action, which answers with how
  // many went live and how many wait for their shoot's Publish.
  const moveTo = (to: "client" | "internal", ids: string[]) => {
    if (!ids.length) return;
    const set = new Set(ids);
    const n = ids.length;
    setItems((prev) => prev.map((m) => (set.has(m.id) ? (to === "client" ? { ...m, qcState: "approved", published: true, held: false } : { ...m, published: false, held: true }) : m)));
    setSelected(new Set());
    setMenuId(null);
    const done = to === "client" ? (n === 1 ? "Client visible" : `${n} files client visible`) : n === 1 ? "Moved to internal only" : `${n} files moved to internal only`;
    say(`${done}.`);
    if (demo) {
      setStatus({ kind: "demo", text: "Demo mode: not saved" });
      return;
    }
    void runOp(async () => {
      const r = await setMediaVisibility({ listingId, ids, to, via: "listing" });
      if (!r.ok) return { ok: false, error: r.error };
      if (to === "client" && r.waiting) setTimeout(() => setStatus({ kind: "saved", text: `${r.waiting} go live when the shoot is published` }), 0);
      return { ok: true };
    }, "Saving", done);
  };

  const bulk = (action: BulkDo, ids: string[], section?: string): boolean => {
    if (!ids.length) return false;
    if (action === "hide" || action === "show") { moveTo(action === "show" ? "client" : "internal", ids); return true; }
    if (action === "delete" && !canDelete) return false;
    const set = new Set(ids);
    const n = ids.length;
    if (action === "delete") {
      const one = n === 1 ? byId.get(ids[0])?.filename : null;
      const msg = `Delete ${one ?? plural(n, "file")} from this listing? The client stops seeing ${n === 1 ? "it" : "them"} and the download zips rebuild. The original stays in storage.`;
      if (!window.confirm(msg)) return false;
    }
    const sec = (section ?? "").trim() || null;
    const patch = (m: AdminMediaRow): AdminMediaRow =>
      action === "revision" ? { ...m, revision: true }
      : action === "unrevision" ? { ...m, revision: false }
      : action === "section" ? { ...m, section: sec }
      : m;
    setItems((prev) => (action === "delete" ? prev.filter((m) => !set.has(m.id)) : prev.map((m) => (set.has(m.id) ? patch(m) : m))));
    setSelected(new Set());
    setMenuId(null);
    const done = {
      revision: "Marked as revised",
      unrevision: "Back in the gallery",
      section: sec ? `Moved to ${sec}` : "Moved to the main gallery",
      delete: n === 1 ? "File deleted" : `${n} files deleted`,
    }[action];
    say(`${done}.`);
    if (demo) {
      setStatus({ kind: "demo", text: "Demo mode: not saved" });
      return true;
    }
    const fd = new FormData();
    for (const id of ids) fd.append("ids", id);
    fd.set("do", action);
    if (action === "section") fd.set("section", sec ?? "");
    void runOp(() => bulkMediaInline(listingId, fd), "Saving", done);
    return true;
  };

  const makeCover = (m: AdminMediaRow) => {
    setCoverKey(m.r2Key);
    setMenuId(null);
    say(`${m.filename} is the cover photo.`);
    if (demo) {
      setStatus({ kind: "demo", text: "Demo mode: cover not saved" });
      return;
    }
    void runOp(async () => {
      await setCoverAction(listingId, m.r2Key);
      return { ok: true };
    }, "Saving cover", "Cover photo set");
  };

  const saveEdit = (m: AdminMediaRow, v: { filename: string; section: string; revision: boolean }) => {
    const filename = v.filename.trim() || m.filename;
    const section = v.section.trim() || null;
    setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, filename, section, revision: v.revision } : x)));
    setEditId(null);
    if (demo) {
      setStatus({ kind: "demo", text: "Demo mode: not saved" });
      return;
    }
    const fd = new FormData();
    fd.set("listingId", listingId);
    fd.set("filename", filename);
    fd.set("section", section ?? "");
    if (v.revision) fd.set("revision", "on");
    void runOp(() => updateMediaInline(m.id, fd), "Saving", "Details saved");
  };

  const deleteOne = (m: AdminMediaRow) => bulk("delete", [m.id]);

  // Close the tile menu on an outside press or Escape.
  useEffect(() => {
    if (!menuId) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(`[data-menu-root="${menuId}"]`)) setMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuId(null);
      tileEls.current.get(menuId)?.querySelector<HTMLButtonElement>(".amg-menu-btn")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    const first = tileEls.current.get(menuId)?.querySelector<HTMLElement>(".amg-menu button:not([disabled]), .amg-menu a");
    first?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  const thumbOf = (m: AdminMediaRow): string | null => {
    if (m.kind !== "photo") return null;
    const stage = thumbStage[m.id];
    const route = storage && !demo ? `/api/studio/thumb/${m.id}` : null;
    if (stage === 2) return null;
    if (stage === 1) return route;
    return m.thumbUrl ?? route;
  };
  const thumbFailed = (m: AdminMediaRow) => {
    setThumbStage((s) => {
      const cur = s[m.id];
      const route = storage && !demo;
      const next: 1 | 2 = !cur && route && m.thumbUrl ? 1 : 2;
      return cur === next ? s : { ...s, [m.id]: next };
    });
  };

  const onTileClick = (e: React.MouseEvent<HTMLDivElement>, m: AdminMediaRow, ids: string[]) => {
    // Event time stamps share performance.now()'s clock.
    if (e.timeStamp < suppressUntil.current) return;
    if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
    setMenuId(null);
    if (selected.size > 0 || e.shiftKey || e.metaKey || e.ctrlKey) {
      toggleSelect(m.id, e.shiftKey, ids);
      return;
    }
    setPreviewId(m.id);
  };

  const onTileKey = (e: React.KeyboardEvent<HTMLDivElement>, m: AdminMediaRow, g: Group, i: number) => {
    if (e.target !== e.currentTarget) return;
    const cols = colsOf(g.key);
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, Home: -1e6, End: 1e6 };
    if (lifted) {
      if (lifted.id !== m.id) return;
      if (e.key in deltas) { e.preventDefault(); moveLifted(deltas[e.key]); }
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); dropLifted(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelLifted(); }
      return;
    }
    if (e.key === " ") { e.preventDefault(); pickUp(m, g); }
    else if (e.key === "Enter") { e.preventDefault(); setPreviewId(m.id); }
    else if (e.key in deltas) {
      e.preventDefault();
      const j = Math.max(0, Math.min(g.rows.length - 1, i + deltas[e.key]));
      tileEls.current.get(g.rows[j].id)?.focus();
    } else if (e.key === "x" || e.key === "X") {
      e.preventDefault();
      toggleSelect(m.id, e.shiftKey, g.rows.map((r) => r.id));
    }
  };

  // ---- Render ----------------------------------------------------------------

  let previewCtx: { g: Group; i: number } | null = null;
  if (previewId) {
    for (const g of view) {
      const i = g.rows.findIndex((r) => r.id === previewId);
      if (i >= 0) { previewCtx = { g, i }; break; }
    }
  }
  const editing = editId ? byId.get(editId) ?? null : null;
  const dragged = drag ? byId.get(drag.id) ?? null : null;

  if (!items.length) {
    return <p className="muted" style={{ fontSize: 14, padding: "18px 0" }}>Nothing yet. Add files below, or upload a shoot.</p>;
  }

  return (
    <div className={`amg${selected.size ? " is-selecting" : ""}`}>
      <p id={helpId} className="amg-sr">Press Space to pick up a file, the arrow keys to move it, and Space again to drop it. Escape cancels. Enter opens the preview. X selects.</p>
      <div className="amg-sr" aria-live="assertive" aria-atomic="true">{announcement}</div>

      <div className="amg-top">
        <div className="amg-summary">
          Client sees <strong className="adm-mono">{counts.live}</strong> of {plural(items.length, "file")}
          {counts.internal ? ` · ${counts.internal} internal only` : ""}
          {counts.waiting ? ` (${counts.waiting} waiting to publish` : ""}
          {counts.waiting && counts.held ? `, ${counts.held} held back` : counts.held ? ` (${counts.held} held back` : ""}
          {counts.waiting || counts.held ? ")" : ""}
          {counts.qc ? ` · ${counts.qc} in QC or rejected` : ""}
          {demo ? " · demo, nothing saves" : ""}
        </div>
        <div aria-live="polite" style={{ minHeight: 28 }}>
          {status && (
            <span className="amg-status" data-kind={status.kind} key={`${status.kind}:${status.text}`}>
              <span className="amg-status__dot" />
              {status.text}
            </span>
          )}
        </div>
      </div>

      <div className="amg-filter">
        <div className="adm-seg" role="tablist" aria-label="Show files">
          {([
            ["all", `All ${items.length}`],
            ["client", `Client visible ${counts.live}`],
            ["internal", `Internal only ${counts.internal}`],
          ] as [ViewFilter, string][]).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? "is-active" : ""} onClick={() => { setFilter(k); setSelected(new Set()); }}>{l}</button>
          ))}
        </div>
        {storage && !demo && counts.internalPhotos > 0 && (
          <a className="adm-chip adm-chip--quiet" href={`/api/studio/listings/${listingId}/download?scope=internal`} title="Zip of every photo the client cannot see, at full resolution">
            <IconDownload />Download internal ({counts.internalPhotos})
          </a>
        )}
      </div>
      {filter === "internal" && (
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
          Everything the client cannot see: fresh from editing and not reviewed, rejected in QC, waiting to publish, and held back by hand. Replaced originals are listed under the shoot.
        </p>
      )}
      {!view.length && <p className="muted" style={{ fontSize: 14, padding: "8px 0 18px" }}>{filter === "internal" ? "Nothing internal. The client sees every file." : "No client visible files yet."}</p>}

      {view.map((g) => {
        const ids = g.rows.map((r) => r.id);
        const allSel = g.rows.every((r) => selected.has(r.id));
        const roving = focusId && ids.includes(focusId) ? focusId : ids[0];
        return (
          <section key={g.key} id={groupAnchor(g.key)} className="amg-group" aria-label={`${g.title}, ${plural(g.rows.length, "file")}`}>
            <div className="amg-group__head">
              <div className="amg-group__title">
                <span className="kicker">{g.title} · <span className="adm-mono" style={{ fontSize: 10.5 }}>{g.rows.length}</span></span>
                {g.rows.length > 1 && canDrag && (
                  <span className="amg-group__hint">
                    <span className="amg-hint-mouse">Drag to reorder</span>
                    <span className="amg-hint-touch">Hold to move</span>
                  </span>
                )}
              </div>
              <button type="button" className="adm-chip adm-chip--quiet" onClick={() => selectGroup(g, allSel)}>{allSel ? "Clear" : "Select all"}</button>
            </div>
            <div
              className="amg-grid"
              ref={(el) => {
                if (el) gridEls.current.set(g.key, el);
                else gridEls.current.delete(g.key);
              }}
            >
              {g.rows.map((m, i) => {
                const isSel = selected.has(m.id);
                const isCover = m.kind === "photo" && cover === m.r2Key;
                const badges = badgesFor(m, isCover);
                const thumb = thumbOf(m);
                const tabbable = roving === m.id;
                const menuOpen = menuId === m.id;
                const state = badges.map((b) => b.label).join(", ");
                const cls = [
                  "amg-tile",
                  isSel ? "is-selected" : "",
                  drag?.id === m.id ? "is-placeholder" : "",
                  lifted?.id === m.id ? "is-lifted" : "",
                  m.qcState === "rejected" ? "is-rejected" : !isLive(m) ? "is-dim" : "",
                  menuOpen ? "has-menu" : "",
                  g.rows.length > 1 && canDrag ? "has-handle" : "",
                ].filter(Boolean).join(" ");
                return (
                  <div
                    key={m.id}
                    ref={(el) => {
                      if (el) tileEls.current.set(m.id, el);
                      else tileEls.current.delete(m.id);
                    }}
                    className={cls}
                    role="group"
                    aria-roledescription="sortable file"
                    aria-label={`${i + 1} of ${g.rows.length}, ${m.filename}${m.kind === "video" ? ", film" : ""}${state ? `, ${state}` : ""}${isSel ? ", selected" : ""}`}
                    aria-describedby={helpId}
                    tabIndex={tabbable ? 0 : -1}
                    data-menu-root={m.id}
                    onPointerDown={(e) => onPointerDown(e, m, g.key, ids, false)}
                    onClick={(e) => onTileClick(e, m, ids)}
                    onKeyDown={(e) => onTileKey(e, m, g, i)}
                    onFocus={() => setFocusId(m.id)}
                    onContextMenu={(e) => { if (session.current?.touch) e.preventDefault(); }}
                    onDragStart={(e) => e.preventDefault()}
                  >
                    <div className="amg-tile__media">
                      {m.kind === "video" ? (
                        <FilmFace />
                      ) : thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} onError={() => thumbFailed(m)} />
                      ) : (
                        <span className="amg-empty-thumb">{storage || demo ? "No preview yet" : "Storage not connected"}</span>
                      )}
                      {badges.length > 0 && (
                        <span className="amg-badges">
                          {badges.map((b) => <span key={b.label} className="amg-badge" data-tone={b.tone} title={b.title}>{b.label}</span>)}
                        </span>
                      )}
                      <label className="amg-check" data-nodrag title={isSel ? "Deselect" : "Select"}>
                        <input type="checkbox" checked={isSel} readOnly tabIndex={tabbable ? 0 : -1} aria-label={`Select ${m.filename}`} onClick={(e) => toggleSelect(m.id, e.shiftKey, ids)} />
                        <span className="amg-check__ring"><IconCheck /></span>
                      </label>
                      <button
                        type="button"
                        className="amg-menu-btn"
                        data-nodrag
                        tabIndex={tabbable ? 0 : -1}
                        aria-label={`Actions for ${m.filename}`}
                        aria-haspopup="true"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuId(menuOpen ? null : m.id)}
                      >
                        <IconDots />
                      </button>
                      {g.rows.length > 1 && canDrag && (
                        <span className="amg-handle" data-nodrag aria-hidden onPointerDown={(e) => onPointerDown(e, m, g.key, ids, true)}>
                          <IconGrip />
                        </span>
                      )}
                    </div>
                    <div className="amg-tile__cap">
                      <span className="amg-pos">{i + 1}</span>
                      <span className="amg-name" title={m.filename}>{m.filename}</span>
                      <span className="amg-size">{fmtBytes(m.bytes)}</span>
                    </div>
                    {menuOpen && (
                      <TileMenu
                        m={m}
                        isCover={isCover}
                        onPreview={() => { setMenuId(null); setPreviewId(m.id); }}
                        onCover={() => makeCover(m)}
                        onToggle={() => moveTo(isLive(m) ? "internal" : "client", [m.id])}
                        onEdit={() => { setMenuId(null); setEditId(m.id); }}
                        onDelete={canDelete ? () => deleteOne(m) : undefined}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {drag && dragged && (
        <div
          ref={(el) => {
            liftEl.current = el;
            if (el) placeLift(); // the pointer may have moved before this mounted
          }}
          className="amg-lift"
          style={{ width: drag.w, height: drag.h, transform: `translate3d(${drag.x}px, ${drag.y}px, 0)` }}
          aria-hidden
        >
          <div className="amg-lift__inner">
            {dragged.kind === "video" ? (
              <FilmFace />
            ) : thumbOf(dragged) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbOf(dragged)!} alt="" draggable={false} />
            ) : null}
          </div>
        </div>
      )}

      <datalist id="amg-sections">
        {sectionNames.map((s) => <option key={s} value={s} />)}
      </datalist>

      <div className={`amg-bar${selected.size ? " is-open" : ""}`} role="region" aria-label="Selected files" inert={!selected.size}>
        <div className="amg-bar__inner">
          <span className="amg-bar__count"><span className="adm-mono">{selectedIds.length}</span> selected</span>
          <span className="amg-bar__sep" />
          <button type="button" className="adm-chip adm-chip--quiet" onClick={() => moveTo("client", selectedIds)} title="Approve and show in the client gallery">Client visible</button>
          <button type="button" className="adm-chip adm-chip--quiet" onClick={() => moveTo("internal", selectedIds)} title="Keep off the client gallery">Internal only</button>
          {storage && !demo && <a className="adm-chip adm-chip--quiet" href={`/api/studio/listings/${listingId}/download?scope=selected&ids=${selectedIds.join(",")}`} title="Zip of the selected photos at full resolution"><IconDownload />Download</a>}
          <button type="button" className="adm-chip adm-chip--quiet" onClick={() => bulk("revision", selectedIds)}>Mark as revised</button>
          <button type="button" className="adm-chip adm-chip--quiet" onClick={() => bulk("unrevision", selectedIds)}>Back to the gallery</button>
          <form
            className="amg-bar__section"
            onSubmit={(e) => {
              e.preventDefault();
              if (bulk("section", selectedIds, sectionDraft)) setSectionDraft("");
            }}
          >
            <input value={sectionDraft} onChange={(e) => setSectionDraft(e.target.value)} list="amg-sections" placeholder="Section name" aria-label="Section name, empty for the main gallery" autoComplete="off" />
            <button type="submit" className="adm-chip adm-chip--quiet">Move to section</button>
          </form>
          {canDelete && <button type="button" className="adm-chip adm-chip--danger" onClick={() => bulk("delete", selectedIds)}>Delete</button>}
          <button type="button" className="amg-bar__clear" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      </div>

      {previewCtx && (
        <Preview
          group={previewCtx.g}
          index={previewCtx.i}
          cover={cover}
          thumbOf={thumbOf}
          onClose={() => {
            const id = previewId;
            setPreviewId(null);
            if (id) refocus.current = id;
          }}
          onGo={(i) => setPreviewId(previewCtx.g.rows[i]?.id ?? previewId)}
          onCover={makeCover}
          onToggle={(m) => moveTo(isLive(m) ? "internal" : "client", [m.id])}
          onEdit={(m) => setEditId(m.id)}
          onDelete={canDelete ? (m) => {
            const rowsNow = previewCtx.g.rows;
            const i = rowsNow.findIndex((r) => r.id === m.id);
            const next = rowsNow[i + 1] ?? rowsNow[i - 1] ?? null;
            if (deleteOne(m)) setPreviewId(next ? next.id : null);
          } : undefined}
        />
      )}

      {editing && (
        <EditSheet
          m={editing}
          thumb={thumbOf(editing)}
          onClose={() => setEditId(null)}
          onSave={(v) => saveEdit(editing, v)}
        />
      )}
    </div>
  );
}

// ---- Tile menu ----------------------------------------------------------------

function TileMenu({ m, isCover, onPreview, onCover, onToggle, onEdit, onDelete }: {
  m: AdminMediaRow;
  isCover: boolean;
  onPreview: () => void;
  onCover: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const canCover = m.kind === "photo" && isLive(m);
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), a")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <div className="amg-menu" data-nodrag role="group" aria-label={`Actions for ${m.filename}`} onKeyDown={onKey}>
      <button type="button" onClick={onPreview}><IconExpand />Open preview</button>
      {canCover && (
        <button type="button" onClick={onCover} disabled={isCover}><IconStar />{isCover ? "Cover photo" : "Set as cover"}</button>
      )}
      <button type="button" onClick={onToggle}>{isLive(m) ? <IconEyeOff /> : <IconEye />}{isLive(m) ? "Move to internal only" : "Make client visible"}</button>
      {m.downloadUrl && (
        <a href={m.downloadUrl} download={m.filename} target="_blank" rel="noreferrer"><IconDownload />Download original</a>
      )}
      <button type="button" onClick={onEdit}><IconEdit />Edit details</button>
      {onDelete && (
        <>
          <hr />
          <button type="button" className="is-danger" onClick={onDelete}><IconTrash />Delete</button>
        </>
      )}
    </div>
  );
}

// ---- Preview --------------------------------------------------------------------

function Preview({ group, index, cover, thumbOf, onClose, onGo, onCover, onToggle, onEdit, onDelete }: {
  group: Group;
  index: number;
  cover: string | null;
  thumbOf: (m: AdminMediaRow) => string | null;
  onClose: () => void;
  onGo: (i: number) => void;
  onCover: (m: AdminMediaRow) => void;
  onToggle: (m: AdminMediaRow) => void;
  onEdit: (m: AdminMediaRow) => void;
  onDelete?: (m: AdminMediaRow) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const m = group.rows[index];
  const n = group.rows.length;
  const isCover = m.kind === "photo" && cover === m.r2Key;
  const badges = badgesFor(m, isCover);
  const src = m.kind === "photo" ? (failed.has(m.id) ? thumbOf(m) : m.previewUrl ?? thumbOf(m)) : null;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    document.documentElement.classList.add("amg-noscroll");
    return () => {
      document.documentElement.classList.remove("amg-noscroll");
      if (d?.open) d.close();
    };
  }, []);

  // Warm the neighbours so next and previous feel instant.
  useEffect(() => {
    for (const k of [index - 1, index + 1]) {
      const x = group.rows[k];
      const u = x && x.kind === "photo" ? x.previewUrl ?? thumbOf(x) : null;
      if (u) new Image().src = u;
    }
  }, [group, index, thumbOf]);

  const go = (d: number) => {
    const j = index + d;
    if (j >= 0 && j < n) onGo(j);
  };

  return (
    <dialog
      ref={ref}
      className="amg-lb"
      aria-label={`Preview of ${m.filename}`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClose={onClose}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === "VIDEO") return;
        if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
        if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      }}
    >
      <div className="amg-lb__top">
        <div className="amg-lb__meta">
          <div className="amg-lb__name">{m.filename}</div>
          <div className="amg-lb__sub"><span className="adm-mono">{index + 1} / {n}</span> · {group.title}{m.bytes ? ` · ${fmtBytes(m.bytes)}` : ""}</div>
        </div>
        <button type="button" className="amg-lb__icon amg-lb__mobile-nav" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous file"><IconLeft /></button>
        <button type="button" className="amg-lb__icon amg-lb__mobile-nav" onClick={() => go(1)} disabled={index === n - 1} aria-label="Next file"><IconRight /></button>
        <button type="button" className="amg-lb__icon" onClick={onClose} aria-label="Close preview" autoFocus><IconClose /></button>
      </div>

      <div
        className="amg-lb__stage"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        onPointerDown={(e) => { if (e.pointerType !== "mouse") swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || s.id !== e.pointerId) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => { swipe.current = null; }}
      >
        <button type="button" className="amg-lb__icon amg-lb__nav amg-lb__nav--prev" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous file"><IconLeft /></button>
        <div className="amg-lb__frame" key={m.id}>
          {m.kind === "video" ? (
            m.previewUrl ? (
              <video src={m.previewUrl} controls playsInline preload="metadata" />
            ) : (
              <div className="amg-lb__film"><FilmFace /></div>
            )
          ) : src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={m.filename}
              draggable={false}
              style={m.width && m.height ? { aspectRatio: `${m.width} / ${m.height}` } : undefined}
              onError={() => setFailed((s) => (s.has(m.id) ? s : new Set(s).add(m.id)))}
            />
          ) : (
            <div className="amg-lb__film" style={{ background: "rgba(255,255,255,.06)" }} />
          )}
        </div>
        <button type="button" className="amg-lb__icon amg-lb__nav amg-lb__nav--next" onClick={() => go(1)} disabled={index === n - 1} aria-label="Next file"><IconRight /></button>
      </div>

      <div className="amg-lb__bottom">
        <div className="amg-lb__badges">
          {badges.map((b) => <span key={b.label} className="amg-badge" data-tone={b.tone} title={b.title}>{b.label}</span>)}
        </div>
        {m.kind === "photo" && isLive(m) && (
          <button type="button" className={`amg-lb__btn${isCover ? " is-on" : ""}`} disabled={isCover} onClick={() => onCover(m)}>{isCover ? "Cover photo" : "Set as cover"}</button>
        )}
        <button type="button" className="amg-lb__btn" onClick={() => onToggle(m)}>{isLive(m) ? "Move to internal only" : "Make client visible"}</button>
        {m.downloadUrl && <a className="amg-lb__btn" href={m.downloadUrl} download={m.filename} target="_blank" rel="noreferrer">Download original</a>}
        <button type="button" className="amg-lb__btn" onClick={() => onEdit(m)}>Edit details</button>
        {onDelete && <button type="button" className="amg-lb__btn is-danger" onClick={() => onDelete(m)}>Delete</button>}
      </div>
    </dialog>
  );
}

// ---- Edit details ---------------------------------------------------------------

function EditSheet({ m, thumb, onClose, onSave }: {
  m: AdminMediaRow;
  thumb: string | null;
  onClose: () => void;
  onSave: (v: { filename: string; section: string; revision: boolean }) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const formId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="amg-sheet"
      aria-labelledby={`${formId}-t`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          onSave({ filename: String(f.get("filename") ?? ""), section: String(f.get("section") ?? ""), revision: f.get("revision") === "on" });
        }}
      >
        <div className="amg-sheet__head">
          <span className="amg-sheet__thumb">
            {m.kind === "video" ? <FilmFace /> : thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb} alt="" />
            ) : null}
          </span>
          <div style={{ minWidth: 0 }}>
            <h2 className="amg-sheet__title" id={`${formId}-t`}>Edit details</h2>
            <div className="adm-mono muted" style={{ fontSize: 11.5, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.filename}</div>
          </div>
        </div>
        <div className="amg-sheet__body">
          <div className="field">
            <label htmlFor={`${formId}-f`}>Filename</label>
            <input id={`${formId}-f`} name="filename" defaultValue={m.filename} autoComplete="off" spellCheck={false} style={{ fontFamily: "var(--font-mono)", fontSize: 14 }} />
            <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>The name the client downloads.</p>
          </div>
          <div className="field">
            <label htmlFor={`${formId}-s`}>Section</label>
            <input id={`${formId}-s`} name="section" defaultValue={m.section ?? ""} list="amg-sections" placeholder="Empty for the main gallery" autoComplete="off" />
          </div>
          <label className="flex items-center" style={{ gap: 10, fontSize: 14 }}>
            <input type="checkbox" name="revision" defaultChecked={m.revision} style={{ width: 18, height: 18 }} /> Revised file (shows under Revised)
          </label>
        </div>
        <div className="amg-sheet__foot">
          <button type="button" className="btn btn-ghost" style={{ padding: "11px 18px" }} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" style={{ padding: "11px 20px" }}>Save</button>
        </div>
      </form>
    </dialog>
  );
}
