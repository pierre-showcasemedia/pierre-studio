// The admin as a Home Screen app (Oct 28 2026): on an iPhone, Share › Add to
// Home Screen on any admin page installs "the studio", which opens the admin
// full screen like an app (no Safari bars). Public on purpose: the phone
// fetches it without the session cookie, and it holds nothing private.
import { brand } from "@/lib/brand";
export const dynamic = "force-static";

export function GET() {
  return Response.json(
    {
      name: `${brand.name}`,
      short_name: `${brand.name}`,
      description: `Bookings, Photo QC, listings and delivery for ${brand.name}.`,
      id: "/admin",
      start_url: "/admin",
      scope: "/",
      display: "standalone",
      orientation: "any",
      background_color: "#FFFFFF",
      theme_color: "#FFFFFF",
      icons: [
        { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
      ],
    },
    { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } },
  );
}
