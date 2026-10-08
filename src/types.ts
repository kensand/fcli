export interface UckArgs {
  _: string[];
  [key: string]: string | string[] | undefined;
}

/** A unit of f functionality. Only a word when prefixed with 'f-'. */
export interface Uck {
  name: string;
  desc: string;
  run: (argv: string[], args: UckArgs) => void | Promise<void>;
  argv?: (argv: string[]) => UckArgs;
}

/** Context passed to every uck's register function */
export interface UckContext {
  /** f's own version string */
  fVersion: string;
  /** All ucks registered so far (store + previously loaded) */
  ucks: { name: string; desc: string }[];
  /** This uck's name */
  self: string;
}

/** What a uck module (index.js) exports */
export interface UckModule {
  /** Called once at load time. Returns one or more ucks. */
  register: (ctx: UckContext) => Uck[] | Uck;
}

/**
 * A source in f.config.json. Either a bare string, or an object with a source
 * + optional ref + optional subset filters. A repo source expands to many ucks
 * (each subdir / file inside becomes a store entry); a local single-uck source
 * installs as one.
 *
 * Subset filters (repo sources):
 *  - only:   install just these uck names (whitelist)
 *  - except: install everything except these uck names (blacklist)
 *  - if both are given, `only` wins.
 *  Sources are independent: each installs whatever its own filter allows.
 */
export type UckSource = string | {
  /** git URL, github:user/repo, npm package, or local path */
  source: string;
  /** optional branch/tag for git sources */
  ref?: string;
  /**
   * optional bucket name for the store (~/.f/ucks/<name>/). Defaults to the
   * repo basename (git) or path basename (local). Set it to give a source a
   * stable, collision-free bucket distinct from other sources.
   */
  name?: string;
  /** optional whitelist of uck names to install from a multi-uck repo */
  only?: string[];
  /** optional blacklist of uck names to skip from a multi-uck repo */
  except?: string[];
};

/** f.config.json shape (global ~/.f/f.config.json and/or project f.config.json) */
export interface FConfig {
  /** uck sources to install into the store */
  ucks: UckSource[];
}
