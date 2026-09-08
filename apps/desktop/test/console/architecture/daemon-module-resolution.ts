// What module a specifier names, which is the half a name alone cannot answer.
//
// ONE RESOLVER FOR THE THREE READINGS THAT KEY ON A MODULE, and it is here rather than
// private to any of them. `daemon-method-constants.ts` asks it which module a method
// constant came from, `daemon-call-census.ts` asks it whether an import of `callDaemon`
// reached the bridge's door module, and `daemon-read-round-receiver.ts` asks it whether
// an import of `ReadScope` or `useReadScope` reached the store's. Those are one question
// about a specifier asked at three positions, and a second copy of this join would be
// three ideas of what `"../../store/index.js"` resolves to — drifting apart in exactly
// the direction each of them is fail-closed against.
//
// THE RESOLUTION IS TEXTUAL AND DELIBERATELY SHALLOW. A relative specifier is joined
// onto its importer's own path and re-spelled as source — the console writes the
// EMITTED `.js` extension its module resolution requires, and the module on disk is the
// `.ts` or `.tsx` beside it. A bare specifier (a package) and a specifier that climbs
// out of the scanned roots each answer NOTHING, and every caller reads that empty answer
// as a refusal rather than as a licence: an unresolved method is reported on its own
// reading, and an unresolved door or read-scope import is not the export it names. That
// is the fail-closed direction — a resolver that guessed would be back to answering with
// whichever module it happened to walk last.
//
// POSIX THROUGHOUT, because a display path is POSIX throughout — the walk in
// `console-source-modules.ts` re-spells every path it produces, so a resolution that used
// the host's separator would answer a key no index holds on Windows and hold on this
// machine. And an extensionless or directory specifier answers nothing rather than
// guessing an `index` file: the package's own module resolution requires the extension,
// so a specifier without one is a shape this tree does not contain and inventing a
// resolution for it would be inventing a reach.

import { posix } from "node:path";

/** What the console's specifiers name a module by, since that is what it will import. */
const EMITTED_EXTENSION = ".js";

/** What the module is actually written as, in the order a resolution tries them. */
const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".tsx"];

/**
 * The module paths a specifier can name, in the order a resolution tries them.
 *
 * @param importerPath What the scan names the module the import is WRITTEN in, which is
 *   what a relative specifier is relative to.
 * @param moduleSpecifier The specifier as that import spells it.
 */
export function moduleCandidates(importerPath: string, moduleSpecifier: string): readonly string[] {
  if (!moduleSpecifier.startsWith(".")) {
    return [];
  }
  const resolved = posix.normalize(posix.join(posix.dirname(importerPath), moduleSpecifier));
  if (resolved.startsWith("..")) {
    return [];
  }
  if (SOURCE_EXTENSIONS.some((extension) => resolved.endsWith(extension))) {
    return [resolved];
  }
  if (!resolved.endsWith(EMITTED_EXTENSION)) {
    return [];
  }
  const base = resolved.slice(0, -EMITTED_EXTENSION.length);
  return SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`);
}

/**
 * Whether a specifier written in `importerPath` reaches one of `homes`.
 *
 * THE SHAPE BOTH EXPORT IDENTITIES TAKE. An export declared in one module and
 * re-exported by its family's barrel has TWO homes, and a consumer reaches it through
 * either — so the question is membership in a named set rather than equality with one
 * path, and the set is written where the export's own name is rather than derived from a
 * suffix. A suffix match would admit any `…/index.ts` anywhere in the tree, which is the
 * weaker identity the name-only reading already was.
 */
export function specifierNamesModule(
  importerPath: string,
  moduleSpecifier: string,
  homes: readonly string[],
): boolean {
  return moduleCandidates(importerPath, moduleSpecifier).some((candidate) =>
    homes.includes(candidate),
  );
}
