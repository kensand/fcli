import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  cpSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { fHome } from "./config.js";
import { normalizeSource, sourceKind } from "./registry.js";
import type { UckSource } from "./types.js";

/** The all-ucks store: ~/.f/ucks/<bucket>/<name>/index.js (+ supporting files). */
export function storeDir(): string {
  return join(fHome(), "ucks");
}

/**
 * Canonical bucket (repo) name for a source. Object sources may carry an
 * explicit `name`; otherwise it's derived: git → URL basename sans .git, local
 * → path basename, npm → package basename. This is the first-level dir under
 * ~/.f/ucks/ — it gives the store provenance by construction.
 */
export function sourceBucket(src: UckSource): string {
  if (typeof src !== "string" && src.name && src.name.trim()) {
    return src.name.trim();
  }
  const { specifier } = normalizeSource(src);
  const bare = specifier.replace(/\s*#.*$/, ""); // strip #ref
  // git:
  if (bare.startsWith("github:")) {
    const parts = bare.slice("github:".length).split("/");
    return parts[1] ?? parts[0];
  }
  if (/^(git\+)?(https?|ssh):\/\//.test(bare) || bare.startsWith("git@")) {
    // last path segment, sans .git
    const tail = bare.split("/").pop() ?? bare;
    return tail.replace(/\.git$/, "") || "repo";
  }
  // local / npm
  return basename(bare.replace(/\/$/, "")) || "local";
}

/** A single installed uck: its resolved name, its dir, its source bucket, and load order. */
export interface StoredUck {
  name: string;
  dir: string;
  bucket: string;
  order: number;
}

/**
 * All installed ucks in the store, in deterministic load order.
 * Layout: ~/.f/ucks/<bucket>/<name>/index.js. Later buckets (higher order)
 * shadow earlier ones when two provide the same uck name — see loadStoreUcks.
 */
export function installedUcks(): StoredUck[] {
  const dir = storeDir();
  if (!existsSync(dir)) return [];
  const out: StoredUck[] = [];
  let order = 0;
  for (const bucket of readdirSync(dir).sort()) {
    const bucketDir = join(dir, bucket);
    if (!statSync(bucketDir).isDirectory()) continue;
    for (const name of readdirSync(bucketDir).sort()) {
      const full = join(bucketDir, name);
      if (statSync(full).isDirectory() && existsSync(join(full, "index.js"))) {
        out.push({ name, dir: full, bucket, order: order++ });
      }
    }
  }
  return out;
}

/**
 * Resolve the store to the set of ucks actually loaded: when the same uck name
 * appears in multiple buckets, the *later* bucket wins (later source shadows
 * earlier). Returns name -> StoredUck in final load order.
 */
export function resolvedUcks(): Record<string, StoredUck> {
  const list = installedUcks();
  const byName: Record<string, StoredUck> = {};
  for (const u of list) {
    byName[u.name] = u; // later (higher order) overwrites earlier
  }
  return byName;
}

/** Extract subset filters from a source (only/except). undefined = no filter. */
export function subsetFilters(src: UckSource): { only?: string[]; except?: string[] } {
  if (typeof src === "string") return {};
  const f: { only?: string[]; except?: string[] } = {};
  if (Array.isArray(src.only)) f.only = src.only;
  if (Array.isArray(src.except)) f.except = src.except;
  return f;
}

/** Does a uck name pass the source's filters? (only wins if both present) */
export function nameAllowed(name: string, f: { only?: string[]; except?: string[] }): boolean {
  if (f.only && f.only.length > 0) return f.only.includes(name);
  if (f.except && f.except.length > 0) return !f.except.includes(name);
  return true;
}

/**
 * Download a source into the store. Idempotent by default (skip if the uck dir
 * already exists) unless force=true (f up).
 *
 * - repo source (git/github/npm): fetch it, then install each <name>/ subdir
 *   (or flat *.js) found inside, subject to only/except filters.
 * - local single-uck source: copy the dir (or lone file) into the store as one.
 */
export async function installSource(src: UckSource, force = false): Promise<boolean> {
  const { specifier } = normalizeSource(src);
  const kind = sourceKind(specifier);
  const filters = subsetFilters(src);
  const bucket = sourceBucket(src);

  if (kind === "local") {
    return installLocal(specifier, force, bucket);
  }

  // Remote (git): fetch to a temp dir, then install each uck inside.
  const tmp = join(fHome(), ".tmp-" + Date.now().toString(36) + Math.random().toString(36).slice(2));
  try {
    mkdirSync(tmp, { recursive: true });
    fetchRemote(specifier, tmp);
    installFromFetched(tmp, force, filters, bucket);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`f: failed to install ${specifier} (${msg.split("\n")[0]})`);
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Install a local source into the store under <bucket>/.
 * - dir containing uck subdirs (each with an index.js) → a local "repo": each subdir is a uck.
 * - dir with index.js at its root → a single uck (the dir is the uck).
 * - lone .js/.mjs file → a single uck named after the file.
 * Returns true if it made progress.
 */
async function installLocal(specifier: string, force: boolean, bucket: string): Promise<boolean> {
  const abs = specifier.startsWith(".")
    ? new URL(specifier, "file://" + process.cwd() + "/").pathname
    : specifier;
  if (!existsSync(abs)) {
    console.error(`f: local uck not found: ${abs}`);
    return false;
  }

  if (statSync(abs).isFile()) {
    // Lone file: single uck named after the file (sans extension).
    const name = basename(abs).replace(/\.(js|mjs)$/, "");
    const dest = join(storeDir(), bucket, name);
    if (existsSync(dest) && !force) return false;
    if (force) rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    copyFileSync(abs, join(dest, "index.js"));
    console.error(`f: installed local uck ${bucket}/${name}`);
    return true;
  }

  // Directory: is it a repo of ucks (subdirs with index.js) or a single uck?
  const subUcks = readdirSync(abs).filter(
    (e) => statSync(join(abs, e)).isDirectory() && existsSync(join(abs, e, "index.js"))
  );
  if (subUcks.length > 0) {
    // Local repo: install each subdir as a uck under <bucket>/.
    let count = 0;
    for (const e of subUcks) {
      copyUckToStore(e, join(abs, e), force, bucket);
      count++;
    }
    console.error(`f: installed ${count} local uck(s) under ${bucket}/`);
    return count > 0;
  }

  // Single uck dir (index.js at root).
  const name = basename(abs.replace(/\/$/, ""));
  const dest = join(storeDir(), bucket, name);
  if (existsSync(dest) && !force) return false;
  if (force) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(abs, dest, { recursive: true });
  installUckDeps(dest);
  console.error(`f: installed local uck ${bucket}/${name}`);
  return true;
}

/** Fetch a remote source (git clone) into tmp. npm sources resolve from node_modules at load time, not here. */
function fetchRemote(specifier: string, tmp: string): void {
  const isGit =
    /^(git\+)?(https?|ssh):\/\//.test(specifier) ||
    specifier.startsWith("github:") ||
    specifier.startsWith("git@");

  if (!isGit) {
    throw new Error(`npm source ${specifier}: run 'npm i ${specifier}' first, or use a git source`);
  }

  const url = gitUrl(specifier);
  // Clone directly into tmp (git creates it). Contents are the repo root.
  try {
    execSync(`git clone --depth 1 ${url} ${tmp}`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (e) {
    throw new Error(`git clone failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}

/** Install uck dirs (or flat files) found in a fetched repo into the store, under <bucket>/. */
function installFromFetched(tmp: string, force: boolean, filters: { only?: string[]; except?: string[] } = {}, bucket: string = "local"): void {
  const entries = readdirSync(tmp);
  let count = 0;

  // Direct subdirs that contain index.js → each is a uck.
  for (const e of entries) {
    const full = join(tmp, e);
    if (statSync(full).isDirectory() && existsSync(join(full, "index.js"))) {
      if (!nameAllowed(e, filters)) continue;
      copyUckToStore(e, full, force, bucket);
      count++;
    }
  }

  // Flat *.js files at root (single-file ucks, or a repo of flat files).
  if (count === 0) {
    for (const e of entries) {
      if (e.endsWith(".js") || e.endsWith(".mjs")) {
        const name = e.replace(/\.(js|mjs)$/, "");
        if (!nameAllowed(name, filters)) continue;
        const dest = join(storeDir(), bucket, name);
        if (existsSync(dest) && !force) continue;
        if (force) rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
        copyFileSync(join(tmp, e), join(dest, "index.js"));
        count++;
      }
    }
  }

  if (count > 0) {
    console.error(`f: installed ${count} uck(s) from ${bucket}\n`);
  }
}

function copyUckToStore(name: string, srcDir: string, force: boolean, bucket: string): void {
  const bucketDir = join(storeDir(), bucket);
  const dest = join(bucketDir, name);
  if (existsSync(dest) && !force) return;
  if (force) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(srcDir, dest, { recursive: true });
  installUckDeps(dest);
}

/** If a uck dir has a package.json, npm i its deps in place. No-op otherwise. */
function installUckDeps(uckDir: string): void {
  const pkg = join(uckDir, "package.json");
  if (!existsSync(pkg)) return;
  try {
    execSync("npm i --no-fund --no-audit --loglevel=error", {
      cwd: uckDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`f: uck deps install failed in ${basename(uckDir)} (${msg.split("\n")[0]})`);
  }
}

/** Normalize a git-ish specifier into a clonable URL. */
function gitUrl(specifier: string): string {
  if (specifier.startsWith("github:")) {
    const parts = specifier.slice("github:".length).split("/");
    return `https://github.com/${parts.slice(0, 2).join("/")}.git`;
  }
  if (specifier.startsWith("git+")) return specifier.slice(4);
  return specifier;
}

