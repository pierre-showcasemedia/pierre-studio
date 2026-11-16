"use client";
// Send for final review, on the shoot page (Nov 3 2026). the coordinator: "After all
// completed adjustments, there needs to be a button on the photo QC dashboard
// that the editor can click, that will then send the message ... that tags
// all PMs (the coordinator, the coordinator, the owner, a manager) for final review of the photos."
//
// Before the send it says what is still open: QC flags not ticked, revised
// photos QC has not looked at since they were uploaded. That is a warning
// with a confirm, never a block (src/lib/qc-labels.ts reviewReadiness).
// After the send it says who sent it and when, and the button becomes Send
// again, which asks first; the server also refuses a second send while one
// is open unless it is that confirmed Send again, and anything inside two
// minutes of the last (src/lib/final-review.ts). Admins and the Photo QC team,
// through the finals done route (requireStaffApi). Nothing here emails a client.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { readinessWarning, type ReviewReadiness } from "@/lib/qc-labels";
import { fmtWhen } from "@/lib/shoot-status";

type Last = { by: string; at: string; corrected: number } | null;

// local, the same on the server and in the browser (no hydration mismatch).
const when = (iso: string) => fmtWhen(iso);

export default function FinalReviewPanel({ shootId, demo, reviewers, readiness, last, open, enabled }: {
  shootId: string;
  demo: boolean;
  reviewers: string; // "the final review team"
  readiness: ReviewReadiness;
  last: Last; // the latest send, whoever made it
  open: boolean; // that send is still open (not published since)
  enabled: boolean; // the frames are in
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [mine, setMine] = useState<Last>(null);
  const sent = mine ?? (open ? last : null);
  const warning = readinessWarning(readiness);

  const send = async () => {
    const again = Boolean(sent);
    const ask = again
      ? `Already sent for final review by ${sent!.by}, ${when(sent!.at)}.${warning ? `\n\n${warning}` : ""}\n\nSend it again and tag ${reviewers} again?`
      : warning
        ? `${warning}\n\nSend for final review anyway? ${reviewers} ${reviewers.includes(" and ") ? "are" : "is"} tagged in Slack.`
        : null;
    if (ask && !window.confirm(ask)) return;
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      if (demo) {
        await new Promise((r) => setTimeout(r, 300));
        setMine({ by: "you", at: new Date().toISOString(), corrected: readiness.revised });
        setInfo("Demo mode: nothing was posted and nobody was tagged.");
      } else {
        const r = await fetch(`/api/studio/shoots/${shootId}/finals/done`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ review: true, again }) });
        const j = await r.json().catch(() => ({ ok: false }));
        if (!j.ok) throw new Error(j.error || "Could not send it for final review.");
        if (!j.sent && j.reason === "already sent") {
          setMine({ by: j.by ?? "someone", at: j.at ?? new Date().toISOString(), corrected: j.corrected ?? 0 });
          setInfo(`It was already sent${j.by ? ` by ${j.by}` : ""}${j.at ? `, ${when(j.at)}` : ""}. Nothing new went out.`);
        } else {
          setMine({ by: j.by ?? "you", at: j.at ?? new Date().toISOString(), corrected: j.corrected ?? 0 });
        }
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <div className={`adm-card frv${sent ? " is-sent" : ""}`} id="final-review" role="region" aria-label="Final review">
      <div className="frv__text">
        <span className="kicker" style={{ margin: 0 }}>Final review</span>
        {sent ? (
          <p className="frv__line">
            Sent for final review by <strong>{sent.by}</strong>, {when(sent.at)}{sent.corrected ? ` · ${sent.corrected} revised photo${sent.corrected === 1 ? "" : "s"}` : ""}. {reviewers} {reviewers.includes(" and ") ? "were" : "was"} tagged in Slack. A PM gives the photos a last look and publishes them.
          </p>
        ) : (
          <p className="frv__line">
            When every fix is in, QC has run on the revised photos and each flag is ticked, send it to {reviewers} for the final pass. Everything stays Internal only.
          </p>
        )}
        {warning ? <p className="frv__warn">{warning}</p> : enabled && readiness.revised > 0 ? <p className="frv__ok">Every QC flag is ticked.</p> : null}
        {info && <p className="frv__info" role="status">{info}</p>}
        {err && <p className="frv__err" role="status">{err}</p>}
      </div>
      <div className="frv__act">
        <button type="button" className={`btn ${sent ? "btn-ghost" : "btn-primary"}`} onClick={() => void send()} disabled={busy || !enabled} title={enabled ? `Tags ${reviewers} in Slack` : "Available once the frames are in."}>
          {busy ? "Sending..." : sent ? "Send again" : "Send for final review"}
        </button>
      </div>
    </div>
  );
}
