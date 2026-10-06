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
// `--import`. Only a relative specifier from a source file is rewritten: a bare or `node:` one,
// and anything under `node_modules`, goes straight to the default resolver.

import { existsSync } from "node:fs";
import { URL } from "node:url";

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(s: string, c: { parentURL?: string }) => unknown} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  const parentUrl = context.parentURL;
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    parentUrl !== undefined &&
    parentUrl.startsWith("file:") &&
    !parentUrl.includes("node_modules")
  ) {
    const sourceUrl = new URL(specifier.replace(/\.js$/, ".ts"), parentUrl);
    if (existsSync(sourceUrl)) {
      return nextResolve(sourceUrl.href, context);
    }
  }
  return nextResolve(specifier, context);
}
