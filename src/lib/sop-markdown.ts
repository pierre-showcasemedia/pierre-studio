// A small markdown reader for the Team SOPs (src/content/sops/*.md), so the
// SOP pages need no new dependency. It knows exactly what those files use:
//
//   ## Heading / ### Subheading
//   paragraphs (consecutive lines join)
//   - bullets and 1. numbered lists, nested by indentation
//   ``` fenced blocks ```
//   | tables | with a |---| row under the header
//   > [!gap] Title        callouts: gap, stale, pending, verified, note;
//   > one paragraph per line
//   inline **bold**, *italic*, `code` and [links](/admin/sops/x or https://...)
//
// Pure: no React, no fs. src/components/admin/SopBody.tsx renders the blocks
// as React elements (never as raw HTML), and scripts/check-sops.ts parses
// every file with it.

export type Inline =
  | { t: "text"; v: string }
  | { t: "b" | "i"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "a"; href: string; c: Inline[] };

export type ListItem = { c: Inline[]; children: ListBlock[] };
export type ListBlock = { t: "ul" | "ol"; items: ListItem[] };
export type CalloutKind = "gap" | "stale" | "pending" | "verified" | "note";

export type Block =
  | { t: "h2" | "h3"; id: string; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | ListBlock
  | { t: "pre"; v: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "callout"; kind: CalloutKind; title: string; paras: Inline[][] };

const CALLOUTS: readonly CalloutKind[] = ["gap", "stale", "pending", "verified", "note"];

// Only site paths and web links become links; anything else stays text.
export const safeHref = (href: string): string | null => (/^\/(?!\/)/.test(href) || /^https:\/\//.test(href) ? href : null);

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*?)\*/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ t: "text", v: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "b", c: parseInline(m[2]) });
    else if (m[3] !== undefined) {
      const href = safeHref(m[4]);
      out.push(href ? { t: "a", href, c: parseInline(m[3]) } : { t: "text", v: m[0] });
    } else if (m[5] !== undefined) out.push({ t: "i", c: parseInline(m[5]) });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

export const inlineText = (c: Inline[]): string => c.map((x) => (x.t === "text" || x.t === "code" ? x.v : inlineText(x.c))).join("");

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";

const LIST_RE = /^( *)(-|\d+\.) (.*)$/;
const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function parseList(lines: string[]): ListBlock {
  // Each line is one item; deeper indentation nests under the item above.
  type Frame = { indent: number; list: ListBlock };
  const first = LIST_RE.exec(lines[0])!;
  const root: ListBlock = { t: /\d/.test(first[2]) ? "ol" : "ul", items: [] };
  const stack: Frame[] = [{ indent: first[1].length, list: root }];
  for (const line of lines) {
    const m = LIST_RE.exec(line)!;
    const indent = m[1].length;
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (indent > top.indent) {
      const parent = top.list.items[top.list.items.length - 1];
      const child: ListBlock = { t: /\d/.test(m[2]) ? "ol" : "ul", items: [] };
      if (parent) parent.children.push(child);
      else top.list.items.push({ c: [], children: [child] });
      stack.push({ indent, list: child });
      top = stack[stack.length - 1];
    }
    top.list.items.push({ c: parseInline(m[3]), children: [] });
  }
  return root;
}

export function parseSop(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const ids = new Set<string>();
  const uniqueId = (s: string) => {
    let id = slugify(s);
    for (let n = 2; ids.has(id); n++) id = `${slugify(s)}-${n}`;
    ids.add(id);
    return id;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    const h = /^(##|###) (.+)$/.exec(line);
    if (h) {
      blocks.push({ t: h[1] === "##" ? "h2" : "h3", id: uniqueId(h[2]), c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) body.push(lines[i].replace(/^> ?/, ""));
      const head = /^\[!(\w+)\]\s*(.*)$/.exec(body[0] ?? "");
      const kind = head && (CALLOUTS as readonly string[]).includes(head[1].toLowerCase()) ? (head[1].toLowerCase() as CalloutKind) : "note";
      const paras = (head ? body.slice(1) : body).filter((b) => b.trim()).map(parseInline);
      blocks.push({ t: "callout", kind, title: head?.[2] ?? "", paras });
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i]);
      const body = rows.slice(1).filter((r) => !/^\|[\s|:-]+\|?$/.test(r));
      blocks.push({ t: "table", head: cells(rows[0]).map(parseInline), rows: body.map((r) => cells(r).map(parseInline)) });
      continue;
    }
    if (LIST_RE.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && LIST_RE.test(lines[i]); i++) items.push(lines[i]);
      blocks.push(parseList(items));
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(```|##|>|\|)/.test(lines[i]) && !LIST_RE.test(lines[i]); i++) para.push(lines[i].trim());
    blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}
