// The renderer-source tripwire the runtime-node view suites share.
//
// CP-003-3's per-file half: every module in this directory is renderer source, so
// none of them may name `node:*`, `electron`, or a workspace package the renderer is
// forbidden to reach. Both view suites carried this pattern table and its glob
// verbatim, which is a second copy of one rule — and the copies were about to
// disagree, because the two views were each split onto a `.ts` module beside the
// `.tsx` one and a glob reading `../*.tsx` would have stopped seeing exactly the code
// that performs the wire call.
//
// SO THE GLOB READS BOTH GRAMMARS and the patterns live once. What each suite still
// owns is WHICH modules it is making the claim about, because that is the part a
// reader has to check against the split.
//
// `node:fs` is doubly banned in renderer programs, so the source arrives inlined at
// transform time through Vite's raw glob rather than off the disk. The `ImportMeta`
// augmentation is scoped to this test program.
//
// ALL THREE PATTERNS ANCHOR ON THE IMPORT SURFACE (`from "…"` / `import "…"` /
// `import("…")`), never on bare words: these sources discuss "the local daemon" and
// spell "no `electron`, no `node:*`" in PROSE, which a naive substring match would
// false-positive. The banned-module alternation is written once and composed into the
// three surfaces, so the three cannot drift apart.

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const runtimeNodeSources = import.meta.glob("../*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const bannedModuleSource =
  "(?:@ai-sidekicks/(?:runtime-daemon|control-plane)(?:/[^\"'`]*)?" +
  "|[^\"'`]*packages/(?:runtime-daemon|control-plane)/[^\"'`]*" +
  "|node:[^\"'`]+" +
  "|(?:fs|path|os|net|child_process|process)" +
  "|electron(?:/[^\"'`]*)?)";

/** The three import surfaces, each with a synthetic violation its control asserts on. */
export const BANNED_DIRECT_IMPORT_PATTERNS: ReadonlyArray<readonly [string, RegExp, string]> = [
  [
    "bannedFromImport",
    new RegExp(`from\\s*["'\`]${bannedModuleSource}["'\`]`),
    'import { readFile } from "node:fs/promises";',
  ],
  [
    "bannedSideEffectImport",
    new RegExp(`import\\s*["'\`]${bannedModuleSource}["'\`]`),
    'import "@ai-sidekicks/control-plane";',
  ],
  [
    "bannedDynamicImport",
    new RegExp(`import\\s*\\(\\s*["'\`]${bannedModuleSource}["'\`]`),
    'const daemon = await import("@ai-sidekicks/runtime-daemon");',
  ],
];

/**
 * The text of one module in this directory, or a failure naming the key that missed.
 *
 * Glob-key-drift guard: a key that stopped resolving would otherwise leave every case
 * vacuously passing against an `undefined` source.
 */
export function runtimeNodeSourceNamed(globKey: string): string {
  const source = runtimeNodeSources[globKey];
  if (typeof source !== "string") {
    throw new Error(`${globKey} source was not loaded by import.meta.glob`);
  }
  return source;
}
