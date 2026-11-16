import Image from "next/image";
import { brand, marketingHost } from "@/lib/brand";
import { business } from "@/lib/business";

export default function Footer() {
  const h = 56;
  const w = Math.round(h * brand.logoRatio);
  return (
    <footer style={{ background: "var(--color-obsidian)", color: "#fff", padding: "64px 0 40px" }}>
      <div className="wrap flex flex-wrap items-start justify-between" style={{ gap: 32 }}>
        <Image src={brand.logoWhite} alt={`${brand.name}`} width={w} height={h} />
        <p style={{ maxWidth: "36ch", color: "#A0A4AB", fontSize: 14, lineHeight: 1.7, margin: 0 }}>
          {`Real estate photography and film in ${business.region}.`}
        </p>
      </div>
      <div
        className="wrap flex flex-wrap justify-between"
        style={{ marginTop: 44, paddingTop: 22, borderTop: "1px solid #ffffff30", fontSize: 12, color: "#A0A4AB", gap: 16 }}
      >
        <span>© {new Date().getFullYear()} {brand.legalName}</span>
        <a href={brand.marketingUrl} style={{ color: "#A0A4AB" }}>{marketingHost()} ↗</a>
      </div>
    </footer>
  );
}
