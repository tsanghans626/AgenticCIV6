import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BBG_MODINFO,
  BBG_REPO,
  WORKSPACE_ROOT,
  resolveBbgRef,
} from "../config.js";
import {
  parseBbgModInfoText,
  selectBbgData,
  selectBbgText,
  type BbgModInfo,
} from "./modinfo.js";

export interface FetchBbgOptions {
  ref?: string;
  /** Destination directory; defaults to data/bbg-src/<ref>. */
  dir?: string;
  langs: string[];
  force?: boolean;
}

export interface FetchBbgResult {
  dir: string;
  ref: string;
  modName: string;
  modVersion: string;
  files: number;
  downloaded: number;
  skipped: number;
}

interface FetchManifest {
  ref: string;
  modVersion: string;
  modName: string;
  fetchedAt: string;
  /** relative path -> byte size */
  files: Record<string, number>;
}

const MIRROR_LIMIT = 6;
const DOWNLOAD_ATTEMPTS = 5;

function mirrorUrls(ref: string, file: string): string[] {
  const encodedPath = file
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const encodedRef = encodeURIComponent(ref);
  return [
    `https://cdn.jsdelivr.net/gh/${BBG_REPO}@${encodedRef}/${encodedPath}`,
    `https://fastly.jsdelivr.net/gh/${BBG_REPO}@${encodedRef}/${encodedPath}`,
    `https://gcore.jsdelivr.net/gh/${BBG_REPO}@${encodedRef}/${encodedPath}`,
    `https://raw.githubusercontent.com/${BBG_REPO}/${encodedRef}/${encodedPath}`,
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function downloadText(ref: string, file: string): Promise<string> {
  const urls = mirrorUrls(ref, file);
  let lastError: unknown;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(30000),
          headers: { "user-agent": "civi6-kb-build" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const text = await res.text();
        if (!text) throw new Error("empty response");
        return text;
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < DOWNLOAD_ATTEMPTS - 1) await sleep(500 * (attempt + 1));
  }
  throw new Error(
    `下载失败：${file}\n尝试过：\n${urls.join("\n")}\n最后错误：${
      (lastError as Error)?.message ?? String(lastError)
    }`,
  );
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  const results = await Promise.allSettled(runners);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
}

function readManifest(file: string): FetchManifest | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as FetchManifest;
  } catch {
    return null;
  }
}

function manifestComplete(manifest: FetchManifest | null, dir: string, ref: string, files: string[]): boolean {
  if (!manifest || manifest.ref !== ref) return false;
  for (const file of files) {
    const full = join(dir, file);
    if (!existsSync(full)) return false;
    if (statSync(full).size !== manifest.files[file]) return false;
  }
  return true;
}

/**
 * Download the pinned BBG source files needed for the overlay build.
 * jsDelivr is tried first because this repository's environment can reach it
 * while direct raw.githubusercontent.com access is unreliable.
 */
export async function fetchBbgSources(opts: FetchBbgOptions): Promise<FetchBbgResult> {
  const ref = opts.ref ?? resolveBbgRef();
  const dir = resolve(opts.dir ?? join(WORKSPACE_ROOT, "data", "bbg-src", ref));
  const manifestFile = join(dir, "manifest.json");
  const modinfoFile = join(dir, BBG_MODINFO);

  let modinfoText: string | undefined;
  let modinfo: BbgModInfo | undefined;
  if (!opts.force && existsSync(modinfoFile)) {
    modinfoText = readFileSync(modinfoFile, "utf8");
    try {
      modinfo = parseBbgModInfoText(modinfoText);
    } catch {
      modinfo = undefined;
    }
  }
  if (!modinfo || !modinfoText) {
    modinfoText = await downloadText(ref, BBG_MODINFO);
    modinfo = parseBbgModInfoText(modinfoText);
  }

  const selection = selectBbgData(modinfo);
  const textFiles = selectBbgText(modinfo, opts.langs);
  const wanted = [...new Set([BBG_MODINFO, ...selection.files, ...textFiles.map((t) => t.path)])];

  const existing = readManifest(manifestFile);
  if (!opts.force && manifestComplete(existing, dir, ref, wanted)) {
    return {
      dir,
      ref,
      modName: modinfo.name,
      modVersion: modinfo.version,
      files: wanted.length,
      downloaded: 0,
      skipped: wanted.length,
    };
  }

  mkdirSync(dir, { recursive: true });
  writeAtomic(modinfoFile, modinfoText);

  const sizes: Record<string, number> = { [BBG_MODINFO]: Buffer.byteLength(modinfoText, "utf8") };
  const toDownload = wanted.filter((file) => file !== BBG_MODINFO);
  let downloaded = 0;
  let reused = 0;
  await mapLimit(toDownload, MIRROR_LIMIT, async (file) => {
    const full = join(dir, file);
    if (!opts.force && existsSync(full) && statSync(full).size > 0) {
      sizes[file] = statSync(full).size;
      reused++;
      return;
    }
    const text = await downloadText(ref, file);
    writeAtomic(full, text);
    sizes[file] = Buffer.byteLength(text, "utf8");
    downloaded++;
  });

  const manifest: FetchManifest = {
    ref,
    modVersion: modinfo.version,
    modName: modinfo.name,
    fetchedAt: new Date().toISOString(),
    files: sizes,
  };
  writeAtomic(manifestFile, JSON.stringify(manifest, null, 2));

  return {
    dir,
    ref,
    modName: modinfo.name,
    modVersion: modinfo.version,
    files: wanted.length,
    downloaded,
    skipped: reused,
  };
}
