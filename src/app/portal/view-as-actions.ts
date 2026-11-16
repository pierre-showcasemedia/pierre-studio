"use server";
// Enter/exit admin "view as client". Gated on the REAL session being admin.
import { redirect } from "next/navigation";
import { assertAdmin } from "@/lib/admin";
import { setViewAs, clearViewAs, realSessionEmail } from "@/lib/portal-auth";
import { logActivity } from "@/lib/activity";

export async function enterViewAs(email: string) {
  await assertAdmin();
  await setViewAs(email);
  await logActivity({ actorEmail: await realSessionEmail(), action: "admin.view_as", meta: { as: email.trim().toLowerCase() } });
  redirect("/portal");
}

export async function exitViewAs() {
  await assertAdmin();
  await clearViewAs();
  redirect("/admin/listings");
}
