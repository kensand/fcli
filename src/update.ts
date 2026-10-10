import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allSources } from "./config.js";
import { installSource } from "./store.js";

const CORE_PKG = "@fcli.dev/f";
const here = dirname(fileURLToPath(import.meta.url));

/** Read f's own installed version from the nearest package.json exposing the
 *  `f` binary (walks up from dist/, matching getFVersion's logic in cli.ts). */
export function coreVersion(): string {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const bin = pkg.bin;
      const hasFbin =
        !!bin &&
        (typeof bin === "string"
          ? bin.includes("/f")
          : Array.isArray(bin)
            ? bin.some((b: string) => b.includes("/f"))
            : "f" in (bin as Record<string, string>));
      if (hasFbin && pkg.version) return pkg.version;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/** Query the registry for the published `latest` version. Best-effort: returns
 *  "" on any network/parse error so `f up` never fails because of a flaky check. */
async function latestVersion(): Promise<string> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://registry.npmjs.org/${CORE_PKG}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return "";
    const j = (await res.json()) as { "dist-tags"?: { latest?: string } };
    return j?.["dist-tags"]?.latest ?? "";
  } catch {
    return "";
  }
}

function cmp(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Update the core `f` CLI (the global npm package) if a newer version is
 * published. This is what `f up` previously never did — it only reinstalled
 * ucks. Best-effort: a failure to check or install is reported, never fatal,
 * and the uck update still runs.
 */
export async function updateCore(): Promise<void> {
  const cur = coreVersion();
  const latest = await latestVersion();
  if (!latest) {
    console.error("f up: core: couldn't check npm for updates (offline?)");
    return;
  }
  if (!cur) {
    // Can't determine installed version — don't reinstall blindly.
    console.error(`f up: core: installed version unknown (latest ${latest})`);
    return;
  }
  if (cmp(cur, latest) >= 0) return; // up to date or ahead (local dev)
  console.error(`f up: core ${cur} -> ${latest}`);
  try {
    execSync(`npm install -g ${CORE_PKG}@${latest}`, {
      stdio: "inherit",
      timeout: 180_000,
    });
    console.error(`f up: core updated to ${latest}. Run 'f v' to confirm.`);
  } catch {
    console.error(
      `f up: core update failed. Install manually: npm i -g ${CORE_PKG}@latest`,
    );
  }
}

/**
 * `f up` — full update. Re-download every configured source into the store,
 * forcing overwrite so ucks pick up upstream changes. Local sources are
 * re-copied (force). Network failures are reported per-source, never fatal.
 */
export async function updateAll(): Promise<void> {
  // 1. Update the core CLI first (so any uck code that depends on newer core
  //    gets it before the store is refreshed).
  await updateCore();

  // 2. Refresh ucks from their sources.
  const sources = allSources();

  if (sources.length === 0) {
    console.error("f: no uck sources in any f.config.json");
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const src of sources) {
    const before = await installSource(src, true);
    if (before) ok++;
    else fail++;
  }

  console.error(`f: update complete — ${ok} ok, ${fail} failed\n`);
}
