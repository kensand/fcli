import { createInterface } from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allSources } from "./config.js";
import {
  installSource,
  installedRepos,
  sourceBucket,
} from "./store.js";
import type { UckSource } from "./types.js";

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
 *
 * Overwrite protection: a force update runs `git reset --hard` on every git
 * bucket, which discards uncommitted and unpushed local work. f up therefore
 * checks before touching anything:
 *   - a git bucket with local changes is SKIPPED (untouched) and named;
 *   - with --force the user is asked once, up front, naming every dirty
 *     bucket, and the run aborts on a "no" (or on non-interactive stdin).
 */
export async function updateAll(opts: { force?: boolean } = {}): Promise<void> {
  // 1. Update the core CLI first (so any uck code that depends on newer core
  //    gets it before the store is refreshed).
  await updateCore();

  // 2. Refresh ucks from their sources.
  const sources = allSources();

  if (sources.length === 0) {
    console.error("f: no uck sources in any f.config.json");
    return;
  }

  const dirty = dirtyBuckets(sources);

  if (dirty.length > 0) {
    for (const d of dirty) {
      console.error(
        `f up: ${d.bucket} has local changes (${d.detail}) — ${
          opts.force ? "will be discarded" : "skipped (use --force to discard)"
        }`,
      );
    }
    if (!opts.force) {
      // Leave the dirty buckets untouched; update the rest as normal.
      const dirtySet = new Set(dirty.map((d) => d.bucket));
      const rest = sources.filter((src) => !dirtySet.has(sourceBucket(src)));
      await runSources(rest);
      return;
    }
    if (!await confirm(`f up: discard local changes in ${dirty.length} bucket(s)? [y/N] `)) {
      console.error("f up: aborted — nothing updated");
      return;
    }
  }

  await runSources(sources);
}

async function runSources(sources: UckSource[]): Promise<void> {
  let ok = 0;
  let fail = 0;
  for (const src of sources) {
    const before = await installSource(src, true);
    if (before) ok++;
    else fail++;
  }

  console.error(`f: update complete — ${ok} ok, ${fail} failed\n`);
}

interface DirtyBucket {
  bucket: string;
  detail: string;
}

/**
 * Git-backed buckets whose local work a force update would discard.
 * Dirty = uncommitted changes (working tree, staged or untracked) or commits
 * ahead of the upstream. node_modules is ignored: it is untracked-by-design
 * and the refresh path's git clean keeps it.
 */
function dirtyBuckets(sources: UckSource[]): DirtyBucket[] {
  const wanted = new Set(sources.map((src) => sourceBucket(src)));
  const out: DirtyBucket[] = [];
  for (const repo of installedRepos()) {
    if (!wanted.has(repo.bucket)) continue;
    const git = (cmd: string): string => {
      try {
        return execSync(cmd, {
          cwd: repo.dir,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        return "";
      }
    };
    // Untracked files too (git clean -fdx would remove them): --untracked-files=all.
    const status = git("git status --porcelain --untracked-files=all -- . ':!node_modules'");
    const ahead = git("git log --oneline @{u}..HEAD 2>/dev/null");
    const nLocal = status ? status.trim().split("\n").length : 0;
    const nAhead = ahead ? ahead.trim().split("\n").length : 0;
    if (nLocal > 0 || nAhead > 0) {
      const parts = [
        nLocal > 0 ? `${nLocal} uncommitted change(s)` : null,
        nAhead > 0 ? `${nAhead} unpushed commit(s)` : null,
      ].filter(Boolean);
      out.push({ bucket: repo.bucket, detail: parts.join(", ") });
    }
  }
  return out;
}

/**
 * One yes/no on the terminal. Non-TTY (piped stdin) is a "no": an LLM or script
 * that runs `f up` gets an abort it can read, not a silent destructive update.
 * An LLM that really intends to discard the work re-runs with --force and
 * accepts the abort — it cannot type "y" to this prompt.
 */
async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("f up: non-interactive — pass --force only if the dirty buckets above may be discarded");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}
