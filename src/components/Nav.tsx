import Image from "next/image";
import { brand, marketingHost } from "@/lib/brand";
import Link from "next/link";

// Portal header: the business lockup (white over a cover photo, black
// on white pages) and a quiet link back to the marketing site.
// The business letters are cut out of the box, so the ground shows through them.
export default function Nav({ overlay = false }: { overlay?: boolean }) {
  const h = 36;
  const w = Math.round(h * brand.logoRatio);
  const headerStyle: React.CSSProperties = overlay
    ? {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        background: "linear-gradient(180deg, rgba(11,12,15,.45), rgba(11,12,15,0))",
      }
    : { position: "sticky", top: 0, zIndex: 50, background: "rgba(255,255,255,.9)", backdropFilter: "blur(16px) saturate(120%)", borderBottom: "1px solid var(--line)", viewTransitionName: "portal-nav" };

  return (
    <header style={headerStyle}>
      <div className="wrap flex items-center justify-between" style={{ height: "var(--nav-h)" }}>
        <Link href="/portal" aria-label={`${brand.name} client portal`} style={{ display: "block", width: w, height: h }}>
          <Image src={overlay ? brand.logoWhite : brand.logoBlack} alt={`${brand.name}`} width={w} height={h} priority />
        </Link>
        <a
          href={brand.marketingUrl}
          style={{ fontSize: 12, color: overlay ? "rgba(255,255,255,.92)" : "var(--color-ink-soft)" }}
        >
          {marketingHost()} ↗
        </a>
      </div>
    </header>
  );
}
