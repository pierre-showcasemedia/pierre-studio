// Which of a shoot's files have landed in R2 (HEAD each key, 12 at a time).
// Shared by the upload-status route (resume) and the submit route (verify).
//
// Oct 21 2026: a shoot's files are photos (kind raw or display, the editing
// pipeline's input) and raw video (kind raw_video, copied to Dropbox and
// never sent to editing). Every place that picks files for editing goes
// through isEditingFile / editingFilesWhere, so a clip can never reach the
// editing service.
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ShootFileKind } from "@/db/schema";
import { headObject } from "./r2";

// The kinds the editing service receives.
export const EDITING_KINDS: readonly ShootFileKind[] = ["raw", "display"];

export function isEditingFile(f: { kind: string }): boolean {
  return (EDITING_KINDS as readonly string[]).includes(f.kind);
}

export const isRawVideo = (f: { kind: string }): boolean => f.kind === "raw_video";

// Drizzle condition for the editing files of one shoot.
export function editingFilesWhere(shootId: string) {
  return { shoot: eq(schema.shootFiles.shootId, shootId), kinds: inArray(schema.shootFiles.kind, [...EDITING_KINDS]) };
}

// Photos and clips, counted apart (the shoot page, the hub line, credits).
export function countKinds(files: { kind: string }[]): { photos: number; video: number } {
  let photos = 0;
  let video = 0;
  for (const f of files) {
    if (isRawVideo(f)) video++;
    else photos++;
  }
  return { photos, video };
}

export async function landedFiles(shootId: string): Promise<{ landed: string[]; missing: string[]; fileCount: number; kinds: { photos: number; video: number } }> {
  const files = await db().query.shootFiles.findMany({ where: eq(schema.shootFiles.shootId, shootId) });
  const landed: string[] = [];
  const missing: string[] = [];
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const f = files[i++];
      const h = await headObject(f.r2Key);
      if (h && h.size > 0) landed.push(f.filename);
      else missing.push(f.filename);
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, files.length || 1) }, worker));
  return { landed, missing, fileCount: files.length, kinds: countKinds(files) };
}
