// The names of the properties a fixture build hangs its handles on. Only the names.
//
// THE RULE THIS MODULE EXISTS TO MAKE STRUCTURAL. Every `define`-gated fixture
// global's name is declared HERE and only here. The module that installs one
// imports its name from this file; the release-absence sweep reads the same list.
// Two sides of one seam — the producer that sets the property and the gate that
// proves it is absent from a shipped bundle — share a module, so neither can drift
// away from the other quietly.
//
// The drift this prevents is not hypothetical and it is silent in the direction
// that matters. The sweep's whole job is to report nothing; a name it does not
// know about is a name it reports nothing about, and a fixture handle that reached
// a release bundle would pass the gate exactly as an absent one does. Deriving
// `FIXTURE_GLOBAL_NAMES` from the three constants rather than restating them makes
// the sweep iterate a CLOSED set: a fourth global cannot be added without joining
// the tuple, and joining the tuple is joining the sweep.
//
// WHY THIS IS A LEAF WITH NO IMPORTS. It sits at the bottom of `core/`, which is
// itself the bottom of the console's family DAG, because its three consumers are
// in three different families — `core/tripwires.ts`, `bridge/scenario-runtime/scenario-selection.ts`,
// and `frame/session-event-binder.ts` — and the budget tier, which compiles under a
// Node-context config with no DOM lib and no `jsx`. Those producer modules reach
// React, the DOM, and `.tsx` through their own graphs, so a test that imported any
// of them to learn a string would not compile. A leaf that imports nothing is
// reachable from all four.

/** The property a fixture build hangs the tripwire registry on. */
export const TRIPWIRE_FIXTURE_GLOBAL = "__sidekicksConsoleTripwires__";

/** The property a fixture build hangs the running scenario's control on. */
export const SCENARIO_FIXTURE_GLOBAL = "__sidekicksConsoleScenario__";

/** The property a fixture build hangs the session-store diagnostics on. */
export const SESSION_DIAGNOSTICS_FIXTURE_GLOBAL = "__sidekicksConsoleSessions__";

/**
 * Every fixture global. Closed — adding one is a deliberate edit to this tuple.
 *
 * Derived from the three constants above rather than restating them, on
 * `TRIPWIRE_KINDS`' reasoning: two closed sets agree until one is widened, and the
 * divergence is invisible to the compiler in exactly the direction that matters —
 * the release-absence sweep walks THIS tuple, so a global declared beside it but
 * left off it would be a handle nothing ever checked for.
 *
 * The type is written out rather than left to `as const` because the package
 * compiles under `isolatedDeclarations`, which infers a literal expression and not
 * an array of identifier references. It is still DERIVED — each member is the
 * `typeof` of the constant above it, so a renamed property name propagates and a
 * fourth entry appended to the value without its annotation is a compile error.
 */
export const FIXTURE_GLOBAL_NAMES: readonly [
  typeof TRIPWIRE_FIXTURE_GLOBAL,
  typeof SCENARIO_FIXTURE_GLOBAL,
  typeof SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
] = [TRIPWIRE_FIXTURE_GLOBAL, SCENARIO_FIXTURE_GLOBAL, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL];
