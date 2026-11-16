// The QC report panel at the top of a shoot page: what the automatic pass
// found, counts by severity, the worst frames first, and where the pass
// stands while it is still running. Server-safe, presentational.
import type { ShootQcSummary, ShootStatus } from "@/db/schema";
import type { AdminFrame } from "@/lib/admin-types";
import { fmtWhen } from "@/lib/shoot-status";
import { qcFixProgress } from "@/lib/qc-labels";

export default function QcReport({
  status, summary, progress, frames, notes, qcConfigured,
}: {
  status: ShootStatus;
  summary: ShootQcSummary | null;
  progress: { done?: number; total?: number } | null;
  frames: AdminFrame[];
  notes: string[];
  qcConfigured: boolean;
}) {
  const running = status === "qc";
  const skippedNote = notes.find((n) => n.startsWith("QC pass skipped") || n.startsWith("QC incomplete") || n.startsWith("QC budget"));
  const checked = frames.filter((f) => f.qcCheckedAt && f.qcScore != null).length;

  if (running) {
    const done = progress?.done ?? checked;
    const total = progress?.total ?? frames.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return (
      <div className="adm-card adm-card--lg adm-qc" style={{ marginTop: 14 }}>
        <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
          <div className="kicker" style={{ margin: 0 }}>Automatic QC</div>
          <span className="adm-pill" style={{ background: "rgba(0,102,214,.09)", color: "#0066D6" }}><span className="adm-dot adm-dot--live" />QC {done} of {total}</span>
        </div>
        <div className="adm-progress" style={{ marginTop: 12 }}><span style={{ width: `${pct}%` }} /></div>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 12, marginBottom: 0 }}>Every frame is being checked for people, gear in reflections, processing artifacts, blown windows, tilt, dust and color before review. Every frame stays Internal only in its section; each problem becomes a checkbox on the frame.</p>
      </div>
    );
  }

  if (!summary) {
    if (["draft", "uploaded", "transferring", "committing", "processing", "importing", "twilight", "failed"].includes(status)) return null;
    return (
      <div className="adm-card adm-qc" style={{ marginTop: 14 }}>
        <div className="kicker" style={{ margin: 0 }}>Automatic QC</div>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 8, marginBottom: 0 }}>
          {skippedNote ?? (qcConfigured ? "QC has not run on this shoot yet. Use Run QC to check every frame." : "QC pass skipped: key not set. Add ANTHROPIC_API_KEY to turn it on.")}
        </p>
      </div>
    );
  }

  const tiles: { n: number | string; l: string; tone: string }[] = [
    { n: summary.blocked, l: "Blocked", tone: summary.blocked ? "#D7342A" : "var(--color-ink-faint)" },
    { n: summary.fix, l: "To fix", tone: summary.fix ? "#9A6400" : "var(--color-ink-faint)" },
    { n: summary.minor, l: "Minor", tone: summary.minor ? "#0066D6" : "var(--color-ink-faint)" },
    { n: summary.clean, l: "Clean", tone: "#1A7F4B" },
    { n: summary.avgScore ?? "", l: "Average score", tone: "var(--color-ink)" },
  ];

  // Nov 2 2026: the Photo QC team's ticks on the flags (src/lib/qc-fixes.ts).
  const fixes = frames.reduce((t, f) => {
    const p = qcFixProgress(f.qcIssues, f.qcFixes);
    return { done: t.done + p.done, total: t.total + p.total };
  }, { done: 0, total: 0 });

  return (
    <div className="adm-card adm-card--lg adm-qc" style={{ marginTop: 14 }}>
      <div className="flex flex-wrap items-center justify-between" style={{ gap: 10 }}>
        <div className="kicker" style={{ margin: 0 }}>QC report</div>
        <span className="muted" style={{ fontSize: 12.5 }}>{summary.checked} of {summary.total} frames checked{summary.finishedAt ? ` · ${fmtWhen(summary.finishedAt)}` : ""}{fixes.total ? ` · ${fixes.done} of ${fixes.total} fixes done` : ""}</span>
      </div>
      <div className="adm-qc__tiles" style={{ marginTop: 14 }}>
        {tiles.map((t) => (
          <div key={t.l} className="adm-qc__tile">
            <div className="adm-qc__n" style={{ color: t.tone }}>{t.n}</div>
            <div className="adm-qc__l">{t.l}</div>
          </div>
        ))}
      </div>
      {summary.blocked > 0 && (
        <p className="adm-banner adm-banner--warn" style={{ marginTop: 14, marginBottom: 0 }}>
          {summary.blocked} frame{summary.blocked === 1 ? " has" : "s have"} a blocking problem. {summary.blocked === 1 ? "It stays" : "They stay"} in {summary.blocked === 1 ? "its" : "their"} section, Internal only and unreviewed, and Approve all leaves {summary.blocked === 1 ? "it" : "them"} for a person. Open the frame to see the flag.
        </p>
      )}
      {summary.worst.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 500 }}>Look at these first</div>
          <ol className="adm-qc__worst">
            {summary.worst.map((w) => {
              const f = frames.find((x) => x.id === w.mediaId);
              const p = f ? qcFixProgress(f.qcIssues, f.qcFixes) : null;
              return (
                <li key={w.mediaId}>
                  <a href={`#frame-${w.mediaId}`} className="adm-mono" style={{ textDecoration: "none" }}>{w.filename}</a>
                  <span className="adm-qc__score" data-tone={w.score != null && w.score <= 4 ? "block" : w.score != null && w.score <= 6 ? "fix" : "minor"}>{w.score ?? "?"}</span>
                  <span className="muted" style={{ fontSize: 13 }}>{w.summary}{f?.qcState === "rejected" ? " · pulled" : ""}{p?.total ? ` · ${p.done} of ${p.total} done` : ""}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {(summary.notes.length > 0 || summary.skipped > 0) && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
          {summary.notes.join(" ")}{summary.skipped && !summary.notes.length ? `${summary.skipped} frame${summary.skipped === 1 ? "" : "s"} could not be checked.` : ""}
        </p>
      )}
    </div>
  );
}
