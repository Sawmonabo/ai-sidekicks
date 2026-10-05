// @ts-check
// Node module-resolver hook that rewrites a `.js` specifier to its `.ts` sibling when that source
// file exists, for code that runs this package's TypeScript under vanilla Node rather than under
// vitest: a `worker_threads.Worker`, or a child process such as the daemon's entry point.
//
// Why it is needed:
//   * The project uses `nodenext` resolution with explicit `.js` extensions, which the test
//     runner maps to `.ts` sources; worker threads and child processes do not inherit that.
//   * Vanilla Node strips TypeScript types from the `.ts` files it executes, but it does not
//     rewrite `.js` specifiers to find sibling `.ts` files.
//
// A worker registers it via `node:module#register()`; a child process passes that call through
// `--import`. `node_modules` paths go straight to the default resolver.

import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(s: string, c: { parentURL?: string }) => unknown} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith(".js") &&
    context.parentURL !== undefined &&
    !specifier.includes("node_modules") &&
    !context.parentURL.includes("node_modules")
  ) {
    try {
      const candidateUrl = new URL(specifier, context.parentURL);
      const tsHref = candidateUrl.href.replace(/\.js$/, ".ts");
      const tsPath = fileURLToPath(tsHref);
      if (existsSync(tsPath)) {
        return nextResolve(tsHref, context);
      }
    } catch {
      // Fall through to default resolver on any URL parse failure —
      // node_modules / builtin specifiers (e.g. "node:fs") land here.
    }
  }
  return nextResolve(specifier, context);
}
