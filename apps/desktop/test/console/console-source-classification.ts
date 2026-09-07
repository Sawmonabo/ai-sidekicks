// What a file NAME says about a module, decided once for every walk that asks.
//
// Split out of `console-source-modules.ts` beside it rather than left inside it
// because that module is the WALK — the roots, the recursion, the display path,
// the read — and classifying a name is a different job with a different failure.
// The walk fails by reaching the wrong directory; this fails by admitting a
// declaration file, or by quantifying over `.ts` and `.tsx` while the package
// also writes `.mts` and `.cts`, and neither failure is visible from the other
// side: a module this refuses is simply absent from the set, so no claim made
// over that set can report it.
//
// It is the LEAF of the pair. It imports nothing, reads nothing, and touches no
// filesystem, which is what lets the walk depend on it and never the reverse —
// and what lets a gate that only wants the name test (the spawn chokepoint's
// declaration control, the body-allowance census's extension loop) take it
// without pulling a recursive directory read in behind it.

/**
 * What a TypeScript module file name ends in — the ONE declared set.
 *
 * Four extensions and not two, because `.mts` and `.cts` are TypeScript modules
 * this package actually writes: `AGENTS.md §Executables` makes every file under
 * `scripts/**` and `build/**` a `.ts` or a `.mts`, and seven `.mts` executables
 * live under `scripts/budget/` today. A walk keyed on `/\.tsx?$/` therefore
 * quantifies over less than its own sentence claims, and the failure is silent by
 * construction: the module it skipped is absent from the set, so no claim about
 * that set can report it. `electron-spawn-chokepoint.test.ts` is where that bit —
 * a `.mts` helper reaching `spawn` and never appearing among the spawners — and
 * this is the one home both walks now take it from.
 *
 * `.d.ts` is subtracted by {@link isSourceModulePath} rather than here: it IS a
 * TypeScript module file name, and what disqualifies it is that it declares
 * rather than implements.
 */
export const TYPESCRIPT_MODULE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

/** A declaration file of any of the four, which declares rather than implements. */
const DECLARATION_MODULE_NAME = /\.d\.[cm]?ts$/;

/** Whether `fileName` names a TypeScript module, by extension alone. */
export function isTypeScriptModuleFileName(fileName: string): boolean {
  return TYPESCRIPT_MODULE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

/**
 * Whether a walked entry is hand-written source, with tests admitted or not.
 *
 * The one answer the source walk admits on, so what counts as source is decided
 * here and read there. `tests` is a parameter rather than a fork for the reason
 * `console-source-modules.ts` states about its own scan options: one gate governs
 * the tests too, and the two walks that expressed that as separate recursions
 * disagreed with each other about `.test-support.*`.
 */
export function isSourceModulePath(entry: string, tests: boolean): boolean {
  // Every declaration flavour of the set above, and not `.d.ts` alone: a
  // declaration is a claim rather than an implementation whichever module system
  // it declares for, and matching one spelling would admit the other two.
  if (DECLARATION_MODULE_NAME.test(entry)) {
    return false;
  }
  if (!tests && isTestModulePath(entry)) {
    return false;
  }
  return isTypeScriptModuleFileName(entry);
}

/** A co-located test or the support module one imports. One answer, for both walks. */
function isTestModulePath(entry: string): boolean {
  return (
    entry.endsWith(".test.ts") ||
    entry.endsWith(".test.tsx") ||
    entry.endsWith(".test-support.ts") ||
    entry.endsWith(".test-support.tsx")
  );
}
