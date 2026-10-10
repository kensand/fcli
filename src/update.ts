import { createInterface } from "node:readline/promises";
import { execSync } from "node:child_process";
import { allSources } from "./config.js";
import {
  installSource,
  installedRepos,
  sourceBucket,
} from "./store.js";
import type { UckSource } from "./types.js";

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
