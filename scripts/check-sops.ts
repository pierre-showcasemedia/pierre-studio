// Checks for the Team SOPs (/admin/sops, Nov 3 2026). No database, no network.
//
//   npx tsx scripts/check-sops.ts
//
// 1. The index (src/lib/sops.ts): unique slugs, every SOP under at least one
//    department, every department slug a real SOP, every SOP a markdown file
//    (src/content/sops/<slug>.md) and every markdown file an SOP.
// 2. Every file parses (src/lib/sop-markdown.ts) into headings and blocks, its
//    links go to a real SOP or an https page, and its callouts are known kinds.
// 3. Who sees what: every team role (admin, Photo QC, creative specialist,
//    video editor) sees every SOP (Nov 3 2026, the owner: "make SOPs tab visible
//    to everyone, all SOPs"), and both pages sit on the team gate.
// 4. No secrets, client contact details or em dashes in the words.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEPARTMENTS, SOPS, sopBySlug, sopMenu } from "../src/lib/sops";
import { parseSop, type Block, type Inline, type ListBlock } from "../src/lib/sop-markdown";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "src/content/sops");
let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};

// 1. The index
const slugs = SOPS.map((s) => s.slug);
ok(new Set(slugs).size === slugs.length, "SOP slugs are unique");
ok(DEPARTMENTS.map((d) => d.label).join("|") === "Project management|Sales|QA & delivery|Creative specialists", "the four departments, in order");
for (const d of DEPARTMENTS) {
  ok(d.sops.length > 0, `${d.label} has SOPs`);
  ok(new Set(d.sops).size === d.sops.length, `${d.label} lists each SOP once`);
  for (const s of d.sops) ok(sopBySlug(s), `${d.label}: ${s} is an SOP`);
}
for (const s of SOPS) {
  ok(DEPARTMENTS.some((d) => d.sops.includes(s.slug)), `${s.slug} sits under a department`);
  ok(/^[a-z0-9-]+$/.test(s.slug), `${s.slug} is a plain slug`);
  ok(s.sources.length > 0, `${s.slug} names the parts of the studio it describes`);
}
const files = readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.replace(/\.md$/, ""));
for (const s of slugs) ok(files.includes(s), `${s}.md exists`);
for (const f of files) ok(slugs.includes(f), `${f}.md is in the index`);
console.log(`1. index: ${SOPS.length} SOPs in ${DEPARTMENTS.length} departments`);

// 2. Parsing
const inlines = (c: Inline[]): Inline[] => c.flatMap((x) => (x.t === "b" || x.t === "i" || x.t === "a" ? [x, ...inlines(x.c)] : [x]));
const listInlines = (l: ListBlock): Inline[] => l.items.flatMap((it) => [...inlines(it.c), ...it.children.flatMap(listInlines)]);
const blockInlines = (b: Block): Inline[] =>
  b.t === "h2" || b.t === "h3" || b.t === "p" ? inlines(b.c)
  : b.t === "ul" || b.t === "ol" ? listInlines(b)
  : b.t === "table" ? [...b.head, ...b.rows.flat()].flatMap(inlines)
  : b.t === "callout" ? b.paras.flatMap(inlines)
  : [];
const text: Record<string, string> = {};
let callouts = 0;
for (const s of SOPS) {
  const md = readFileSync(path.join(DIR, `${s.slug}.md`), "utf8");
  text[s.slug] = md;
  const blocks = parseSop(md);
  ok(blocks.length >= 2, `${s.slug} parses into blocks`);
  ok(blocks.some((b) => b.t === "h2"), `${s.slug} has a section heading`);
  for (const b of blocks) {
    if (b.t === "callout") {
      callouts++;
      ok(b.paras.length > 0, `${s.slug}: a ${b.kind} callout has words`);
    }
    if (b.t === "table") ok(b.rows.every((r) => r.length === b.head.length), `${s.slug}: table rows match the header`);
    for (const x of blockInlines(b)) {
      if (x.t !== "a") continue;
      const m = /^\/admin\/sops\/([a-z0-9-]+)$/.exec(x.href);
      ok(m ? sopBySlug(m[1]) : x.href.startsWith("https://"), `${s.slug}: link ${x.href} goes somewhere real`);
    }
  }
  // A markdown link the reader would not turn into a link (a typo).
  ok(!/\]\((?!\/admin\/sops\/|https:\/\/)[^)]*\)/.test(md), `${s.slug}: every markdown link is a site path or https`);
}
console.log(`2. parsing: ok (${callouts} callouts)`);

// 3. Who sees what
const menu = new Set(sopMenu().flatMap((d) => d.sops.map((s) => s.slug)));
ok(menu.size === SOPS.length, `the menu lists every SOP (${menu.size} of ${SOPS.length})`);
for (const slug of ["payments", "shooter-pay"]) ok(menu.has(slug), `${slug} is in the menu for everyone`);
// The business words: every {{word}} an SOP uses is one fillSopWords knows.
{
  const known = readFileSync(path.join(ROOT, "src/lib/sop-content.ts"), "utf8");
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".md") && x !== "README.md")) {
    const used = [...readFileSync(path.join(DIR, f), "utf8").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    for (const w of used) ok(new RegExp(`\\b${w}:`).test(known), `${f}: {{${w}}} is a known business word`);
  }
}
for (const page of ["src/app/admin/sops/page.tsx", "src/app/admin/sops/[slug]/page.tsx"]) {
  const src = readFileSync(path.join(ROOT, page), "utf8");
  ok(/await requireTeam\(\)/.test(src) && !/requireStaff|requireAdmin/.test(src), `${page} is on the team gate`);
}
console.log("3. access: ok");

// 4. Words
for (const s of SOPS) {
  const md = text[s.slug];
  ok(!md.includes("—"), `${s.slug}: no em dashes`);
  ok(!/(sk|pk|rk)_(live|test)_|whsec_|xox[bp]-|ghp_|github_pat_|AKIA[0-9A-Z]{12}|postgres(ql)?:\/\//.test(md), `${s.slug}: nothing secret-looking`);
  // The only phone number is the Quo line; the only emails are the team's.
  const phones = (md.match(/\(?\d{3}\)?[ .-]\d{3}-\d{4}/g) ?? []).filter((p) => !p.includes("308-7877"));
  ok(phones.length === 0, `${s.slug}: no phone numbers but the Quo line (${phones.join(", ")})`);
  const emails = (md.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []).filter((e) => !e.endsWith("@example.com"));
  ok(emails.length === 0, `${s.slug}: no client emails (${emails.join(", ")})`);
}
console.log("4. words: ok");

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
