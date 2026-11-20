/**
 * Knowledge base ingestion. Port of app/ingest.py, made incremental.
 *
 * Everything under `frameworks/` becomes one searchable corpus. Staff add or
 * remove a file and the index catches up on its own - no code change, no
 * schema migration.
 *
 * Indexing is incremental: the manifest records each file's size, modified
 * time and content hash, and a sync only extracts and embeds files that are
 * new or changed. Removing a file just drops its passages - no embedding at
 * all. A full re-embed happens only when forced (Rebuild index) or when the
 * embedding model or chunking settings change.
 *
 * All changes go through one queue, so two syncs never run at once; requests
 * that arrive while one is running are merged into a single follow-up sync
 * that sees the final state of the folder. The live index and its status are
 * kept on globalThis because Next.js gives each API route its own copy of
 * this module - module-level state would let one route keep serving a stale
 * index after another route changed it.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { settings } from "./config";
import { SUPPORTED, extract, wordCount } from "./extract";
import { chunkDocument, type Chunk } from "./chunking";
import { VectorStore, writeFileAtomic } from "./store";
import { getEmbedder, type Embedder } from "./embeddings";
import { SCREEN_VERSION, blocking, describe, scanText } from "./sensitive";

const INDEX_NAME = "framework";
const MANIFEST = path.join(settings.indexDir, "framework.manifest.json");
// Bump when extraction or chunking logic changes, so cached passages are rebuilt.
const INDEX_FORMAT = 2;
// File-system errors that may clear up by themselves (locked, briefly missing).
const TRANSIENT_IO = new Set(["ENOENT", "EBUSY", "EPERM", "EACCES", "EMFILE"]);

interface FileEntry {
  size: number;
  mtime_ms: number;
  hash: string;
  chunks: number;
  words: number;
  error: string | null;
  /** The error may clear up without the file changing, so the next sync retries it. */
  retry?: boolean;
  extract_ms?: number;
  embed_ms?: number;
  /** Version of the sensitive-data screening the file passed; older entries are screened again. */
  screen?: number;
}

interface Manifest {
  format?: number;
  signature?: string;
  built_at?: string | null;
  files?: Record<string, FileEntry>;
}

interface Status {
  state: "not_built" | "building" | "ready" | "empty" | "error";
  documents: number;
  chunks: number;
  built_at: string | null;
  errors: string[];
  files?: { path: string; chunks: number; words: number }[];
  progress?: { done: number; total: number; current: string | null };
  message?: string;
}

interface SharedIndex {
  store: VectorStore | null;
  /** Bumped every time `store` is replaced - a cache key for derived data. */
  generation: number;
  loading: Promise<void> | null;
  signature: string | null;
  status: Status;
  running: Promise<Status> | null;
  rerunRequested: boolean;
  forceRequested: boolean;
}

// Versioned key: a dev-server hot reload keeps globalThis, so state created by
// an older shape of this module must not be picked up by newer code.
const g = globalThis as unknown as { __compassKnowledgeBaseV2?: SharedIndex };
const shared: SharedIndex = (g.__compassKnowledgeBaseV2 ??= {
  store: null,
  generation: 0,
  loading: null,
  signature: null,
  status: { state: "not_built", documents: 0, chunks: 0, built_at: null, errors: [] },
  running: null,
  rerunRequested: false,
  forceRequested: false,
});
if (shared.status.state === "not_built" && !shared.running) shared.status = statusFromManifest(loadManifest());

// --------------------------------------------------------------------------
// Files and manifest
// --------------------------------------------------------------------------
/** Files the index skips: the folder's own README and Office lock files. */
export function isIndexableName(name: string): boolean {
  const base = path.basename(name);
  return SUPPORTED.has(path.extname(base).toLowerCase()) && !base.startsWith("~$") && base.toLowerCase() !== "readme.md";
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // removed while we were listing it
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function iterFiles(): string[] {
  if (!fs.existsSync(settings.frameworksDir)) return [];
  const all: string[] = [];
  walk(settings.frameworksDir, all);
  return all.filter(isIndexableName).sort();
}

function relPath(filePath: string): string {
  return path.relative(settings.frameworksDir, filePath);
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function hashFile(filePath: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function loadManifest(): Manifest {
  try {
    if (fs.existsSync(MANIFEST)) return JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
  } catch {
    /* corrupt or missing - treat as no manifest */
  }
  return {};
}

function saveManifest(manifest: Manifest): void {
  writeFileAtomic(MANIFEST, JSON.stringify(manifest, null, 2));
}

/** The manifest describes a usable index only if it was built with the current format and embedder. */
function manifestCurrent(manifest: Manifest): boolean {
  return manifest.format === INDEX_FORMAT && (!shared.signature || manifest.signature === shared.signature);
}

function statusFromManifest(manifest: Manifest): Status {
  if (!manifestCurrent(manifest)) {
    return { state: "not_built", documents: 0, chunks: 0, built_at: null, errors: [] };
  }
  const entries = Object.entries(manifest.files ?? {});
  const indexed = entries.filter(([, e]) => !e.error && e.chunks > 0);
  const chunks = indexed.reduce((n, [, e]) => n + e.chunks, 0);
  return {
    state: chunks ? "ready" : "empty",
    documents: indexed.length,
    chunks,
    built_at: manifest.built_at ?? null,
    errors: entries.filter(([, e]) => e.error).map(([p, e]) => `${p}: ${e.error}`),
    files: indexed.map(([p, e]) => ({ path: p, chunks: e.chunks, words: e.words })),
  };
}

/** Cache key for embeddings: change the model or chunking and every file is re-embedded. */
function indexSignature(embedder: Embedder): string {
  const model =
    embedder.name === "local" ? settings.localEmbeddingModel : embedder.name === "nvidia" ? settings.nvidiaEmbeddingModel : "hash";
  return `${embedder.name}:${model}:${embedder.dim}:${settings.chunkTargetTokens}:${settings.chunkOverlapTokens}`;
}

async function currentSignature(): Promise<string> {
  shared.signature = indexSignature(await getEmbedder());
  return shared.signature;
}

/** Cheap check (no hashing): does the folder or embedder differ from what the manifest says was indexed? */
function isStale(files: string[], manifest: Manifest): boolean {
  if (!manifestCurrent(manifest)) return files.length > 0;
  const known = manifest.files ?? {};
  if (files.length !== Object.keys(known).length) return true;
  const indexedChunks = Object.values(known).reduce((n, e) => n + (e.error ? 0 : e.chunks), 0);
  if (indexedChunks > 0 && shared.store && !shared.store.length) return true; // index files lost
  return files.some((f) => {
    const entry = known[relPath(f)];
    const stat = statOrNull(f);
    if (!entry || !stat || entry.size !== stat.size || entry.mtime_ms !== Math.floor(stat.mtimeMs)) return true;
    return !!entry.hash && entry.screen !== SCREEN_VERSION;
  });
}

function adopt(store: VectorStore): void {
  shared.store = store;
  shared.generation += 1;
}

// --------------------------------------------------------------------------
// Sync
// --------------------------------------------------------------------------
/**
 * The index from disk, loaded once and shared by every route. A load that
 * finishes after a sync has already put a newer index in place is discarded,
 * and an index the store rejects (other embedder, damaged files) is never
 * served - the caller gets an empty store and the next sync rebuilds.
 */
async function loadedStore(): Promise<VectorStore> {
  if (shared.store) return shared.store;
  shared.loading ??= (async () => {
    const candidate = new VectorStore(INDEX_NAME);
    if ((await candidate.load()) && !shared.store) adopt(candidate);
  })().finally(() => {
    shared.loading = null;
  });
  await shared.loading;
  return shared.store ?? new VectorStore(INDEX_NAME);
}

function errorCode(exc: unknown): string | undefined {
  return (exc as NodeJS.ErrnoException)?.code;
}

async function syncOnce(force: boolean): Promise<Status> {
  const embedder = await getEmbedder();
  const signature = await currentSignature();
  const manifest = loadManifest();
  const reuseAllowed = !force && manifest.format === INDEX_FORMAT && manifest.signature === signature;
  const previous = reuseAllowed ? manifest.files ?? {} : {};

  const current = await loadedStore();
  const existing = new Map<string, { chunks: Chunk[]; vectors: Float32Array[] }>();
  if (current.vectors.length === current.chunks.length) {
    current.chunks.forEach((c, i) => {
      const p = (c.meta?.path as string) ?? c.source;
      if (!existing.has(p)) existing.set(p, { chunks: [], vectors: [] });
      existing.get(p)!.chunks.push(c);
      existing.get(p)!.vectors.push(current.vectors[i]);
    });
  }

  const files = iterFiles();
  const progress = { done: 0, total: files.length, current: null as string | null };
  shared.status = { ...shared.status, state: "building", progress };

  const nextChunks: Chunk[] = [];
  const nextVectors: Float32Array[] = [];
  const nextFiles: Record<string, FileEntry> = {};
  let changed = !reuseAllowed || Object.keys(previous).length !== files.length;

  for (const filePath of files) {
    const rel = relPath(filePath);
    progress.current = rel;
    const stat = statOrNull(filePath);
    if (!stat) {
      changed = true; // removed since we listed the folder - the follow-up sync settles it
      continue;
    }
    const size = stat.size;
    const mtime = Math.floor(stat.mtimeMs);
    const prev = previous[rel];
    const sameStat = !!prev && prev.size === size && prev.mtime_ms === mtime;
    const cached = existing.get(rel);

    const hash = sameStat && prev.hash ? prev.hash : hashFile(filePath);
    if (!hash) {
      // Listed but unreadable (locked, no permission). Record it so the folder
      // counts as in sync and the UI shows the problem; retried when it changes.
      if (sameStat && prev.error) {
        nextFiles[rel] = prev;
      } else {
        changed = true;
        nextFiles[rel] = { size, mtime_ms: mtime, hash: "", chunks: 0, words: 0, error: "could not read the file", retry: true };
      }
      progress.done += 1;
      continue;
    }

    const reusable =
      !!prev &&
      prev.hash === hash &&
      !prev.retry &&
      prev.screen === SCREEN_VERSION &&
      (prev.error ? true : cached?.chunks.length === prev.chunks);
    if (reusable) {
      if (cached && !prev.error) {
        nextChunks.push(...cached.chunks);
        nextVectors.push(...cached.vectors);
      }
      if (!sameStat) changed = true;
      nextFiles[rel] = { ...prev, size, mtime_ms: mtime };
      progress.done += 1;
      continue;
    }

    changed = true;
    const entry: FileEntry = { size, mtime_ms: mtime, hash, chunks: 0, words: 0, error: null, screen: SCREEN_VERSION };
    let docChunks: Chunk[] = [];
    try {
      const t0 = Date.now();
      const doc = await extract(filePath);
      entry.extract_ms = Date.now() - t0;
      const after = statOrNull(filePath);
      if (!after || after.size !== size || Math.floor(after.mtimeMs) !== mtime) {
        continue; // replaced or removed while being read - the follow-up sync handles the new version
      }
      const blocked = blocking(scanText(doc.text));
      if (!doc.text.trim()) {
        entry.error = "no extractable text";
      } else if (blocked.length) {
        // Files copied straight into the folder skip the upload check; never index them.
        entry.error = `not indexed - appears to contain ${describe(blocked)}`;
      } else {
        doc.source = rel;
        docChunks = chunkDocument(doc, { docId: rel });
        for (const c of docChunks) c.meta = { kind: "framework", path: rel, folder: path.dirname(rel) };
        entry.words = wordCount(doc);
      }
    } catch (exc) {
      if (!statOrNull(filePath)) continue; // deleted mid-extraction
      entry.error = String((exc as Error).message ?? exc);
      entry.retry = TRANSIENT_IO.has(errorCode(exc) ?? "");
    }
    if (docChunks.length) {
      try {
        const t1 = Date.now();
        const vectors = await embedder.embedPassages(docChunks.map((c) => c.text));
        entry.embed_ms = Date.now() - t1;
        nextChunks.push(...docChunks);
        nextVectors.push(...vectors);
        entry.chunks = docChunks.length;
      } catch (exc) {
        entry.error = `embedding failed: ${String((exc as Error).message ?? exc)}`;
        entry.retry = true;
      }
    }
    nextFiles[rel] = entry;
    progress.done += 1;
  }

  if (!changed && shared.store && shared.store.length === nextChunks.length) {
    shared.status = statusFromManifest(manifest);
    return shared.status;
  }

  const next = new VectorStore(INDEX_NAME);
  next.setEntries(nextChunks, nextVectors);
  await next.save();
  const updated: Manifest = {
    format: INDEX_FORMAT,
    signature,
    built_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    files: nextFiles,
  };
  saveManifest(updated);
  adopt(next);
  shared.status = statusFromManifest(updated);
  return shared.status;
}

function startSyncLoop(): Promise<Status> {
  shared.status = { ...shared.status, state: "building" };
  const run = (async () => {
    let result: Status;
    do {
      shared.rerunRequested = false;
      const force = shared.forceRequested;
      shared.forceRequested = false;
      try {
        result = await syncOnce(force);
      } catch (exc) {
        console.error("[knowledge base] sync failed:", exc);
        result = { ...statusFromManifest(loadManifest()), state: "error", message: String((exc as Error).message ?? exc) };
        shared.status = result;
      }
    } while (shared.rerunRequested);
    return result;
  })();
  shared.running = run;
  run.finally(() => {
    if (shared.running === run) shared.running = null;
    if (shared.rerunRequested && !shared.running) void startSyncLoop();
  });
  return run;
}

/**
 * Bring the index in line with the folder. Returns once a sync that started
 * after this call has finished. `force` re-embeds every file.
 */
export function requestSync(opts: { force?: boolean } = {}): Promise<Status> {
  if (opts.force) shared.forceRequested = true;
  if (shared.running) {
    shared.rerunRequested = true;
    return shared.running;
  }
  return startSyncLoop();
}

/** Start a sync without waiting for it (upload, delete, rebuild). */
export function scheduleSync(opts: { force?: boolean } = {}): void {
  requestSync(opts).catch((exc) => console.error("[knowledge base] sync failed:", exc));
}

// --------------------------------------------------------------------------
// Read side
// --------------------------------------------------------------------------
/**
 * The current index for searching. Never waits for a sync when a usable
 * index already exists - queries keep working against it while new
 * documents are being embedded.
 */
export async function getStore(): Promise<VectorStore> {
  await currentSignature();
  const store = await loadedStore();
  let syncing = shared.running;
  if (!syncing && shared.status.state !== "error" && isStale(iterFiles(), loadManifest())) syncing = requestSync();
  // Only wait when there is nothing usable yet (first build, or the index was rejected).
  if (syncing && !store.length) await syncing.catch(() => undefined);
  return shared.store ?? store;
}

/** Changes whenever the searchable index is replaced - use it to key caches of search results. */
export function indexGeneration(): number {
  return shared.generation;
}

export function statusReport() {
  const files = iterFiles();
  const stale = !shared.running && isStale(files, loadManifest());
  return {
    ...shared.status,
    files_on_disk: files.length,
    stale,
    frameworks_dir: settings.frameworksDir,
  };
}

export function listDocuments() {
  const manifest = loadManifest();
  const known = manifestCurrent(manifest) ? manifest.files ?? {} : {};
  return iterFiles().flatMap((filePath) => {
    const stat = statOrNull(filePath);
    if (!stat) return [];
    const rel = relPath(filePath);
    const entry = known[rel];
    const current = !!entry && entry.size === stat.size && entry.mtime_ms === Math.floor(stat.mtimeMs);
    return [
      {
        path: rel,
        size_kb: Math.round((stat.size / 1024) * 10) / 10,
        modified: new Date(stat.mtimeMs).toISOString().replace("T", " ").slice(0, 16),
        index_state: !current ? "pending" : entry.error ? "error" : "indexed",
        chunks: current ? entry.chunks : 0,
        error: current ? entry.error : null,
      },
    ];
  });
}
