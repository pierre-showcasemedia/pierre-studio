// Booking status words and colors, shared by the server pills and the client
// status controls (no server imports here, so client components can use it).
// The stored value "requested" reads "Unconfirmed" everywhere in the admin.
import type { BookingStatus } from "@/db/schema";

export const BOOKING_STATUS_ORDER: BookingStatus[] = ["requested", "confirmed", "shot", "delivered", "canceled"];

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  requested: "Unconfirmed",
  confirmed: "Confirmed",
  shot: "Shot",
  delivered: "Delivered",
  canceled: "Canceled",
};

export const BOOKING_STATUS_COLORS: Record<BookingStatus, { bg: string; fg: string }> = {
  requested: { bg: "rgba(154,100,0,.10)", fg: "#9A6400" },
  confirmed: { bg: "rgba(0,102,214,.09)", fg: "#0066D6" },
  shot: { bg: "rgba(95,100,110,.12)", fg: "#3F444D" },
  delivered: { bg: "rgba(26,127,75,.10)", fg: "#1A7F4B" },
  canceled: { bg: "rgba(215,52,42,.08)", fg: "#D7342A" },
};

export function bookingStatusLabel(s: string): string {
  return (BOOKING_STATUS_LABEL as Record<string, string>)[s] ?? s.replace(/_/g, " ");
}

export function isBookingStatus(s: unknown): s is BookingStatus {
  return typeof s === "string" && (BOOKING_STATUS_ORDER as string[]).includes(s);
}

// The statuses where an admin set the time (Confirm time or the status
// control). Intake fills starts_at for every booking that came with a time,
// so only the status says it was confirmed.
export function isTimeConfirmed(s: string): boolean {
  return s === "confirmed" || s === "shot" || s === "delivered";
}

// A canceled booking can come back as Unconfirmed or Confirmed only.
export const RESTORE_TO: BookingStatus[] = ["requested", "confirmed"];
