"use client";
// The booking page's status control: one button per status, the current one
// filled in its color. A click saves at once (setBookingStatus). Canceled asks
// first; on a canceled booking only Unconfirmed and Confirmed are open.
// Below it, the booking's internal note (Oct 22 2026): Save note keeps it on
// the booking (saveBookingNote) without changing the status, and a status
// click saves an edited note too and puts it in the history with the change.
import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { BookingStatus } from "@/db/schema";
import { BOOKING_STATUS_COLORS, BOOKING_STATUS_LABEL, BOOKING_STATUS_ORDER, RESTORE_TO } from "@/lib/booking-status";
import { CANCEL_CONFIRM } from "./StatusSelect";

const NOTE_MAX = 2000; // same cap as the server (cleanNote in actions.ts)

// Only a status button puts "status" in the form data, so it tells the two
// saves apart. Save note has no name: React owns a button's name when its
// formAction is a server action, and leaves the button out of the form data.
function Buttons({ status }: { status: BookingStatus }) {
  const { pending, data } = useFormStatus();
  const savingStatus = pending && Boolean(data?.has("status"));
  return (
    <div className="bk-seg" role="group" aria-label="Booking status">
      {BOOKING_STATUS_ORDER.map((s) => {
        const current = s === status;
        const closed = status === "canceled" && s !== "canceled" && !RESTORE_TO.includes(s);
        const c = BOOKING_STATUS_COLORS[s];
        return (
          <button
            key={s}
            type="submit"
            name="status"
            value={s}
            aria-pressed={current}
            disabled={pending || current || closed}
            title={closed ? "A canceled booking comes back as Unconfirmed or Confirmed first" : current ? "The current status" : `Set to ${BOOKING_STATUS_LABEL[s]}`}
            style={current ? { background: c.bg, color: c.fg, borderColor: "transparent" } : undefined}
            className={s === "canceled" && !current ? "bk-seg__danger" : undefined}
          >
            {current && <span className="bk-seg__dot" style={{ background: c.fg }} aria-hidden />}
            {status === "canceled" && (s === "requested" || s === "confirmed") ? `Restore as ${BOOKING_STATUS_LABEL[s]}` : BOOKING_STATUS_LABEL[s]}
          </button>
        );
      })}
      {savingStatus && <span className="bk-saving" role="status">Saving</span>}
    </div>
  );
}

function SaveNote({ action, dirty, saveRef }: { action: (formData: FormData) => Promise<void>; dirty: boolean; saveRef: React.RefObject<HTMLButtonElement | null> }) {
  const { pending, data } = useFormStatus();
  const savingNote = pending && !data?.has("status");
  return (
    <div className="bk-note-actions">
      <button ref={saveRef} type="submit" formAction={action} className="btn btn-ghost" disabled={pending || !dirty}>
        {savingNote ? "Saving note" : "Save note"}
      </button>
      <span className="bk-saving" role="status">{dirty && !savingNote ? "Not saved yet" : ""}</span>
    </div>
  );
}

export function StatusControl({
  action,
  saveNote,
  status,
  note: saved,
}: {
  action: (formData: FormData) => Promise<void>;
  saveNote: (formData: FormData) => Promise<void>;
  status: BookingStatus;
  note: string | null;
}) {
  const [note, setNote] = useState(saved ?? "");
  const saveRef = useRef<HTMLButtonElement>(null);
  const dirty = note.trim() !== (saved ?? "").trim();
  return (
    <form
      action={action}
      className="bk-status-form"
      onSubmit={(e) => {
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === "canceled" && !window.confirm(CANCEL_CONFIRM)) e.preventDefault();
      }}
    >
      <Buttons status={status} />
      <div className="field bk-status-note">
        <label htmlFor="bk-status-note">Note, optional and internal</label>
        {/* A textarea, so Enter is a new line and never submits a status nobody picked. Cmd or Ctrl + Enter saves the note. */}
        <textarea
          id="bk-status-note"
          name="note"
          rows={2}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={status === "canceled" ? "Agent rebooked the same date" : "Agent postponed the listing"}
          style={{ minHeight: 0 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (dirty && saveRef.current && !saveRef.current.disabled) e.currentTarget.form?.requestSubmit(saveRef.current);
            }
          }}
        />
        <SaveNote action={saveNote} dirty={dirty} saveRef={saveRef} />
      </div>
    </form>
  );
}
