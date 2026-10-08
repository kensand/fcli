import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreUcks, loadFromNodeModules } from "./registry.js";
import { ensureGlobalConfig, allSources } from "./config.js";
import { installSource, installedUcks } from "./store.js";
import { updateAll } from "./update.js";
import { help } from "./help.js";
import { type Uck } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

function getFVersion(): string {
  const candidates = [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      // f's own package is the one that exposes the `f` binary. Matching on
      // bin.f (rather than the name) keeps this correct across renames
      // (fcli -> @fcli.dev/f, etc.).
      const hasFbin =
        !!pkg.bin &&
        (typeof pkg.bin === "string" || Array.isArray(pkg.bin)
          ? pkg.bin.some((b: string) => b.includes("/f"))
          : "f" in (pkg.bin as Record<string, string>));
      if (hasFbin) return pkg.version;
    } catch {}
  }
  return "0.0.0";
}

export async function run(argv: string[]): Promise<void> {
  const fVersion = getFVersion();

  // First install: seed the global config with defaults (idempotent).
  ensureGlobalConfig();

  // Populate the store from configured sources. Normal runs only fetch when the
  // store is empty (first install); `f up` forces re-fetch. Local ucks always
  // install (cheap, no network).
  const storeEmpty = installedUcks().length === 0;
  for (const src of allSources()) {
    const specifier = typeof src === "string" ? src : src.source;
    const local = looksLocal(specifier);
    const git = specifierIsGit(specifier);
    if (local || (storeEmpty && git)) {
      await installSource(src, false);
    }
  }

  // Load ucks: from the store, then from any npm sources in node_modules.
  const ucks: Record<string, Uck> = {};
  const uckList: { name: string; desc: string }[] = [];

  for (const u of await loadStoreUcks(fVersion)) {
    ucks[u.name] = u;
    uckList.push({ name: u.name, desc: u.desc });
  }
  for (const src of allSources()) {
    const specifier = typeof src === "string" ? src : src.source;
    if (specifierIsGit(specifier) || looksLocal(specifier)) continue;
    for (const u of await loadFromNodeModules(specifier, fVersion, uckList)) {
      ucks[u.name] = u; // later (project) sources override store/builtins
    }
  }

  const [name, ...rest] = argv;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log(help(Object.values(ucks), fVersion));
    return;
  }

  if (name === "up") {
    await updateAll();
    return;
  }

  const uck: Uck | undefined = ucks[name];
  if (!uck) {
    console.error(`f: unknown uck '${name}'. Run 'f help' to list ucks.`);
    process.exit(1);
  }

  try {
    await uck.run(rest, uck.argv?.(rest) ?? { _: rest });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`f: ${msg}`);
    process.exit(1);
  }
}

function looksLocal(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../") || s.startsWith("/");
}
function specifierIsGit(s: string): boolean {
  return /^(git\+)?(https?|ssh):\/\//.test(s) || s.startsWith("github:") || s.startsWith("git@");
}
