"use client";
// The bookings list's quick status change: a compact select in the booking's
// status colors that saves on change (setBookingStatus) and brings the admin
// back to the same filter and search. Canceled asks first, because it voids
// the open invoice. A canceled row offers only the two ways back.
import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { BookingStatus } from "@/db/schema";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_ORDER, RESTORE_TO } from "@/lib/booking-status";

export const CANCEL_CONFIRM =
  "Cancel this booking? The open invoice is voided (or the pay at close checkout closed), the calendar hold is released and the shooter's invite is canceled. A paid invoice is left alone. The client is not emailed.";

function Busy() {
  const { pending } = useFormStatus();
  return pending ? <span className="bk-saving" role="status">Saving</span> : null;
}

export function StatusSelect({ action, status, back, address }: { action: (formData: FormData) => Promise<void>; status: BookingStatus; back: string; address: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState<BookingStatus>(status);
  const options = status === "canceled" ? (["canceled", ...RESTORE_TO] as BookingStatus[]) : BOOKING_STATUS_ORDER;
  return (
    <form ref={form} action={action} className="bk-status-inline">
      <input type="hidden" name="back" value={back} />
      <span className="bk-status-wrap" data-s={value}>
        <select
          name="status"
          defaultValue={status}
          aria-label={`Status of ${address}`}
          className="bk-status-select"
          onChange={(e) => {
            const next = e.currentTarget.value as BookingStatus;
            if (next === "canceled" && !window.confirm(CANCEL_CONFIRM)) {
              e.currentTarget.value = value;
              return;
            }
            setValue(next);
            form.current?.requestSubmit();
          }}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {BOOKING_STATUS_LABEL[o]}
            </option>
          ))}
        </select>
      </span>
      <Busy />
    </form>
  );
}
