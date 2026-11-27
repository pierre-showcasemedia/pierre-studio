// The team's client notes in a private GitHub repo (BRAIN_REPO, owner/name;
// notes in brain/Clients/*.md), read
// from the studio, for the shoot brief. Each client note has YAML-ish front
// matter (emails, phones, names, domains) and a "## Before every shoot"
// section written for exactly this: the things a shooter must know before the
// client has to say them. Matching follows the brain's own lookup
// (tools/client_brief.py): exact email, then the team's own email domain,
// then phone (last 10 digits), then a listed name or the note's file name,
// then a property address already in the note's "Listings we've shot" table.
//
// Read-only, through the GitHub GraphQL API with BRAIN_GITHUB_TOKEN (a
// fine-grained token on BRAIN_REPO, Contents read-only). Either unset = no
// notes from the repo; the brief still goes out with the studio's own client notes.
// The notes are cached for 10 minutes per server instance.

const SHARED_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "icloud.com", "me.com", "mac.com", "aol.com", "hotmail.com", "outlook.com",
  "compass.com", "sothebys.realty", "sothebysrealty.com", "kw.com", "coldwellbanker.com", "corcoran.com",
  "exprealty.com", "remax.net", "century21.com", "bhhs.com", "redfin.com", "verizon.net", "comcast.net",
]);
const CACHE_MS = 10 * 60_000;

export type BrainNote = {
  file: string; // "David Kim Group.md"
  client: string;
  owner: string | null;
  meta: Record<string, string | string[]>;
  sections: Record<string, string[]>; // heading → its lines (blank lines dropped)
};

export type BrainBrief = { note: BrainNote; beforeEveryShoot: string[]; accessOnSite: string[]; matchedBy: string };

export function hasBrain(): boolean {
  return Boolean((process.env.BRAIN_GITHUB_TOKEN || "").trim() && /^[\w.-]+\/[\w.-]+$/.test((process.env.BRAIN_REPO || "").trim()));
}

function repo(): { owner: string; name: string; branch: string } {
  const [owner, name] = (process.env.BRAIN_REPO || "").trim().split("/");
  return { owner, name, branch: process.env.BRAIN_BRANCH || "main" };
}

export function parseNote(file: string, text: string): BrainNote {
  const meta: Record<string, string | string[]> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    for (const raw of m[1].split("\n")) {
      const line = raw.replace(/\s+#\s.*$/, "");
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (v.startsWith("[") && v.endsWith("]")) {
        const inner = v.slice(1, -1).trim();
        meta[k] = inner ? (inner.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? []).map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
      } else meta[k] = v.replace(/^["']|["']$/g, "");
    }
  }
  const sections: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of body.split("\n")) {
    const h = /^##\s+(.*)/.exec(line);
    if (h) {
      cur = h[1].trim();
      sections[cur] = [];
    } else if (cur && line.trim()) sections[cur].push(line.trimEnd());
  }
  const client = typeof meta.client === "string" && meta.client ? meta.client : file.replace(/\.md$/, "");
  return { file, client, owner: typeof meta.owner === "string" ? meta.owner : null, meta, sections };
}

let cache: { at: number; notes: BrainNote[] } | null = null;

export async function loadBrainNotes(): Promise<BrainNote[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.notes;
  const token = (process.env.BRAIN_GITHUB_TOKEN || "").trim();
  if (!token) return [];
  const { owner, name, branch } = repo();
  const query = `query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){object(expression:$expr){... on Tree{entries{name type object{... on Blob{text}}}}}}}`;
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "studio" },
    body: JSON.stringify({ query, variables: { owner, name, expr: `${branch}:brain/Clients` } }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { data?: { repository?: { object?: { entries?: { name: string; type: string; object?: { text?: string | null } }[] } } }; errors?: { message: string }[] };
  if (!r.ok || j.errors?.length) throw new Error(`brain read failed (${r.status}): ${j.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
  const notes = (j.data?.repository?.object?.entries ?? [])
    .filter((e) => e.type === "blob" && e.name.endsWith(".md") && !e.name.startsWith("_") && e.name !== "README.md" && e.object?.text)
    .map((e) => parseNote(e.name, e.object!.text!));
  cache = { at: Date.now(), notes };
  return notes;
}

const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);
const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// "1475 Example Magnolia Drive, Springfield" → "1475 magnolia" (number plus the first street words).
const streetKey = (s: string) => norm(s.split(",")[0]).replace(/\b(drive|dr|road|rd|lane|ln|street|st|avenue|ave|way|place|pl|court|ct|circle|cir|boulevard|blvd)\b/g, "").replace(/\s+/g, " ").trim();

export function matchBrainNote(notes: BrainNote[], who: { email?: string | null; phone?: string | null; name?: string | null; company?: string | null; address?: string | null }): { note: BrainNote; matchedBy: string } | null {
  const email = (who.email || "").trim().toLowerCase();
  const domain = email.split("@")[1] || "";
  const phone = who.phone ? digits(who.phone) : "";
  const names = [who.name, who.company].filter(Boolean).map((s) => norm(String(s)));
  const tests: [string, (n: BrainNote) => boolean][] = [
    ["email", (n) => Boolean(email) && list(n.meta.emails).some((e) => e.toLowerCase() === email)],
    ["domain", (n) => Boolean(domain) && !SHARED_DOMAINS.has(domain) && list(n.meta.domains).some((d) => d.toLowerCase() === domain)],
    ["phone", (n) => phone.length === 10 && list(n.meta.phones).some((p) => digits(p) === phone)],
    ["name", (n) => names.length > 0 && [...list(n.meta.names), n.client, n.file.replace(/\.md$/, "").replace(/\s*\(.*\)$/, "")].some((x) => names.includes(norm(x)))],
    ["address", (n) => {
      const key = who.address ? streetKey(who.address) : "";
      return key.length > 4 && (n.sections["Listings we've shot"] ?? []).some((l) => norm(l).includes(key));
    }],
  ];
  for (const [by, test] of tests) {
    const hit = notes.filter(test);
    if (hit.length === 1) return { note: hit[0], matchedBy: by };
  }
  return null;
}

const bullets = (lines: string[] | undefined) =>
  (lines ?? []).filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter((l) => l && !/^unknown\.?$/i.test(l));

export async function brainBriefFor(who: Parameters<typeof matchBrainNote>[1]): Promise<BrainBrief | null> {
  const notes = await loadBrainNotes();
  const hit = matchBrainNote(notes, who);
  if (!hit) return null;
  return { note: hit.note, matchedBy: hit.matchedBy, beforeEveryShoot: bullets(hit.note.sections["Before every shoot"]), accessOnSite: bullets(hit.note.sections["Access and on site"]) };
}
