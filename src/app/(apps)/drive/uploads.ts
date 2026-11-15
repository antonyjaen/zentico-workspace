"use client";

import { useCallback, useRef, useState } from "react";
import { ensureFoldersAction } from "./actions";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const CONCURRENCY = 3;

export type UploadEntry = { file: File; relPath?: string };

export type Upload = {
  key: string;
  name: string;
  size: number;
  loaded: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
};

let seq = 0;

/** Upload queue with per-file XHR progress. `onSettled` runs once a batch finishes. */
export function useUploads(onSettled: () => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const patch = useCallback((key: string, p: Partial<Upload>) => {
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));
  }, []);

  const start = useCallback(
    async (entries: UploadEntry[], parentId: string | null, accountId: string | null = null) => {
      if (!entries.length) return;
      const jobs = entries.map((e) => ({ ...e, key: `u${++seq}` }));
      setUploads((list) => [
        ...list,
        ...jobs.map((j) => ({
          key: j.key,
          name: j.relPath || j.file.name,
          size: j.file.size,
          loaded: 0,
          status: (j.file.size > MAX_UPLOAD_BYTES ? "error" : "queued") as Upload["status"],
          error: j.file.size > MAX_UPLOAD_BYTES ? "too_large" : undefined,
        })),
      ]);

      // Folder uploads: create the folder tree first.
      const dirOf = (p?: string) => (p && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
      const dirs = [...new Set(jobs.map((j) => dirOf(j.relPath)).filter(Boolean))];
      let folderIds: Record<string, string> = {};
      if (dirs.length) {
        const r = await ensureFoldersAction(parentId, dirs, accountId);
        if (!r.ok) {
          for (const j of jobs) if (dirOf(j.relPath)) patch(j.key, { status: "error", error: r.error });
        } else folderIds = r.data;
      }

      const queue = jobs.filter((j) => j.file.size <= MAX_UPLOAD_BYTES && (!dirOf(j.relPath) || folderIds[dirOf(j.relPath)]));
      const worker = async () => {
        for (let j = queue.shift(); j; j = queue.shift()) {
          const dir = dirOf(j.relPath);
          await send(j.file, dir ? folderIds[dir] : parentId, accountId, j.key, patch);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      settled.current();
    },
    [patch],
  );

  const clear = useCallback(() => setUploads((list) => list.filter((u) => u.status === "queued" || u.status === "uploading")), []);

  return { uploads, start, clear };
}

function send(
  file: File,
  parentId: string | null,
  accountId: string | null,
  key: string,
  patch: (k: string, p: Partial<Upload>) => void,
) {
  return new Promise<void>((resolve) => {
    const q = new URLSearchParams({ name: file.name });
    if (parentId) q.set("parentId", parentId);
    if (accountId) q.set("account", accountId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/drive/upload?${q}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && patch(key, { loaded: e.loaded });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) patch(key, { status: "done", loaded: file.size });
      else {
        let error = "failed";
        try {
          error = (JSON.parse(xhr.responseText) as { error?: string }).error ?? error;
        } catch {}
        patch(key, { status: "error", error });
      }
      resolve();
    };
    xhr.onerror = () => {
      patch(key, { status: "error", error: "network" });
      resolve();
    };
    patch(key, { status: "uploading" });
    xhr.send(file);
  });
}

/* ------------------------------------------------------- desktop drag-in */

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
};

/** Files from a desktop drop, walking dropped folders (relPath keeps the folder structure). */
export async function entriesFromDrop(dt: DataTransfer): Promise<UploadEntry[]> {
  const roots = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  if (!roots.length || roots.some((r) => r == null)) return [...dt.files].map((file) => ({ file }));

  const out: UploadEntry[] = [];
  const walk = async (entry: FsEntry, prefix: string): Promise<void> => {
    if (out.length > 5000) return;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
      out.push({ file, relPath: prefix ? `${prefix}/${file.name}` : undefined });
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path);
      }
    }
  };
  for (const r of roots) await walk(r!, "");
  return out;
}

/** Files from an <input webkitdirectory> pick. */
export const entriesFromInput = (files: FileList): UploadEntry[] =>
  [...files].map((file) => ({ file, relPath: file.webkitRelativePath || undefined }));
