import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = resolve(__dirname, "..");

export interface Civ6Paths {
  /** Root Assets directory of the Civ6.app bundle. */
  assets: string;
  /** Base gameplay data directory (XML). */
  baseData: string;
  /** Base gameplay schema directory (SQL). */
  baseSchema: string;
  /** Base text directory. */
  baseText: string;
  /** DLC root directory. */
  dlc: string;
}

export interface Config {
  paths: Civ6Paths;
  outputDir: string;
  dbFile: string;
  langs: string[];
  port: number;
  host: string;
  openaiApiKey: string | undefined;
  openaiEmbeddingModel: string;
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Locate the Civ6 Assets directory. Resolution order:
 *  1. CIV6_ASSETS (direct path to .../Civ6.app/Contents/Assets)
 *  2. CIV6_ROOT  (path to game root; append Civ6.app/Contents/Assets)
 *  3. macOS Steam default install path
 */
export function resolveAssetsDir(): string {
  const direct = readEnv("CIV6_ASSETS");
  if (direct) return direct;

  const root = readEnv("CIV6_ROOT");
  if (root) return join(root, "Civ6.app", "Contents", "Assets");

  const candidates = [
    join(
      homedir(),
      "Library",
      "Application Support",
      "Steam",
      "steamapps",
      "common",
      "Sid Meier's Civilization VI",
      "Civ6.app",
      "Contents",
      "Assets",
    ),
    join(
      homedir(),
      "Library",
      "Application Support",
      "Steam",
      "steamapps",
      "common",
      "Sid Meier's Civilization VI",
      "Assets",
    ),
  ];

  for (const c of candidates) {
    if (existsSync(join(c, "Base"))) return c;
  }
  throw new Error(
    `未找到 Civ6 游戏数据。请设置环境变量 CIV6_ASSETS 指向 .../Civ6.app/Contents/Assets，` +
      `或 CIV6_ROOT 指向游戏根目录。已尝试：\n${candidates.join("\n")}`,
  );
}

export function loadConfig(): Config {
  const assets = resolveAssetsDir();
  const outputDir = resolve(WORKSPACE_ROOT, readEnv("CIV6_OUTPUT") ?? "data");
  const langs = (readEnv("CIV6_LANGS") ?? "en_US,zh_Hans_CN")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    paths: {
      assets,
      baseData: join(assets, "Base", "Assets", "Gameplay", "Data"),
      baseSchema: join(assets, "Base", "Assets", "Gameplay", "Data", "Schema"),
      baseText: join(assets, "Base", "Assets", "Text"),
      dlc: join(assets, "DLC"),
    },
    outputDir,
    dbFile: join(outputDir, "civi6.sqlite"),
    langs,
    port: Number(readEnv("PORT") ?? 8787),
    host: readEnv("HOST") ?? "127.0.0.1",
    openaiApiKey: readEnv("OPENAI_API_KEY"),
    openaiEmbeddingModel: readEnv("OPENAI_EMBEDDING_MODEL") ?? "text-embedding-3-small",
  };
}
