// The three properties a fixture build hangs its handles on.
//
// Each is RE-EXPORTED from the renderer module that sets it, never retyped here.
// A string duplicated across this boundary cannot go wrong loudly: a rename in
// the renderer would leave a tier reading `undefined` from a global that no
// longer exists — at the far end of the longest tier in the suite, reporting a
// missing property rather than a rename. Importing makes it a compile error
// instead. Stated once for all three rather than three times, because a rule
// restated per export is a rule with three places to drift.
//
// Held apart from `electron-harness.ts` because naming what a fixture build
// publishes and launching Electron are two jobs: the endurance tier's workload
// module reads these handles without launching anything, and the launcher does
// not read them at all.
//
// The tiers that consume this compile under `tsconfig.console-electron-test.json`,
// which carries both the Node and the DOM libs precisely so a driver can name what
// the renderer declares; the build-time signals the console's modules read are
// substituted for the driver process by each tier's `define` in `vitest.config.ts`.

/** The tripwire registry. */
export { TRIPWIRE_FIXTURE_GLOBAL } from "../../src/renderer/src/console/core/tripwires.js";

/**
 * The scenario control, and its shape.
 *
 * Reached directly rather than through `console/bridge/index.js`, because that
 * barrel re-exports the provider component and would drag the console's whole
 * React graph into a driver process that renders nothing. Not a syntax
 * constraint: `tsconfig.console-electron-test.json` sets `jsx: react-jsx`
 * explicitly, and says why — a family barrel already puts the console's React
 * modules in this program. The reason is the graph, not the JSX.
 */
export {
  SCENARIO_FIXTURE_GLOBAL,
  type ScenarioFixtureHandle,
} from "../../src/renderer/src/console/bridge/scenario-selection.js";

/**
 * The session-store diagnostics, and their shape.
 *
 * Beats delivered by the scenario engine and events admitted to a store's apply
 * chokepoint are two different claims, and the endurance tier asserts both.
 */
export {
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  type ConsoleSessionDiagnostics,
} from "../../src/renderer/src/console/frame/session-event-binder.js";
