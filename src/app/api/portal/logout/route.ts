import { redirect } from "next/navigation";
import { destroySession } from "@/lib/portal-auth";

export async function POST() {
  await destroySession();
  redirect("/portal/login");
}
