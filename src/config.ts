import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FConfig, UckSource } from "./types.js";

/** The defaults repo — seeded into the global config on first install. */
export const DEFAULTS_REPO =
  process.env.F_UCKS_REPO ?? "https://github.com/kensand/fcli-ucks.git";

export function fHome(): string {
  return join(process.env.HOME ?? "", ".f");
}

/** Global config path: ~/.f/f.config.json */
export function globalConfigPath(): string {
  return join(fHome(), "f.config.json");
}

/** Project config path: nearest f.config.json from cwd walking up */
export function projectConfigPath(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "f.config.json");
    if (existsSync(p)) return p;
    dir = join(dir, "..");
  }
  return null;
}

/** Read a config file, or null if absent/invalid. */
export function readConfigFile(path: string): FConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // Accept both new "ucks" and legacy "extensions" keys.
    const sources = raw.ucks ?? raw.extensions ?? [];
    if (!Array.isArray(sources)) return null;
    return { ucks: sources };
  } catch (e) {
    console.error(`f: invalid config at ${path}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * First install: if the global config doesn't exist, seed it with the defaults
 * repo as a source. Idempotent — never clobbers an existing config.
 */
export function ensureGlobalConfig(): void {
  const p = globalConfigPath();
  if (existsSync(p)) return;
  try {
    mkdirSync(fHome(), { recursive: true });
    const seed: FConfig = { ucks: [DEFAULTS_REPO] };
    writeFileSync(p, JSON.stringify(seed, null, 2) + "\n");
  } catch (e) {
    console.error(`f: could not seed ${p}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Combined sources: global config first (defaults baseline), then project. */
export function allSources(): UckSource[] {
  const out: UckSource[] = [];
  const g = readConfigFile(globalConfigPath());
  if (g) out.push(...g.ucks);
  const pc = projectConfigPath();
  if (pc) {
    const p = readConfigFile(pc);
    if (p) out.push(...p.ucks);
  }
  return out;
}
