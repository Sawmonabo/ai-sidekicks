// The scenario family's door — the corpus, and the manifest that ledgers it.
//
// ONE FAMILY, WITH THE RUNTIME AS A MODULE INSIDE IT. `runtime/` holds the vocabulary a
// scenario is written in and the machinery that plays one; everything beside it here is
// an INSTANCE — the seat board in `corpus.ts`, the family subdirectories, and the two
// corpus-aware modules the runtime is not allowed to hold: `manifest.ts`, which reads the
// board, and `selection.ts`, which resolves one of its ids off the document.
//
// THE ONE DIRECTION THAT IS FORBIDDEN. `runtime/` imports nothing from this directory —
// `console-scenario-runtime-imports-nothing-above-it` in `.dependency-cruiser.mjs` refuses
// the edge at any depth. That is what lets a family land a scenario without touching the
// engine, and the engine change without a merge conflict in every family branch at once.
// A runtime module that finds it needs the corpus is either handed what it needs (the
// engine already takes `{ scenario }`) or moved up here beside the two that already were.
//
// WHY THE RUNTIME'S OWN SURFACE IS NOT RE-EXPORTED HERE. A door is an edge to every module
// it re-exports from, so a reader taking `ConsoleScenario` off this line would receive an
// edge into the whole corpus — and the corpus reaches the fixture, which reaches the bridge
// contract, which reaches the engine. Measured before this directory existed: four cycles
// `no-circular` fails. Every reader of the vocabulary therefore takes it by the runtime's
// own specifier, `scenario/runtime/index.js`, which is the same remedy
// `fixture/call-plane/refusal.ts` records for the same shape. `selection.ts` is off this
// door for the narrower reason that its two readers — the family door one level up and the
// Playwright fixture handle — each already reach it by name, and a second path to one
// symbol is what a rename reroutes silently.

export { CONSOLE_SCENARIOS } from "./corpus.js";

export {
  consoleScenario,
  consoleScenarioManifest,
  findOrphanedLedgerRowIds,
  mapSlateRowCoverage,
  type ConsoleScenarioManifest,
} from "./manifest.js";
