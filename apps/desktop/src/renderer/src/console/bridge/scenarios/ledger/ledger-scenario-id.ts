// The id of the scenario a window opens on, in a module that carries nothing else.
//
// THE ONE STRING PRODUCTION CODE READS OUT OF THE SCENARIO CORPUS, and the reason it
// is not declared beside the scenario it names. `scenario-selection.ts` publishes
// `DEFAULT_SCENARIO_ID`, which `BridgeProvider.tsx` reads on every mount, so that one
// binding is live in a release build — and an import edge is per MODULE, not per
// binding: reading the id out of `ledger-first-sixty.ts` puts that whole module in the
// release graph.
//
// WHICH IS NOT ACADEMIC, BECAUSE THE TWO SCENARIOS SHAKE DIFFERENTLY. The
// `treeshake.moduleSideEffects` declaration in `electron.vite.config.ts` lets the
// bundler drop a fixture module NOBODY imports from, and it lets it drop the UNUSED
// declarations of one somebody does — but only where those declarations are provably
// pure. `first-run.ts` builds its scenario from object literals, so its unused scenario
// const is dropped and its label never ships. This family builds its beats by CALLING
// the script builders, and a call the bundler cannot prove pure is a declaration it
// retains: the whole sixty-second beat list and the scenario's own label and purpose
// prose reached `index-*.js`, which `test/console/budget/release-absence.test.ts`
// fails on by name.
//
// A leaf with one literal in it has nothing to retain, so the edge costs nothing and
// the id still has exactly one home. `ledger-first-sixty.ts` re-exports it for the
// corpus, which keeps the scenario's own module the place a reader looks it up.

/** The scenario id `ledger-first-sixty.ts` builds under, and the console's default. */
export const LEDGER_FIRST_SIXTY_SCENARIO_ID = "ledger-first-sixty";
