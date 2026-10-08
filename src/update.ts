import { allSources } from "./config.js";
import { installSource } from "./store.js";

/**
 * `f up` — full update. Re-download every configured source into the store,
 * forcing overwrite so ucks pick up upstream changes. Local sources are
 * re-copied (force). Network failures are reported per-source, never fatal.
 */
export async function updateAll(): Promise<void> {
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
