// Renders a Team SOP's markdown (parsed by src/lib/sop-markdown.ts) as React
// elements. Styles: src/styles/admin-sops.css (.sop-doc, .sop-call).
import Link from "next/link";
import { Fragment } from "react";
import type { Block, CalloutKind, Inline, ListBlock } from "@/lib/sop-markdown";

const CALLOUT_LABEL: Record<CalloutKind, string> = { gap: "Gap", stale: "Stale reference", pending: "Pending brain update", verified: "Verified", note: "Note" };

function Text({ c }: { c: Inline[] }) {
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case "text": return <Fragment key={i}>{x.v}</Fragment>;
          case "code": return <code key={i}>{x.v}</code>;
          case "b": return <strong key={i}><Text c={x.c} /></strong>;
          case "i": return <em key={i}><Text c={x.c} /></em>;
          case "a":
            return x.href.startsWith("/")
              ? <Link key={i} href={x.href}><Text c={x.c} /></Link>
              : <a key={i} href={x.href} target="_blank" rel="noopener noreferrer"><Text c={x.c} /></a>;
        }
      })}
    </>
  );
}

function List({ l }: { l: ListBlock }) {
  const items = l.items.map((it, i) => (
    <li key={i}>
      <Text c={it.c} />
      {it.children.map((ch, j) => <List key={j} l={ch} />)}
    </li>
  ));
  return l.t === "ol" ? <ol>{items}</ol> : <ul>{items}</ul>;
}

export function SopBody({ blocks }: { blocks: Block[] }) {
  return (
    <div className="sop-doc">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h2": return <h2 key={i} id={b.id}><Text c={b.c} /></h2>;
          case "h3": return <h3 key={i} id={b.id}><Text c={b.c} /></h3>;
          case "p": return <p key={i}><Text c={b.c} /></p>;
          case "ul":
          case "ol": return <List key={i} l={b} />;
          case "pre": return <pre key={i}>{b.v}</pre>;
          case "table":
            return (
              <div key={i} className="sop-table">
                <table>
                  <thead><tr>{b.head.map((h, j) => <th key={j} scope="col"><Text c={h} /></th>)}</tr></thead>
                  <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Text c={c} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          case "callout":
            return (
              <aside key={i} className={`sop-call sop-call--${b.kind}`}>
                <div className="sop-call__tag">{b.title || CALLOUT_LABEL[b.kind]}</div>
                {b.paras.map((p, j) => <p key={j}><Text c={p} /></p>)}
              </aside>
            );
        }
      })}
    </div>
  );
}
