/**
 * Framework library ingestion. Port of app/ingest.py.
 *
 * Everything under `frameworks/` becomes one searchable corpus. Staff add a
 * file and press Rebuild - no code change, no schema migration.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { settings } from "./config";
import { SUPPORTED, extract, wordCount } from "./extract";
import { chunkDocument } from "./chunking";
import { VectorStore } from "./store";

const INDEX_NAME = "framework";
const MANIFEST = path.join(settings.indexDir, "framework.manifest.json");

interface Status {
  state: string;
  documents: number;
  chunks: number;
  built_at: string | null;
  errors: string[];
  files?: { path: string; chunks: number; words: number }[];
}

let store: VectorStore | null = null;
let status: Status = { state: "not_built", documents: 0, chunks: 0, built_at: null, errors: [] };
let buildPromise: Promise<Status> | null = null;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function iterFiles(): string[] {
  if (!fs.existsSync(settings.frameworksDir)) return [];
  const all: string[] = [];
  walk(settings.frameworksDir, all);
  return all
    .filter((p) => SUPPORTED.has(path.extname(p).toLowerCase()))
    .filter((p) => !path.basename(p).startsWith("~$"))
    .filter((p) => path.basename(p).toLowerCase() !== "readme.md")
    .sort();
}

function fingerprint(files: string[]): string {
  const h = crypto.createHash("blake2b512");
  for (const f of files) {
    const stat = fs.statSync(f);
    const rel = path.relative(settings.frameworksDir, f);
    h.update(`${rel}:${stat.size}:${Math.floor(stat.mtimeMs / 1000)}`);
  }
  return h.digest("hex").slice(0, 32);
}

function saveManifest(payload: unknown): void {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(payload, null, 2), "utf-8");
}

function loadManifest(): Record<string, unknown> {
  try {
    if (fs.existsSync(MANIFEST)) return JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
  } catch {
    /* corrupt or missing - treat as no manifest */
  }
  return {};
}

/** Re-index the whole framework library from scratch. */
export async function rebuild(): Promise<Status> {
  const files = iterFiles();
  status = { state: "building", documents: 0, chunks: 0, built_at: null, errors: [] };

  const s = new VectorStore(INDEX_NAME);
  const allChunks: ReturnType<typeof chunkDocument> = [];
  const errors: string[] = [];
  const indexed: { path: string; chunks: number; words: number }[] = [];

  for (const filePath of files) {
    const rel = path.relative(settings.frameworksDir, filePath);
    try {
      const doc = await extract(filePath);
      if (!doc.text.trim()) {
        errors.push(`${rel}: no extractable text`);
        continue;
      }
      doc.source = rel;
      const chunks = chunkDocument(doc, { docId: rel });
      for (const c of chunks) c.meta = { kind: "framework", path: rel, folder: path.dirname(rel) };
      allChunks.push(...chunks);
      indexed.push({ path: rel, chunks: chunks.length, words: wordCount(doc) });
    } catch (exc) {
      errors.push(`${rel}: ${(exc as Error).message ?? exc}`);
    }
  }

  await s.build(allChunks);
  await s.save();
  store = s;

  status = {
    state: allChunks.length ? "ready" : "empty",
    documents: indexed.length,
    chunks: allChunks.length,
    built_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    errors,
    files: indexed,
  };
  saveManifest({ ...status, fingerprint: fingerprint(files) });
  return status;
}

/** Return the framework index, loading from disk or rebuilding if stale. */
export async function getStore(): Promise<VectorStore> {
  if (store) return store;
  if (buildPromise) {
    await buildPromise;
    return store!;
  }

  const candidate = new VectorStore(INDEX_NAME);
  const manifest = loadManifest();
  const files = iterFiles();
  const current = fingerprint(files);

  if ((await candidate.load()) && manifest.fingerprint === current && candidate.length) {
    store = candidate;
    status = { ...(manifest as unknown as Status), state: "ready" };
    return store;
  }

  buildPromise = rebuild();
  await buildPromise;
  buildPromise = null;
  return store!;
}

export function statusReport() {
  const files = iterFiles();
  const manifest = loadManifest();
  const stale = files.length > 0 && manifest.fingerprint !== fingerprint(files);
  return {
    ...status,
    files_on_disk: files.length,
    stale,
    frameworks_dir: settings.frameworksDir,
  };
}

export function listDocuments() {
  return iterFiles().map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      path: path.relative(settings.frameworksDir, filePath),
      size_kb: Math.round((stat.size / 1024) * 10) / 10,
      modified: new Date(stat.mtimeMs).toISOString().replace("T", " ").slice(0, 16),
    };
  });
}
