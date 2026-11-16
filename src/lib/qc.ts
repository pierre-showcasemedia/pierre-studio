// Automatic QC pass (v1.2). One finished frame goes to Claude with a strict
// JSON contract and comes back scored, with issues by severity and a line of
// suggestions. The pipeline runs this on every frame before a human looks
// (status "qc"); the shoot page can run it again on demand.
//
// Env (names in .env.example, values in Vercel):
//   ANTHROPIC_API_KEY        unset = the pass is skipped with a visible note
//   ANTHROPIC_WORKSPACE_ID   only for an org-level key that is not scoped to a
//                            workspace (the API then requires the
//                            anthropic-workspace-id header); a workspace key needs nothing
//   STUDIO_QC_MODEL          default claude-sonnet-5-5 (claude-haiku-5-5 is the cheap option)
//   STUDIO_QC_MAX_FRAMES     default 400 frames per shoot
//
// Admin-side copy may say "automatic QC". The prompt forbids the model from
// naming any vendor, software or model in what it writes, so nothing stored
// here can leak that into a client-facing surface by accident.
import Anthropic from "@anthropic-ai/sdk";
import { QC_ISSUE_TYPES, QC_SEVERITIES, type QcIssue, type QcSeverity, type ShootQcSummary } from "@/db/schema";
import { worstSeverity } from "./qc-labels";

export { ISSUE_LABELS, worstSeverity } from "./qc-labels";

export const QC_DEFAULT_MODEL = "claude-sonnet-5-5";
export const QC_CHEAP_MODEL = "claude-haiku-5-5";

export function hasQc(): boolean {
  return Boolean((process.env.ANTHROPIC_API_KEY || "").trim());
}

export function qcModel(): string {
  const m = (process.env.STUDIO_QC_MODEL || "").trim();
  if (!m) return QC_DEFAULT_MODEL;
  if (/^haiku$/i.test(m)) return QC_CHEAP_MODEL;
  if (/^sonnet$/i.test(m)) return QC_DEFAULT_MODEL;
  return m;
}

export function qcMaxFrames(): number {
  const n = Number((process.env.STUDIO_QC_MAX_FRAMES || "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 400;
}

export type QcResult = { score: number; issues: QcIssue[]; suggestions: string[]; summary: string };

export function qcWorkspaceId(): string | null {
  return (process.env.ANTHROPIC_WORKSPACE_ID || "").trim() || null;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const ws = qcWorkspaceId();
    _client = new Anthropic({
      apiKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
      maxRetries: 1,
      timeout: 60_000,
      ...(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {}),
    });
  }
  return _client;
}

const SYSTEM = `You are the first-pass quality control reviewer for a luxury real estate photography studio. You are shown one finished listing photo and you report exactly what a senior retoucher would need to fix before the client sees it.

Judge against professional MLS and luxury listing standards. Report only what you can actually see in the frame. A clean frame gets an empty issues list; do not invent problems.

Severity guide:
- block (must not ship): a person, the photographer, a camera, tripod or any gear visible anywhere, including in mirrors, windows, TVs or glossy surfaces; obvious processing artifacts such as warped or duplicated text, duplicated or melted objects, smeared or impossible geometry, hard halos; a sky that is missing or clearly pasted wrong; heavy blur or a badly misfocused frame.
- fix (correct before delivery): blown-out windows with no exterior detail, visibly tilted verticals or a crooked horizon, sensor dust spots, a strong color cast (green, magenta, orange, blue), muddy shadows or crushed blacks, bright hot spots, clutter that should have been removed (cords, bins, toiletries, pet items, cars in the driveway), lens flare, a dirty or spotted lens, converging lines that should be straight.
- minor (nice to improve): slight warmth or coolness, small distractions, composition that could be tighter, slight softness, a lamp or fixture that could be on or off.

If the frame is a twilight or dusk image, a dark sky and lit windows are intended; judge it as a twilight.

Rules for what you write:
- Be specific about where in the frame: "upper left corner", "through the right window", "in the mirror above the vanity".
- Score 1 to 10: 9 to 10 flawless, 7 to 8 ships with small tweaks, 5 to 6 needs work, 1 to 4 do not ship. A block issue caps the score at 4.
- summary: one plain sentence a photo editor can act on.
- suggestions: up to three short, concrete edits a retoucher could make. Leave the list empty when nothing is needed.
- Plain English, short sentences. Never mention software, services, models, vendors or AI in anything you write. Do not use em dashes or double hyphens.`;

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "1 to 10" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...QC_ISSUE_TYPES] },
          severity: { type: "string", enum: [...QC_SEVERITIES] },
          note: { type: "string", description: "What and where in the frame" },
        },
        required: ["type", "severity", "note"],
        additionalProperties: false,
      },
    },
    suggestions: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["score", "issues", "suggestions", "summary"],
  additionalProperties: false,
} as const;

// Strip anything the prompt forbids but a model might still slip in.
const scrub = (s: string) => s.replace(/\u2014|--/g, ",").replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();

function normalize(raw: unknown): QcResult {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const scoreN = Number(o.score);
  let score = Number.isFinite(scoreN) ? Math.min(10, Math.max(1, Math.round(scoreN))) : 5;
  const issues: QcIssue[] = [];
  for (const it of Array.isArray(o.issues) ? o.issues : []) {
    const x = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const type = QC_ISSUE_TYPES.includes(x.type as QcIssue["type"]) ? (x.type as QcIssue["type"]) : "other";
    const severity = QC_SEVERITIES.includes(x.severity as QcSeverity) ? (x.severity as QcSeverity) : "minor";
    const note = scrub(String(x.note ?? "")).slice(0, 300);
    if (!note) continue;
    issues.push({ type, severity, note });
  }
  if (issues.some((i) => i.severity === "block")) score = Math.min(score, 4);
  const suggestions = (Array.isArray(o.suggestions) ? o.suggestions : []).map((s) => scrub(String(s ?? "")).slice(0, 240)).filter(Boolean).slice(0, 3);
  const summary = scrub(String(o.summary ?? "")).slice(0, 300) || (issues.length ? "Needs attention." : "Clean frame.");
  return { score, issues, suggestions, summary };
}

// Run the QC pass on one JPEG (ideally the 1600px preview). Throws on API
// failure; callers decide whether the error is fatal for the whole pass.
export async function qcImage(jpeg: Buffer, ctx: { filename?: string; section?: string | null } = {}): Promise<QcResult & { model: string }> {
  const model = qcModel();
  const label = [ctx.filename ? `Frame: ${ctx.filename}` : null, ctx.section ? `Section: ${ctx.section}` : null].filter(Boolean).join(". ");
  const r = await client().messages.create({
    model,
    max_tokens: 2048,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
          { type: "text", text: `${label ? `${label}. ` : ""}Review this listing photo and return the JSON.` },
        ],
      },
    ],
  });
  if (r.stop_reason === "refusal") {
    throw new QcError("The QC model declined to review this frame.", "frame");
  }
  const text = r.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed) throw new QcError("The QC model did not return JSON for this frame.", "frame");
  return { ...normalize(parsed), model };
}

// "fatal": the whole pass cannot run (bad key, unknown model, bad request).
// "retry": transient, try again on the next tick (rate limit, 5xx, network).
// "frame": this frame only; move on.
export class QcError extends Error {
  kind: "fatal" | "retry" | "frame";
  constructor(message: string, kind: "fatal" | "retry" | "frame") {
    super(message);
    this.kind = kind;
  }
}

export function classifyQcError(e: unknown): { kind: "fatal" | "retry" | "frame"; message: string } {
  if (e instanceof QcError) return { kind: e.kind, message: e.message };
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return { kind: "fatal", message: "QC pass skipped: the QC key was rejected. Check ANTHROPIC_API_KEY." };
  }
  if (e instanceof Anthropic.NotFoundError) {
    return { kind: "fatal", message: `QC pass skipped: the QC model "${qcModel()}" was not found. Check STUDIO_QC_MODEL.` };
  }
  if (e instanceof Anthropic.BadRequestError) {
    // An org-level key without a workspace: nothing will work until it is set.
    if (/workspace/i.test(e.message)) {
      return { kind: "fatal", message: "QC pass skipped: the QC key is not scoped to a workspace. Set ANTHROPIC_WORKSPACE_ID or use a workspace API key." };
    }
    // A too-large image or a schema the model rejects: skip this frame, keep going.
    return { kind: "frame", message: e.message.slice(0, 200) };
  }
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
    return { kind: "retry", message: e.message.slice(0, 200) };
  }
  if (e instanceof Anthropic.APIError) return { kind: "frame", message: e.message.slice(0, 200) };
  return { kind: "frame", message: e instanceof Error ? e.message.slice(0, 200) : String(e) };
}

// ---- Roll-ups --------------------------------------------------------------

export type QcFrameLite = {
  id: string;
  filename: string;
  qcScore: number | null;
  qcIssues: QcIssue[] | null;
  qcSummary: string | null;
  qcCheckedAt: Date | string | null;
};

export function summarizeQc(frames: QcFrameLite[], extra: { skipped?: number; notes?: string[]; model?: string | null } = {}): ShootQcSummary {
  // Checked = the model answered. A frame marked checked with no score was an error on that frame.
  const checked = frames.filter((f) => f.qcCheckedAt && typeof f.qcScore === "number");
  let blocked = 0, fix = 0, minor = 0, clean = 0;
  for (const f of checked) {
    const w = worstSeverity(f.qcIssues);
    if (w === "block") blocked++;
    else if (w === "fix") fix++;
    else if (w === "minor") minor++;
    else clean++;
  }
  const scores = checked.map((f) => f.qcScore).filter((s): s is number => typeof s === "number");
  const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  const worst = [...checked]
    .filter((f) => worstSeverity(f.qcIssues) !== null)
    .sort((a, b) => (a.qcScore ?? 10) - (b.qcScore ?? 10))
    .slice(0, 6)
    .map((f) => ({ mediaId: f.id, filename: f.filename, score: f.qcScore, summary: f.qcSummary }));
  return {
    total: frames.length,
    checked: checked.length,
    skipped: extra.skipped ?? frames.length - checked.length,
    blocked,
    fix,
    minor,
    clean,
    avgScore,
    worst,
    notes: extra.notes ?? [],
    model: extra.model ?? null,
    finishedAt: new Date().toISOString(),
  };
}

// One line for Slack and the activity feed. Admin-side: may say "QC".
export function qcSummaryLine(s: ShootQcSummary | null | undefined): string {
  if (!s) return "";
  if (!s.checked) return s.notes[0] ?? "QC did not run.";
  const parts = [`${s.checked} frame${s.checked === 1 ? "" : "s"} checked`];
  if (s.blocked) {
    const why = topBlockReason(s);
    parts.push(`${s.blocked} blocked${why ? ` (${why})` : ""}`);
  }
  if (s.fix) parts.push(`${s.fix} to fix`);
  if (s.minor) parts.push(`${s.minor} minor`);
  if (s.avgScore != null) parts.push(`score ${s.avgScore}`);
  if (s.skipped) parts.push(`${s.skipped} not checked`);
  return parts.join(", ");
}

function topBlockReason(s: ShootQcSummary): string | null {
  const w = s.worst[0];
  if (!w?.summary) return null;
  return w.summary.length > 60 ? `${w.summary.slice(0, 57).trimEnd()}...` : w.summary;
}
