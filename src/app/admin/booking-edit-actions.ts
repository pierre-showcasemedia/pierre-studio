"use server";
// Edit booking (Oct 21 2026): the one server action behind the "Edit
// booking" panel on /admin/bookings/<id>. Full admins only (the QA team never
// reaches bookings). Never throws: the outcome rides back on ?done= / ?error=
// like every booking action (src/app/admin/actions.ts), and the booking's
// jobs drain in after() so a preview sees the side effects at once. The rules
// live in src/lib/booking-edit.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { hasDb } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { applyBookingEdit, editInputFromForm } from "@/lib/booking-edit";
import { drainJobs } from "@/lib/jobs";

export async function editBooking(bookingId: string, formData: FormData) {
  const actor = await requireAdmin();
  let key: "done" | "error" = "error";
  let text: string;
  if (!hasDb()) text = "Demo mode: nothing was saved.";
  else {
    try {
      const r = await applyBookingEdit(bookingId, editInputFromForm(formData), actor);
      key = r.ok ? "done" : "error";
      text = r.ok ? r.message : r.error;
      if (r.ok) after(() => drainJobs({ budgetMs: 40_000, bookingId }).catch((e) => console.error("[admin/bookings] edit drain", e)));
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
    }
  }
  revalidatePath("/admin/bookings");
  revalidatePath("/admin");
  revalidatePath(`/admin/bookings/${bookingId}`);
  redirect(`/admin/bookings/${bookingId}?${key}=${encodeURIComponent(text)}`);
}
