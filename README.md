# f

Token-efficient CLI for LLMs. Short ucks, minimal output, extensible via npm packages.

## Install

From npm:

```bash
npm install -g @fcli.dev/f
```

Or install from git (dev):

```bash
git clone https://github.com/kensand/fcli.git
cd fcli
npm i        # builds dist/ via the prepare hook
npm link     # puts the `f` command on your PATH (dev install)
```

Uninstall a dev install: `npm unlink -g f` (run from the clone) or `npm unlink f`.

A one-line `curl … | sh` bootstrap is coming.

## Usage

```
f <uck> [args]
```

### Default ucks

| Uck | Description |
|-----|-------------|
| `f v` | print version |
| `f w <bin>` | locate binary (alias for `which`) |
| `f ls [path]` | list files (terse) |
| `f config ...` | edit `f.config.json` via JSONPath |
| `f creds ...` | store credentials (encrypted, daemon+ttl) |
| `f uck ...` | push store ucks to a git repo |
| `f up` | full update: re-fetch all configured uck sources |
| `f help` | list all ucks |

`v`, `w`, and `ls` are **default ucks** — they ship in the [`fcli-ucks`](https://github.com/kensand/fcli-ucks) repo. On first install f seeds `~/.f/f.config.json` with that repo as a source, then downloads it into the store. Override the source with `F_UCKS_REPO`.

`up` and `help` are core builtins (special-cased in `cli.ts`): `help` is the no-arg behavior, `up` is a maintenance operation on f itself. `up` re-fetches every source in your config (global + project), overwriting the store so ucks pick up upstream changes.

**`f config`** edits `f.config.json` with JSONPath:

```bash
f config list                 # whole project config
f config -g get ucks          # global config, one path
f config add ucks ./my-uck    # append a source
f config set ucks[0] ./other  # replace by index
f config remove 'ucks[?(@.source=="./old")]'   # remove by filter
```

- Targets the **project** `f.config.json` by default; `-g` for the global `~/.f/f.config.json`.
- Values are JSON-parsed (numbers/bools/objects/arrays) or kept as raw strings.
- Other ucks can drive it programmatically: the uck exports `configApi`, whose methods take an explicit target (path, `"project"`, or `"global"`), so a uck can edit any config file.

**`f creds`** stores credentials encrypted at rest (`~/.f/f.creds.enc`, mode `0600`). The key is derived from a passkey you choose (scrypt KDF) and values are encrypted with AES-256-GCM.

```bash
f creds unlock [passkey] [--ttl sec]   # start daemon (default ttl 600s)
f creds set prod.db "postgres://u:p@h" # store
f creds get prod.db                     # print (decrypts)
f creds ls                              # list names
f creds rm prod.db                      # remove
f creds status                          # locked / unlocked + time left
f creds lock                            # stop daemon, zeroize key
```

- **Unlock** spawns a background daemon that derives the key once and holds it **in memory** — the passkey never touches disk and there is no key file. The daemon serves ops over a unix socket (`~/.f/.creds.sock`) and **auto-exits after the TTL** (default 10 min), zeroizing the key.
- **Wrong passkey** fails loudly: AES-GCM authentication rejects the data ("unable to authenticate data") rather than returning garbled plaintext.
- **Lock** (or TTL expiry) kills the daemon and removes the socket; the encrypted store on disk is untouched.
- Other ucks can drive it via the exported `credsApi` (`get`/`set`/`ls`/`unlock`/`lock`/`status`).

**`f uck`** pushes ucks from the store to a git repo. Because the store is nested (`~/.f/ucks/<bucket>/<name>/`), the **bucket name is the link**: a push target named `mine` mirrors everything under `~/.f/ucks/mine/`.

```bash
f uck repo add mine https://…/me/my-ucks.git [--ref main]  # register a push target
f uck repo ls                                            # list targets + their store ucks
f uck repo rm mine                                       # unregister
f uck push -r mine                                       # push every uck in bucket 'mine'
f uck push greet ls -r mine                              # push only these ucks
```

- **Push model (v1):** clone the target (shallow), overwrite the named uck dirs from the store, commit, `git push` (fast-forward only, never `--force`). `node_modules` is never pushed. **The store wins per uck** — the store's copy replaces the repo's.
- **Auth** is delegated to `git` (your ssh keys / credential helper).
- **Pull is not re-implemented:** to pull, add the repo as a source in `f.config.json` (give it a matching `name` so the bucket lines up) and run `f up`.
- Other ucks can drive it via the exported `uckApi` (`loadTargets`/`saveTargets`/`push`/`bucketUcks`).

## The store

Every uck f knows about lives in **`~/.f/ucks/<bucket>/<name>/index.js`** (plus any supporting files). `f` loads every `~/.f/ucks/*/*/index.js`.

- **`<bucket>`** is the source the uck came from — the repo basename (git), path basename (local), or an explicit `name` on the source. The store keeps provenance **by construction**: the path tells you where each uck came from.
- **First install** seeds `~/.f/f.config.json` with the defaults repo, then downloads each configured source into the store (only if not already present).
- **Normal runs** just load the store — instant, no network.
- **`f up`** forces re-download.
- **Shadowing:** if two sources provide the same uck name, the **later** source wins (project config is read after global, so a project uck overrides a same-named default). Both stay in the store; only the later one loads.

## Config

`f.config.json` lists uck sources. Two levels are merged:

- **Global** `~/.f/f.config.json` — the defaults baseline (seeded on first install).
- **Project** `f.config.json` (nearest from cwd) — adds more on top.

```json
{
  "ucks": [
    "https://github.com/kensand/fcli-ucks.git",
    "./my-local-uck",
    { "source": "github:user/repo", "ref": "main" }
  ]
}
```

A source can be a **repo** (git URL / `github:user/repo`) — it expands to every `<name>/` inside — or a **local path** to a single uck. npm package sources resolve from `node_modules` at load (run `npm i` first).

### Selecting a subset of a repo

A repo source can be filtered to install only some of its ucks:

```json
{
  "ucks": [
    { "source": "github:org/many-ucks", "only": ["creds", "ls"] },
    { "source": "github:org/many-ucks", "except": ["experimental"] }
  ]
}
```

- `only: [...]` — install just these uck names (whitelist).
- `except: [...]` — install everything except these (blacklist).
- If both are given, **`only` wins**.
- Sources are **independent**: each installs whatever its own filter allows. You can point two entries at the same repo with different subsets and get the union — or pin a curated set with `only`.

You can also add a filtered source from the CLI via `f config`:

```bash
f config add ucks '{"source":"github:org/many-ucks","only":["creds"]}'
```

## Ucks

A **uck** is a unit of f functionality. Builtins are ucks. Extensions register ucks. An uck is only a word when prefixed with `f-`.

## Adding a uck

A uck is a **directory** with an `index.js` (plus any supporting files). Put it in your store, or point a config source at it.

**As a local source** — create the dir, add it to `f.config.json`:

```
my-ucks/ls/
  index.js
```

```js
// my-ucks/ls/index.js
import { execSync } from "node:child_process";
export function register(_ctx) {
  return {
    name: "ls",
    desc: "list files (terse)",
    run: (_argv, args) => {
      const target = (args._ ?? ["."])[0];
      const out = execSync(`ls -1 ${target}`, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
      process.stdout.write(out);
    },
  };
}
export default { register };
```

```json
// f.config.json
{ "ucks": ["./my-ucks/ls"] }
```

f copies it into `~/.f/ucks/ls/` and it's available. Return an array from `register()` to add multiple ucks from one module.

**As a repo** — put uck dirs in a git repo (`v/index.js`, `w/index.js`, …) and add the repo URL to `f.config.json`. f downloads it and installs every uck dir inside.

## Extending f (as npm packages)

For ucks you want to version, publish, or depend on, wrap them in an **npm package**. Extensions are packages that export a `register(ctx)` function. Full Node.js runtime — no sandboxing. Extensions can import each other, call `child_process`, hit the network, modify core behavior, whatever.

### 1. Create an extension

```
my-f-ext/
  package.json
  index.js
```

**package.json:**
```json
{
  "name": "@myorg/f-my-ext",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.js"
}
```

**index.js:**
```js
export function register(ctx) {
  // ctx.fVersion  — f's version
  // ctx.ucks      — [{name, desc}] of all previously registered ucks
  // ctx.self      — this extension's source label

  return {
    name: "myuck",
    desc: "what it does (terse)",
    run: (argv, args) => {
      // args._ is the remaining CLI args
      console.log("hello", args._.join(" "));
    },
  };
}
// Can also return an array: [ {name: "a", ...}, {name: "b", ...} ]

export default { register };
```

### 2. Register it in `f.config.json`

```json
{
  "extensions": [
    "@myorg/f-my-ext",
    "./local-path/to/ext",
    { "source": "github:user/repo", "ref": "main" }
  ]
}
```

Source formats:
- **npm**: `"@scope/name"` — must be in `node_modules`
- **local**: `"./my-ext"` or `"/abs/path"` — dir with `package.json` or `index.js`
- **git**: `"github:user/repo"` or `"git+https://..."` — pre-install via `npm i`
- **object**: `{ "source": "...", "ref": "branch" }` — pin a git ref

### 3. Install & run

```bash
npm i @myorg/f-my-ext
f myuck hello
```

### Extension interop

Full Node.js runtime. Extensions can:
- Import each other: `import { helper } from "@other/f-ext"`
- Use `child_process`, `fs`, `http`, `net` — everything
- Inspect other ucks via `ctx.ucks`
- Modify or override core f behavior

No sandbox. No restrictions. Ucks are first-class.

## Design principles

1. **Short names** — `f v` not `f version`
2. **Terse output** — no boilerplate, no colors, no "Done!"
3. **npm-native** — extensions are packages, `npm i` to install
4. **Full runtime** — no sandbox, ucks can do anything
5. **Context injection** — ucks know what else is registered

## Development

```bash
npm install
npm run build
npm run dev
npm run typecheck
```

## License

AGPL-3.0. See [LICENSE](./LICENSE).
