// The words of each Team SOP: src/content/sops/<slug>.md, with the business
// words filled in ({{name}}, see fillSopWords), read from disk on
// the server (src/lib/sops.ts is the index). The folder is added to the
// /admin/sops server bundle in next.config.ts (outputFileTracingIncludes), so
// it ships on Vercel. Read once per server instance.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { business } from "./business";
import { sopBySlug } from "./sops";

// The business words an SOP may use ({{name}} and the rest), from src/lib/business.ts.
export function fillSopWords(md: string): string {
  const words: Record<string, string> = {
    name: business.name,
    owner: business.owner,
    turnaround: business.turnaround,
    supportEmail: business.supportEmail,
    phone: business.phone || "the business line",
    timeZone: business.timeZoneLabel,
    portal: business.portalUrl.replace(/^https?:\/\//, ""),
  };
  return md.replace(/\{\{(\w+)\}\}/g, (all, k: string) => words[k] ?? all);
}

const DIR = path.join(process.cwd(), "src", "content", "sops");
const cache = new Map<string, string>();

export async function sopMarkdown(slug: string): Promise<string | null> {
  // Only a slug from the index ever reaches the disk (no path from the URL).
  if (!sopBySlug(slug)) return null;
  const hit = cache.get(slug);
  if (hit !== undefined) return hit;
  try {
    const md = fillSopWords(await readFile(path.join(DIR, `${slug}.md`), "utf8"));
    cache.set(slug, md);
    return md;
  } catch {
    return null;
  }
}
