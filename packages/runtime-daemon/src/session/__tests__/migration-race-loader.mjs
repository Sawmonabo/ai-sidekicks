// @ts-check
// Node module-resolver hook that rewrites `.js` → `.ts` extensions when
// the corresponding `.ts` source file exists. Required for the
// concurrent-boot worker (`migration-race-worker.mjs`) to dynamically
// `import()` the production `migration-runner.ts` source from inside a
// `worker_threads.Worker` child.
//
// Why this hook is necessary:
//   * The project uses `nodenext` resolution with explicit `.js`
//     extensions per `verbatimModuleSyntax` convention. Production
//     modules import each other with `.js` URLs that resolve to `.ts`
//     files via the bundler/test runner's transformation step.
//   * Vitest's TypeScript loader IS active when running tests, but
//     `worker_threads.Worker` children do NOT inherit vitest's loader
//     hooks — they get a vanilla Node interpreter.
//   * Vanilla Node 22.21+ DOES strip TypeScript types from `.ts` files
//     it executes, but it does NOT rewrite `.js` import specifiers to
//     find sibling `.ts` files. That step is missing.
//
// This loader registers via `node:module#register()` from the worker
// entrypoint and only fires for our project source. node_modules paths
// are short-circuited to the default resolver to keep dependency
// resolution fast.

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
