"use client";
// A second shoot's own invoice (Oct 27 2026, src/lib/visit-invoice.ts).
// On the "Add second shoot" form: a "Create new invoice?" checkbox, unticked
// by default; ticking it opens the line items (description and amount in
// dollars, Add line, remove, a live total). Unticked, no line inputs are in
// the form at all, so nothing about money is posted. On a visit row's
// "Create invoice" form the editor shows on its own (`optional` false).
// The server checks everything again (parseVisitInvoiceLines).
import { useId, useState } from "react";

type Row = { key: number; desc: string; amount: string };

const MAX_LINES = 20;
const CAP_CENTS = 50_000 * 100;

function centsOf(raw: string): number | null {
  const v = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const c = Math.round(Number(v) * 100);
  return Number.isFinite(c) && c > 0 ? c : null;
}

function usd(cents: number): string {
  const frac = cents % 100 !== 0 ? 2 : 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
}

function LineEditor({ clientEmail }: { clientEmail: string | null }) {
  const id = useId();
  const [rows, setRows] = useState<Row[]>([{ key: 1, desc: "", amount: "" }]);
  const [next, setNext] = useState(2);
  const total = rows.reduce((n, r) => n + (centsOf(r.amount) ?? 0), 0);
  const over = total > CAP_CENTS;
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div style={{ display: "grid", gap: 10, border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
      <div className="kicker" style={{ margin: 0 }}>Invoice lines</div>
      {rows.map((r, i) => (
        <div key={r.key} className="flex flex-wrap items-end" style={{ gap: 10 }}>
          <div className="field" style={{ flex: "1 1 220px", minWidth: 0 }}>
            <label htmlFor={`${id}-d-${r.key}`}>Description {i + 1}</label>
            <input id={`${id}-d-${r.key}`} name="line_desc" required maxLength={200} value={r.desc} onChange={(e) => set(r.key, { desc: e.currentTarget.value })} placeholder="Return trip, twilight photography" />
          </div>
          <div className="field" style={{ width: 140 }}>
            <label htmlFor={`${id}-a-${r.key}`}>Amount, USD</label>
            <input id={`${id}-a-${r.key}`} name="line_amount" required type="number" min={0.01} step={0.01} inputMode="decimal" value={r.amount} onChange={(e) => set(r.key, { amount: e.currentTarget.value })} placeholder="300" />
          </div>
          {rows.length > 1 && (
            <button type="button" className="adm-chip adm-chip--quiet" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Remove line ${i + 1}`} style={{ marginBottom: 4 }}>
              Remove
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
        {rows.length < MAX_LINES && (
          <button
            type="button"
            className="adm-chip"
            onClick={() => {
              setRows((rs) => [...rs, { key: next, desc: "", amount: "" }]);
              setNext((n) => n + 1);
            }}
          >
            Add line
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontWeight: 500 }}>
          Total <span className="adm-mono">{usd(total)}</span>
        </span>
      </div>
      {over && <p className="adm-banner adm-banner--warn" style={{ margin: 0 }}>The total is over {usd(CAP_CENTS)}, the cap for a second shoot invoice. Check the amounts.</p>}
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
        Creates a card invoice for {clientEmail ?? "the client"} and emails the pay link. It stands apart from the booking&apos;s own invoice and never locks or unlocks the gallery.
      </p>
    </div>
  );
}

export function VisitInvoiceFields({ clientEmail, optional = true }: { clientEmail: string | null; optional?: boolean }) {
  const id = useId();
  const [on, setOn] = useState(false);
  if (!optional) return <LineEditor clientEmail={clientEmail} />;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <label htmlFor={`${id}-invoice`} className="flex items-center" style={{ gap: 8, fontSize: 14, cursor: "pointer" }}>
        <input id={`${id}-invoice`} type="checkbox" name="invoice" checked={on} onChange={(e) => setOn(e.currentTarget.checked)} />
        Create new invoice?
      </label>
      {on ? <LineEditor clientEmail={clientEmail} /> : <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Left unticked, no invoice is made and the client is not emailed.</p>}
    </div>
  );
}

// A submit button that asks first (Cancel on a visit row, which may void its invoice).
export function ConfirmSubmit({ label, message, className }: { label: string; message: string; className?: string }) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {label}
    </button>
  );
}
