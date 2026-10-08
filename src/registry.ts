import { existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Uck, UckContext, UckModule, UckSource } from "./types.js";
import { resolvedUcks } from "./store.js";

const require = createRequire(import.meta.url);

/** Normalize a UckSource to a specifier string. */
export function normalizeSource(src: UckSource): { label: string; specifier: string } {
  if (typeof src === "string") {
    return { label: src, specifier: src };
  }
  const ref = src.ref ? `#${src.ref}` : "";
  return { label: `${src.source}${ref}`, specifier: `${src.source}${ref}` };
}

/** Classify a specifier: local path, git, or npm. */
export function sourceKind(specifier: string): "local" | "git" | "npm" {
  if (isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../")) return "local";
  if (/^(git\+)?(https?|ssh):\/\//.test(specifier) || specifier.startsWith("github:") || specifier.startsWith("git@")) return "git";
  return "npm";
}

/** Resolve a uck entry (a file URL string) to a dynamic-import URL. */
function toImportUrl(entry: string): string {
  if (entry.startsWith("file://")) return entry;
  const abs = isAbsolute(entry) ? entry : resolve(entry);
  return pathToFileURL(abs).href;
}

/** Load every uck in the store, in stable load order. Later buckets shadow earlier ones. */
export async function loadStoreUcks(fVersion: string): Promise<Uck[]> {
  const ucks = resolvedUcks();
  const results: Uck[] = [];

  for (const name of Object.keys(ucks).sort()) {
    const dir = ucks[name].dir;
    const indexPath = join(dir, "index.js");
    if (!existsSync(indexPath)) continue;

    const results2 = await loadUckModule(indexPath, name, fVersion);
    results.push(...results2);
  }

  return results;
}

/** Load a single uck module (index.js) and run its register(). */
async function loadUckModule(
  indexPath: string,
  self: string,
  fVersion: string
): Promise<Uck[]> {
  let mod: UckModule;
  try {
    const imported = await import(toImportUrl(indexPath));
    mod = imported.default ?? imported;
  } catch (e) {
    console.error(`f: uck '${self}': ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    return [];
  }

  if (typeof mod.register !== "function") {
    console.error(`f: uck '${self}': index.js must export register(ctx)`);
    return [];
  }

  const ctx: UckContext = { fVersion, self };
  let newUcks: Uck[] | Uck;
  try {
    newUcks = mod.register(ctx);
  } catch (e) {
    console.error(`f: uck '${self}': register() threw ${e instanceof Error ? e.message : e}`);
    return [];
  }

  if (!Array.isArray(newUcks)) newUcks = [newUcks];

  const out: Uck[] = [];
  for (const u of newUcks) {
    if (!u.name || typeof u.run !== "function") continue;
    out.push(u);
  }
  return out;
}

/**
 * Load ucks from an npm/git source that is already installed in node_modules
 * (not in the store). Used for sources that resolve via the package system.
 */
async function loadFromNodeModules(specifier: string, fVersion: string): Promise<Uck[]> {
  let resolved: string;
  try {
    resolved = require.resolve(specifier);
  } catch {
    console.error(`f: ${specifier}: not in node_modules (run npm i ${specifier})`);
    return [];
  }
  const name = specifier.includes("/") ? specifier.split("/").pop()! : specifier;
  return loadUckModule(resolved, name, fVersion);
}

export { loadFromNodeModules };
