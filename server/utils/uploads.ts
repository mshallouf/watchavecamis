import fs from "node:fs";
import path from "node:path";
import config from "../config.ts";

// Directory where files from "Upload & Play"/"Upload & Convert" are stored and
// served from (mounted at /uploads). This module lives in server/utils, so we
// go up two levels to reach the project root.
export const uploadDir = path.resolve(
  import.meta.dirname + "/../../" + config.UPLOAD_DIRECTORY,
);

export function ensureUploadDir(): void {
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
  } catch (e) {
    console.error("failed to create upload directory", e);
  }
}

// Upload folder ids are 8 random bytes as hex (see server.ts upload endpoints).
const UPLOAD_ID_RE = /\/uploads\/([a-f0-9]{16})(?:\/|$)/g;

// Extract the upload folder id(s) referenced by a media URL served from this
// server. Returns [] for URLs that aren't our uploads.
export function extractUploadIds(url: string | null | undefined): string[] {
  if (!url) {
    return [];
  }
  const ids: string[] = [];
  UPLOAD_ID_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UPLOAD_ID_RE.exec(url)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

// Permanently delete an uploaded file's folder. No-op if the id is malformed or
// the folder doesn't exist (e.g. it lived on a different server).
export function deleteUpload(id: string): void {
  if (!/^[a-f0-9]{16}$/.test(id)) {
    return;
  }
  try {
    fs.rmSync(path.join(uploadDir, id), { recursive: true, force: true });
  } catch {
    // ignore
  }
}
