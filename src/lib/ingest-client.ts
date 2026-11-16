// Browser side of the upload calls (links, ingest, the run's end), shared by
// UploadFinals, UploadToListing, the Video card's cut upload and Upload a shoot.
//
// Nov 10 2026 (3330 Cedar Road, 100 MP finals): when the server instance
// holding a call is killed (it ran out of memory, the hosting logs say), the
// platform answers with an HTML error page instead of the route's JSON, and
// every row read "Unexpected token '<', "<!DOCTYPE "... is not valid JSON".
// The server now keeps its image work inside its memory (src/lib/image-gate.ts).
// This file is the other half: a call that gets no proper answer is never
// shown as a parse error, and where repeating it is safe it is tried again
// after a pause, on its own, before anyone has to press anything.
//
//   readJson    the body as JSON, or { ok: false, dropped: true, error } in plain words
//   postJson    one POST; with retries, for calls that are safe to repeat
//   ingestBatch the ingest call for a few files: a dropped batch is sent again
//               one file per call, each tried up to three times

export const SERVER_DROPPED = "The server did not finish this one. Press Upload again to retry it.";
const SIGNED_OUT = "You are signed out. Sign in again in another tab, then press Upload.";
const OFFLINE = "No connection to the server. Check the internet, then press Upload again.";

export type Reply<T> = T & { ok: boolean; error?: string; dropped?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The route's own JSON, whatever the status. Anything else (the platform's
// error page, an empty body) is a dropped call, said plainly.
export async function readJson<T = Record<string, unknown>>(r: Response): Promise<Reply<T>> {
  const text = await r.text().catch(() => "");
  try {
    const j = JSON.parse(text) as Reply<T>;
    if (j && typeof j === "object") {
      if (r.status === 401 && !j.ok) return { ...j, ok: false, error: SIGNED_OUT };
      return { ...j, ok: Boolean(j.ok) };
    }
  } catch {
    // not JSON: fall through
  }
  return { ok: false, dropped: true, error: r.status === 401 ? SIGNED_OUT : SERVER_DROPPED } as Reply<T>;
}

async function postOnce<T>(url: string, body: unknown): Promise<Reply<T>> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, dropped: true, error: OFFLINE } as Reply<T>;
  }
  return readJson<T>(r);
}

// One POST that always resolves and never throws. retries: how many more
// times to send it when the call was dropped (only for calls that are safe to
// repeat: upload links, the end of a run). The pauses give a killed instance
// time to be replaced.
const RETRY_WAITS = [2500, 7000, 15000];
export async function postJson<T = Record<string, unknown>>(url: string, body: unknown, opts: { retries?: number } = {}): Promise<Reply<T>> {
  let last = await postOnce<T>(url, body);
  for (let i = 0; i < (opts.retries ?? 0) && last.dropped; i++) {
    await sleep(RETRY_WAITS[Math.min(i, RETRY_WAITS.length - 1)]);
    last = await postOnce<T>(url, body);
  }
  return last;
}

type Item = { filename: string; mediaId: string };
type Failed = { filename: string; error: string };
export type IngestReply = { ok: boolean; error?: string; replaced: Item[]; added: Item[]; failed: Failed[] };

const empty = () => ({ replaced: [] as Item[], added: [] as Item[], failed: [] as Failed[] });

// Ingest `files` (safe names) with one call. Ingest is safe to repeat (the
// files stay in storage; the server replaces or adds by name), so when the
// call is dropped each file is sent again on its own, up to three tries with
// a pause between, and only a file that still fails is reported, in plain
// words. extra: the rest of the body (run, section, published...).
const FILE_WAITS = [4000, 10000];
export async function ingestBatch(url: string, files: string[], extra: Record<string, unknown>): Promise<IngestReply> {
  const first = await postOnce<Partial<IngestReply>>(url, { ...extra, files });
  if (!first.dropped) return { ...empty(), ...first, ok: first.ok };
  await sleep(3000);
  const out: IngestReply = { ok: true, ...empty() };
  for (const f of files) {
    let one = await postOnce<Partial<IngestReply>>(url, { ...extra, files: [f] });
    for (let i = 0; i < FILE_WAITS.length && one.dropped; i++) {
      await sleep(FILE_WAITS[i]);
      one = await postOnce<Partial<IngestReply>>(url, { ...extra, files: [f] });
    }
    if (one.ok) {
      out.replaced.push(...(one.replaced ?? []));
      out.added.push(...(one.added ?? []));
      out.failed.push(...(one.failed ?? []));
    } else {
      out.failed.push({ filename: f, error: one.error || "ingest failed" });
    }
  }
  return out;
}
