import { redirect } from "next/navigation";

// The studio has no homepage. Everyone lands in the portal (which sends
// signed-out visitors to /portal/login).
export default function Home() {
  redirect("/portal");
}
