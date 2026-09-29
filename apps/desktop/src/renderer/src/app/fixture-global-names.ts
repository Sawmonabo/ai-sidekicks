// The names of the page properties a fixture build hangs its handles on, and nothing else.
//
// The module that installs a handle and the release-absence sweep that proves it is
// missing from a shipped bundle both read these names, so the two cannot drift apart.
// A leaf with no imports: the budget tier compiles the sweep with no DOM lib and the
// endurance drivers run with no React graph, and both import only this file.

/** The property a fixture build hangs the tripwire registry on. */
export const TRIPWIRE_FIXTURE_GLOBAL = "__fixtureTripwires__";

/** The property a fixture build hangs the running scenario's control on. */
export const SCENARIO_FIXTURE_GLOBAL = "__fixtureScenario__";

/** The property a fixture build hangs the session-store diagnostics on. */
export const SESSION_DIAGNOSTICS_FIXTURE_GLOBAL = "__fixtureSessionDiagnostics__";

/**
 * Every fixture global, as a closed tuple the release-absence sweep walks.
 *
 * Each member is the `typeof` of a constant above, so a global cannot be declared
 * without joining the sweep; the type is written out because `isolatedDeclarations`
 * does not infer a tuple of identifier references.
 */
export const FIXTURE_GLOBAL_NAMES: readonly [
  typeof TRIPWIRE_FIXTURE_GLOBAL,
  typeof SCENARIO_FIXTURE_GLOBAL,
  typeof SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
] = [TRIPWIRE_FIXTURE_GLOBAL, SCENARIO_FIXTURE_GLOBAL, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL];
