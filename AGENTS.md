# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this before
editing. The `README.md` is the *user* doc; this is the *maintainer* doc.

## What this is

`f` is a token-efficient CLI for LLMs. The npm package is **`@fcli.dev/f`**;
the installed command is **`f`**. Core is a small zero-runtime-dependency
TypeScript bundle. Functionality units are **ucks** — separate modules loaded
from a store at runtime. Core stays minimal; everything else is a uck.

- **Language:** TypeScript, ESM (`"type": "module"`), Node >= 20.
- **Build:** `tsup src/index.ts --format esm --out-dir dist` (single bundle at
  `dist/index.js`). `npm run build` / `npm run prepare` run it.
- **Check:** `npm run typecheck` (tsc --noEmit), `npm run test` (vitest —
  currently no tests). `npm run dev` runs from source via tsx.

## The golden rule: core stays minimal

Do **not** add runtime dependencies to core. Core's only runtime imports are
`node:` builtins. If a feature needs a third-party lib (e.g. `jsonpath-plus`
for the `config` uck), the dependency lives **in the uck's own
`package.json`**, never in this repo's `package.json`. Core's
`package.json` `dependencies` should stay empty (devDependencies are fine).

If you're tempted to add a dep or a big file to `src/`, stop: it probably
belongs in a uck in the `fcli-ucks` repo, not here.

## Layout

```
src/index.ts      # entry: import { run } from "./cli.js"; run(process.argv.slice(2))
src/cli.ts        # run(): seed config, populate store, load ucks, dispatch
src/types.ts      # Uck, UckContext, UckModule, UckSource, FConfig (the contracts)
src/config.ts     # DEFAULTS_REPO, global/project f.config.json read+merge
src/store.ts      # ~/.f/ucks/<bucket>/<name>/ install + shadowing
src/registry.ts   # load uck modules (store + node_modules), call register()
src/help.ts       # f help output
src/update.ts     # f up: force re-fetch all sources
```

`dist/` is generated (gitignored, `files: ["dist"]` for npm). Never edit
`dist/` by hand — change `src/` and rebuild.

## The uck contract (src/types.ts)

A uck module (`<dir>/index.js`) exports:

```js
export function register(ctx) {
  // ctx: { fVersion, ucks: [{name, desc}], self }
  return {                       // or an array of these
    name: "myuck",               // required; the `f myuck` command
    desc: "terse description",   // shown in f help
    run: (argv, args) => { ... },// args._ = remaining CLI args
    // argv?: (argv) => args     // optional custom arg parser
  };
}
export default { register };
```

`register()` runs once at load; `run()` runs per invocation. A uck may return
one object or an array. Invalid ucks (missing `name`/`run`) are skipped with a
console error, not fatal.

## Key invariants — don't break these

1. **Nested store, provenance by construction.** The store is
   `~/.f/ucks/<bucket>/<name>/index.js`. `<bucket>` is the *source* name: the
   repo basename for git, path basename for local, or an explicit `name` on the
   source object. The path tells you where each uck came from. `sourceBucket()`
   in `store.ts` is the single source of truth for this.

2. **Shadowing: later source wins.** `resolvedUcks()` applies shadowing — if
   two buckets define the same uck name, the later one (project config after
   global) loads. Both stay in the store; only the later registers.

3. **Core never depends on ucks.** Core loads ucks from the store /
   node_modules; it does not import any uck. Ucks may import each other and
   use the full Node runtime (no sandbox).

4. **`getFVersion()` matches on `bin.f`, not the package name** (see cli.ts).
   If you rename the package again, the version detection still works — keep
   it name-agnostic.

5. **Config keys.** `f.config.json` uses the `ucks` array. `readConfigFile`
   also accepts legacy `extensions` for back-compat — keep that tolerant.

## Sources (f.config.json `ucks` array)

Each entry is either a bare string or an object:
- **string** — git URL, `github:user/repo`, npm package name, or local path
  (`./`, `../`, or absolute).
- **object** — `{ source, ref?, name?, only?, except? }`. `only`/`except`
  are subset filters for multi-uck repos (`only` wins if both given); `name`
  pins the bucket.

Classification (`sourceKind` in registry.ts): local path → `local`,
`git+`/`https`/`ssh`/`github:`/`git@` → `git`, else `npm`.

**Populate-on-first-run:** a normal `f <uck>` run installs *git* sources only
when the store is empty; local sources always install; npm sources load from
node_modules. `f up` force-refetches everything.

## Repo topology (where things live)

- **this repo** (`@fcli.dev/f`) — the core, published to npm.
- **`fcli-ucks`** (github.com/kensand/fcli-ucks) — the *default* ucks (v, w,
  ls, config, creds, uck). `DEFAULTS_REPO` in `src/config.ts` points here and
  is seeded into the global config on first install.
- **`kensand-fcli-ucks`** (forgejo.kensand.net/kensand.net/kensand-fcli-ucks)
  — *personal* ucks. Wired as both a config source (pull) and a `uck` push
  target in the operator's `~/.f`.

Default ucks are **not** in this repo. To change a default uck, edit it in
`fcli-ucks`, not here.

## Publishing

- Publishes to npm via **GitHub Actions trusted publishing (OIDC)** on a `v*`
  tag — see `.github/workflows/publish.yml`. No `NPM_TOKEN`; auth is the GHA
  OIDC token against a trusted publisher registered on npm for
  owner `kensand` / repo `fcli` / environment `npm`.
- **The tag must equal `package.json` `version`** — the workflow enforces this
  and fails otherwise. To release: bump `version`, commit, `git tag v<ver>`,
  push the tag.
- `publishConfig.access: public` is required for a scoped package to publish
  publicly.

## Conventions

- Keep output terse (the whole point). No color, no "Done!", no boilerplate.
- Short uck names (`f v` not `f version`).
- Errors: `f: <message>` on stderr, exit 1.
- Don't add a test file unless asked (there are none yet); `npm run test` is
  the vitest entrypoint if you do.
- Commit messages: short imperative subject + optional body, like the existing
  history.

## Quick loop

```
npm run build      # rebuild dist/
npm run typecheck  # tsc --noEmit
npm run dev -- v   # run from source: prints version
```
