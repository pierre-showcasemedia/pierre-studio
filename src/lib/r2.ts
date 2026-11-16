// Cloudflare R2 (S3-compatible). Downloads are served with short-lived signed
// URLs, minted ONLY after the server has checked auth + payment status.
// That is what makes the payment lock enforceable.
//
// v1.1 adds the write side for the upload pipeline: presigned PUT URLs for
// direct browser uploads (shoots/<id>/raw/...), server-side puts for edited
// frames and derivatives, buffered reads for the transfer to editing, and
// streaming copies for Dropbox imports.
import { Readable } from "node:stream";
import {
  S3Client,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Env values as pasted into Vercel sometimes carry a trailing space or newline.
const r2env = (k: string): string => (process.env[k] || "").trim();

export function hasR2(): boolean {
  return Boolean(
    r2env("R2_ACCOUNT_ID") && r2env("R2_ACCESS_KEY_ID") && r2env("R2_SECRET_ACCESS_KEY") && r2env("R2_BUCKET")
  );
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${r2env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2env("R2_ACCESS_KEY_ID"),
        secretAccessKey: r2env("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return _client;
}
const bucket = () => r2env("R2_BUCKET");

export async function objectExists(key: string): Promise<boolean> {
  return (await headObject(key)) !== null;
}

// Size and type of an object, or null when it is not there.
export async function headObject(key: string): Promise<{ size: number; contentType: string | null } | null> {
  try {
    const r = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
  } catch {
    return null;
  }
}

// 1-hour signed URL for inline viewing (gallery previews, video playback).
export async function signedViewUrl(key: string): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: 3600 }
  );
}

// Signed download URL with a friendly filename. Default 10 minutes; Dropbox
// Saver batches get 1 hour since Dropbox fetches the files server-side.
export async function signedDownloadUrl(key: string, filename: string, expiresIn = 600): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
    }),
    { expiresIn }
  );
}

// ---- v1.1 write side -----------------------------------------------------

// Presigned PUT for a direct browser upload. The Content-Type is signed in, so
// the browser must send exactly this header. 1 hour: a slow cellular upload of
// a big raw still fits. The bucket needs a CORS rule allowing PUT from the
// portal origin (see STUDIO.md).
export async function presignedPutUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn }
  );
}

export async function putObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
  await client().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
}

// Whole object in memory. Fine for photos (tens of MB); never use for video.
export async function getObjectBuffer(key: string): Promise<{ body: Buffer; contentType: string | null }> {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const bytes = await r.Body!.transformToByteArray();
  // A view of the same bytes, not a second copy (Nov 10 2026: a 25 MB photo was held twice).
  return { body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType: r.ContentType ?? null };
}

// One byte range of an object, in memory. The Dropbox mirror reads a big
// video in chunks (tens of MB) so a copy can stop at a tick's deadline and
// the next tick carries on from the same offset. `end` is inclusive.
export async function getObjectRange(key: string, start: number, end: number): Promise<Buffer> {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=${start}-${end}` }));
  const bytes = await r.Body!.transformToByteArray();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); // a view, not a second copy of a 64 MB chunk
}

// Streamed read, for zips of many originals (nothing held in memory).
export async function getObjectStream(key: string): Promise<{ body: Readable; size: number | null; contentType: string | null }> {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return { body: r.Body as Readable, size: r.ContentLength ?? null, contentType: r.ContentType ?? null };
}

// Remove one object. Only two callers: the raw cleanup (src/lib/r2-raw-cleanup.ts),
// after Dropbox's copy is verified, and Start over on an upload that was never
// submitted (src/lib/discard-upload.ts). Delivered finals are never deleted.
export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

// Server-side copy inside the bucket (keeps the previous version of a frame
// when a corrected final replaces it, and moves a staged final into place).
// contentType: set it on the copy instead of keeping the source's.
export async function copyObject(fromKey: string, toKey: string, contentType?: string): Promise<void> {
  await client().send(
    new CopyObjectCommand({
      Bucket: bucket(),
      Key: toKey,
      CopySource: `/${bucket()}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
      ...(contentType ? { ContentType: contentType, MetadataDirective: "REPLACE" as const } : {}),
    })
  );
}

// Stream an incoming body (a Dropbox direct link, for example) into R2 with
// multipart upload, so nothing is held in memory and size can be unknown.
export async function streamToR2(key: string, body: ReadableStream<Uint8Array> | Readable, contentType: string): Promise<number> {
  const stream = body instanceof Readable ? body : Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => { bytes += chunk.length; });
  const up = new Upload({
    client: client(),
    params: { Bucket: bucket(), Key: key, Body: stream, ContentType: contentType },
    partSize: 16 * 1024 * 1024,
    queueSize: 3,
  });
  await up.done();
  return bytes;
}

// ---- Multipart uploads driven one part at a time (Nov 10 2026) -----------------
// For work that has to survive the end of a run: the "Download all" zips
// (src/lib/zip-resume.ts) send a part, note it, and a later run sends the
// next one into the same upload. Every part but the last must have the same
// size (R2's rule). An upload nobody completes is dropped by the bucket after
// seven days.

// The upload is no longer there: aborted, expired, or already completed.
export class UploadGoneError extends Error {
  constructor(key: string) {
    super(`the upload for ${key} is gone`);
    this.name = "UploadGoneError";
  }
}
// openObject with an etag: the object was replaced since that version.
export class ObjectChangedError extends Error {
  constructor(key: string) {
    super(`${key} was replaced while it was being read`);
    this.name = "ObjectChangedError";
  }
}

// The part-at-a-time calls go through a client that adds no checksum headers
// of its own (the SDK's newer default puts a CRC32 on every part, which a
// completion would then have to hand back part by part). The plain multipart
// protocol is what R2 documents: a completion lists part numbers and ETags,
// nothing a later run has to remember from an earlier one. Each part is
// still checked on arrival: the request is signed over the SHA-256 of its
// body.
let _plain: S3Client | null = null;
function plainClient(): S3Client {
  if (!_plain) {
    _plain = new S3Client({
      region: "auto",
      endpoint: `https://${r2env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2env("R2_ACCESS_KEY_ID"),
        secretAccessKey: r2env("R2_SECRET_ACCESS_KEY"),
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _plain;
}

const errName = (e: unknown): string => (e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "");
const errStatus = (e: unknown): number | null => {
  const s = (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return typeof s === "number" ? s : null;
};
const uploadGone = (e: unknown) => errName(e) === "NoSuchUpload";

// One part may take this long before the call is dropped (16 MB at 0.4 MB/s);
// a hung connection must never hold a run past its end.
const PART_TIMEOUT_MS = 45_000;

export async function multipartStart(key: string, contentType: string): Promise<string> {
  const r = await plainClient().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }));
  if (!r.UploadId) throw new Error(`storage did not start an upload for ${key}`);
  return r.UploadId;
}

export async function multipartPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<void> {
  try {
    await plainClient().send(new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: body.length }), { abortSignal: AbortSignal.timeout(PART_TIMEOUT_MS) });
  } catch (e) {
    if (uploadGone(e)) throw new UploadGoneError(key);
    throw e;
  }
}

// Lands the object, but only when storage holds exactly the parts the writer
// sent: `parts` of them, numbered from 1, adding up to `bytes`. Anything else
// (a part missing, a stray size) is an UploadGoneError, so the writer starts
// that file over instead of landing a broken one.
export async function multipartComplete(key: string, uploadId: string, expect: { parts: number; bytes: number }): Promise<void> {
  try {
    const have: { PartNumber: number; ETag: string; size: number }[] = [];
    let marker: string | undefined;
    do {
      const r = await plainClient().send(new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker }));
      for (const p of r.Parts ?? []) if (p.PartNumber && p.ETag) have.push({ PartNumber: p.PartNumber, ETag: p.ETag, size: p.Size ?? 0 });
      marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
    } while (marker);
    const mine = have.filter((p) => p.PartNumber <= expect.parts).sort((a, b) => a.PartNumber - b.PartNumber);
    const total = mine.reduce((a, p) => a + p.size, 0);
    if (mine.length !== expect.parts || mine.some((p, i) => p.PartNumber !== i + 1) || total !== expect.bytes) {
      console.error(`[r2] ${key}: storage has ${mine.length} parts and ${total} bytes of this upload, the writer sent ${expect.parts} and ${expect.bytes}`);
      throw new UploadGoneError(key);
    }
    await plainClient().send(new CompleteMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, MultipartUpload: { Parts: mine.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) } }));
  } catch (e) {
    if (uploadGone(e)) throw new UploadGoneError(key);
    throw e;
  }
}

// Drop an upload and its parts. Quiet when it is already gone.
export async function multipartAbort(key: string, uploadId: string): Promise<void> {
  try {
    await plainClient().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
  } catch (e) {
    if (!uploadGone(e)) throw e;
  }
}

// A streamed read from byte `from` on, with the object's whole size and its
// version (etag). null when the object is not there. Given an etag, storage
// only answers with that version: a file replaced in the meantime is an
// ObjectChangedError, never a mix of two files. A read from the start goes
// through the usual client (which checks a whole object against its stored
// checksum, as getObjectStream does); a read from the middle cannot be
// checked that way, so it goes through the plain one.
export async function openObject(key: string, from = 0, etag: string | null = null): Promise<{ body: Readable; size: number; etag: string | null } | null> {
  try {
    const r = await (from > 0 ? plainClient() : client()).send(new GetObjectCommand({ Bucket: bucket(), Key: key, ...(from > 0 ? { Range: `bytes=${from}-` } : {}), ...(etag ? { IfMatch: etag } : {}) }));
    const size = from > 0 ? Number(/\/(\d+)\s*$/.exec(r.ContentRange ?? "")?.[1] ?? NaN) : (r.ContentLength ?? NaN);
    if (!Number.isFinite(size)) {
      (r.Body as Readable | undefined)?.destroy();
      throw new Error(`storage gave no size for ${key}`);
    }
    return { body: r.Body as Readable, size, etag: r.ETag ?? null };
  } catch (e) {
    if (errName(e) === "NoSuchKey" || errStatus(e) === 404) return null;
    if (errName(e) === "PreconditionFailed" || errStatus(e) === 412) throw new ObjectChangedError(key);
    throw e;
  }
}

export async function listKeys(prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const r = await client().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// Filenames become R2 key segments: keep letters, digits, dot, dash, underscore.
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "file";
}
