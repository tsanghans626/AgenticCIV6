import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = resolve(__dirname, "..");

/** The two rulesets the knowledge base can be built from. */
export type DataSource = "vanilla" | "bbg";

export const DB_FILENAMES: Record<DataSource, string> = {
  vanilla: "civi6.sqlite",
  bbg: "civi6-bbg.sqlite",
};

/** Pinned BBG release used by `npm run fetch:bbg` and `npm run build:bbg`. */
export const DEFAULT_BBG_REF = "7.5.1";
export const BBG_REPO = "CivilizationVIBetterBalancedGame/BetterBalancedGame";
export const BBG_MODINFO = "BetterBalancedGame.modinfo";

export interface Civ6Paths {
  /** Root Assets directory of the Civ6.app bundle (game root on Windows). */
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
  source: "vanilla";
  paths: Civ6Paths;
  outputDir: string;
  dbFile: string;
  langs: string[];
}

/** Everything `buildBbg` needs; deliberately does not require the game install. */
export interface BbgConfig {
  source: "bbg";
  outputDir: string;
  dbFile: string;
  /** Vanilla database used as the overlay base. */
  baseDbFile: string;
  langs: string[];
  /** Directory containing BetterBalancedGame.modinfo and the sql/lang folders. */
  bbgDir: string;
  bbgRef: string;
}

export interface OutputConfig {
  source: DataSource;
  outputDir: string;
  dbFile: string;
  langs: string[];
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Locate the Civ6 Assets directory. Resolution order:
 *  1. CIV6_ASSETS (direct path to .../Civ6.app/Contents/Assets, or the game root on Windows)
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
    `未找到 Civ6 游戏数据。请设置环境变量 CIV6_ASSETS 指向 .../Civ6.app/Contents/Assets（Windows 指向游戏根目录，` +
      `该目录下应直接包含 Base\\ 与 DLC\\），或 CIV6_ROOT 指向游戏根目录。已尝试：\n${candidates.join("\n")}`,
  );
}

/** Output settings only — usable without the game data (e.g. `reindex`). */
export function loadOutputConfig(source: DataSource = "vanilla"): OutputConfig {
  const outputDir = resolve(WORKSPACE_ROOT, readEnv("CIV6_OUTPUT") ?? "data");
  const langs = (readEnv("CIV6_LANGS") ?? "en_US,zh_Hans_CN")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { source, outputDir, dbFile: join(outputDir, DB_FILENAMES[source]), langs };
}

export function loadConfig(): Config {
  const assets = resolveAssetsDir();
  const { outputDir, dbFile, langs } = loadOutputConfig("vanilla");

  return {
    source: "vanilla",
    paths: {
      assets,
      baseData: join(assets, "Base", "Assets", "Gameplay", "Data"),
      baseSchema: join(assets, "Base", "Assets", "Gameplay", "Data", "Schema"),
      baseText: join(assets, "Base", "Assets", "Text"),
      dlc: join(assets, "DLC"),
    },
    outputDir,
    dbFile,
    langs,
  };
}

/** Resolve the BBG ref from CIV6_BBG_REF, falling back to the pinned release. */
export function resolveBbgRef(): string {
  return readEnv("CIV6_BBG_REF") ?? DEFAULT_BBG_REF;
}

/**
 * Directory holding the BBG sources. CIV6_BBG_DIR (an installed mod folder)
 * wins; otherwise the fetched cache under data/bbg-src/<ref> is used.
 */
export function resolveBbgDir(ref: string = resolveBbgRef()): string {
  const direct = readEnv("CIV6_BBG_DIR");
  if (direct) {
    const dir = resolve(direct);
    if (!existsSync(join(dir, BBG_MODINFO))) {
      throw new Error(`CIV6_BBG_DIR 指向的目录里没有 ${BBG_MODINFO}：${dir}`);
    }
    return dir;
  }

  const cached = join(WORKSPACE_ROOT, "data", "bbg-src", ref);
  if (existsSync(join(cached, BBG_MODINFO))) return cached;

  throw new Error(
    `未找到 BBG 源码目录：${cached}\n` +
      `请先运行 npm run fetch:bbg，或设置 CIV6_BBG_DIR 指向已安装的 BBG Mod 目录（需包含 ${BBG_MODINFO}）。`,
  );
}

/** Configuration for the BBG overlay build (does not require CIV6_ASSETS). */
export function loadBbgConfig(): BbgConfig {
  const ref = resolveBbgRef();
  const bbg = loadOutputConfig("bbg");
  const vanilla = loadOutputConfig("vanilla");
  return {
    source: "bbg",
    outputDir: bbg.outputDir,
    dbFile: bbg.dbFile,
    baseDbFile: vanilla.dbFile,
    langs: bbg.langs,
    bbgDir: resolveBbgDir(ref),
    bbgRef: ref,
  };
}
