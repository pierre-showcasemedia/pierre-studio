"use client";
// Reschedule, on a row of the client's Bookings tab. Opens a dialog with the
// open times from the business's calendar (the same one the booking form reads), lets
// the client pick a day and a start, and moves the booking. The team hears
// right away; the business confirms the new time.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { EASE, prefersReducedMotion, useFocusTrap, useScrollLock } from "@/components/gallery/hooks";
import { CloseIcon } from "@/components/gallery/icons";
import "@/styles/gallery.css";
import { business } from "@/lib/business";

// How the client reaches the business when something here fails.
const contactLine = business.phone ? `Text us at ${business.phone}.` : `Email us at ${business.supportEmail}.`;

type Slot = { start: string; available: boolean };
type Day = { date: string; closed: boolean; slots: Slot[] };
type Options = { availability: { source: "calendar" | "open"; minutes: number; days: Day[] }; current: { date: string | null; time: string | null; when: string | null } };

const dayLabel = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return {
    dow: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d),
    num: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", day: "numeric" }).format(d),
    mon: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(d),
    long: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(d),
  };
};
// The month grid (Oct 21 2026: the sideways day strip lost its scroll bar). "2026-10" → its label, the
// weekday of the 1st (0 = Sunday) and how many days it has.
const monthInfo = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return {
    label: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 1, 12))),
    lead: new Date(Date.UTC(y, m - 1, 1)).getUTCDay(),
    count: new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
};
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const Chevron = ({ left = false }: { left?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" style={left ? { transform: "rotate(180deg)" } : undefined}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
const time12 = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export default function RescheduleButton({ bookingId, street }: { bookingId: string; street: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ph-resched"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        Reschedule
      </button>
      {open && <RescheduleDialog bookingId={bookingId} street={street} onClose={() => setOpen(false)} />}
    </>
  );
}

function RescheduleDialog({ bookingId, street, onClose }: { bookingId: string; street: string; onClose: () => void }) {
  const router = useRouter();
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [phase, setPhase] = useState<"pick" | "saving" | "done">("pick");
  const [doneWhen, setDoneWhen] = useState<string>("");
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);

  useScrollLock(true);
  useFocusTrap(panelRef, true, { initial: closeRef });

  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    overlayRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: EASE });
    panelRef.current?.animate([{ opacity: 0, transform: "translateY(18px) scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: EASE });
  }, []);

  useEffect(() => {
    let live = true;
    fetch(`/api/portal/bookings/${bookingId}/reschedule`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok || !j.ok) setError(j.error || `We could not load open times. ${contactLine}`);
        else {
          setOpts(j as Options);
          const first = (j as Options).availability.days.find((d) => !d.closed && d.slots.some((s) => s.available));
          setDay(first?.date ?? null);
          setMonth((first?.date ?? (j as Options).availability.days[0]?.date ?? "").slice(0, 7) || null);
        }
      })
      .catch(() => live && setError(`We could not load open times. ${contactLine}`));
    return () => {
      live = false;
    };
  }, [bookingId]);

  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    if (!prefersReducedMotion()) {
      await Promise.all([
        overlayRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: "forwards" }).finished,
        panelRef.current?.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(10px)" }], { duration: 200, easing: EASE, fill: "forwards" }).finished,
      ]).catch(() => {});
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const days = useMemo(() => opts?.availability.days ?? [], [opts]);
  const chosen = useMemo(() => days.find((d) => d.date === day) ?? null, [days, day]);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const months = useMemo(() => [...new Set(days.map((d) => d.date.slice(0, 7)))], [days]);
  const shown = month ?? months[0] ?? null;
  const monthAt = shown ? months.indexOf(shown) : -1;

  const save = async () => {
    if (!day || !time) return;
    setPhase("saving");
    setError(null);
    const r = await fetch(`/api/portal/bookings/${bookingId}/reschedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: day, time }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok || !j.ok) {
      setPhase("pick");
      setError(j.error || `That did not go through. Try again, or ${contactLine.charAt(0).toLowerCase()}${contactLine.slice(1)}`);
      if (r?.status === 409) setTime(null);
      return;
    }
    setDoneWhen(j.when);
    setPhase("done");
    router.refresh();
  };

  return createPortal(
    <div className="g-modal" role="presentation">
      <div ref={overlayRef} className="g-modal__overlay" onClick={() => void close()} aria-hidden="true" />
      <div ref={panelRef} className="g-modal__panel rs" role="dialog" aria-modal="true" aria-labelledby="rs-title">
        <button ref={closeRef} type="button" className="g-modal__x" aria-label="Close" onClick={() => void close()}>
          <CloseIcon />
        </button>
        <div className="kicker">Reschedule</div>
        <h2 id="rs-title" className="g-modal__title">
          Move {street}.
        </h2>

        {phase === "done" ? (
          <div className="g-modal__status" aria-live="polite">
            <p className="g-modal__end g-modal__end--ok">Moved to {doneWhen}</p>
            <p className="g-modal__msg">We have your new time and will confirm it shortly. If anything needs to change, we will text you.</p>
            <span className="g-modal__btns">
              <button type="button" className="btn btn-primary" onClick={() => void close()}>
                Done
              </button>
            </span>
          </div>
        ) : (
          <>
            <p className="g-modal__lede">
              {opts?.current.when ? `Now booked for ${opts.current.when}. ` : ""}Pick a new day and start time. Times shown are open on our calendar.
            </p>
            {!opts && !error && <p className="rs-loading">Finding open times</p>}
            {opts && (
              <>
                {shown && (() => {
                  const m = monthInfo(shown);
                  return (
                    <div className="rs-cal">
                      <div className="rs-cal__head">
                        <button type="button" className="rs-cal__nav" aria-label="Previous month" disabled={monthAt <= 0} onClick={() => setMonth(months[monthAt - 1])}>
                          <Chevron left />
                        </button>
                        <span className="rs-cal__month" aria-live="polite">{m.label}</span>
                        <button type="button" className="rs-cal__nav" aria-label="Next month" disabled={monthAt >= months.length - 1} onClick={() => setMonth(months[monthAt + 1])}>
                          <Chevron />
                        </button>
                      </div>
                      <div className="rs-cal__grid" role="group" aria-label={`Days in ${m.label}`}>
                        {DOW.map((w) => (
                          <span key={w} className="rs-cal__dow" aria-hidden="true">{w}</span>
                        ))}
                        {Array.from({ length: m.lead }, (_, i) => (
                          <span key={`lead-${i}`} aria-hidden="true" />
                        ))}
                        {Array.from({ length: m.count }, (_, i) => {
                          const date = `${shown}-${String(i + 1).padStart(2, "0")}`;
                          const d = byDate.get(date);
                          const any = Boolean(d && !d.closed && d.slots.some((s) => s.available));
                          return (
                            <button
                              key={date}
                              type="button"
                              aria-pressed={day === date}
                              aria-label={`${dayLabel(date).long}${any ? "" : ", no open times"}`}
                              className={`rs-cal__day${day === date ? " is-on" : ""}`}
                              disabled={!any}
                              onClick={() => {
                                setDay(date);
                                setTime(null);
                              }}
                            >
                              {i + 1}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
                {chosen && (
                  <>
                    <p className="rs-daylabel">{dayLabel(chosen.date).long}</p>
                    <div className="rs-slots" role="listbox" aria-label="Start time">
                      {chosen.slots.map((s) => (
                        <button
                          key={s.start}
                          type="button"
                          role="option"
                          aria-selected={time === s.start}
                          className={`rs-slot${time === s.start ? " is-on" : ""}`}
                          disabled={!s.available}
                          onClick={() => setTime(s.start)}
                        >
                          {time12(s.start)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {error && (
              <p className="rs-error" role="alert">
                {error}
              </p>
            )}
            <div className="g-modal__foot">
              <span className="rs-note">Changes within 24 hours of the shoot may carry a fee.</span>
              <span className="g-modal__btns">
                <button type="button" className="btn btn-ghost" onClick={() => void close()}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" disabled={!day || !time || phase === "saving"} onClick={() => void save()}>
                  {phase === "saving" ? "Moving" : day && time ? `Move to ${dayLabel(day).dow} ${time12(time)}` : "Move my shoot"}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
