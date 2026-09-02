// The bottom of the console's family DAG.
//
// `core/` holds what every other family may depend on and what depends on nothing:
// the named bounds, the tripwire registry, the clock seam, and the three shapes
// that were being reinvented per family — a keyed registry, a refusal, an emitter.
//
// The rule that makes this family work is that it imports NOTHING from the console
// above it. No store, no bridge, no React, no DOM beyond what the clock needs. If
// a symbol here ever needs a type from `store/` or `bridge/`, it is not core.

export { ManualClock, RealClock, type ConsoleClock, type ScheduledHandle } from "./clock.js";
export {
  APPLY_COALESCE_MS,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_SESSION_PARTITION_CAP,
  PERSISTENCE_VALUE_BYTE_CAP,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  SCENARIO_TICK_MS,
  WHEN_CLAUSE_MAX_DEPTH,
} from "./constants.js";
export { Emitter, type EmitterSink, type Unsubscribe } from "./emitter.js";
// The two fixture-global names whose installers live ABOVE this family and so
// reach them through this door. The tripwire registry's name is not re-exported
// here because its installer is `core/tripwires.js` itself, and the closed
// `FIXTURE_GLOBAL_NAMES` tuple is not either because its one consumer is the
// release-absence sweep, which imports the leaf directly — a barrel line no
// importer reaches is a dead export the structure gate reports.
export { SCENARIO_FIXTURE_GLOBAL, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL } from "./fixture-globals.js";
export { DuplicateRegistrationError, KeyedRegistry } from "./keyed-registry.js";
export { ConsoleRefusalError, isConsoleRefusal, refuse, type ConsoleRefusal } from "./refusal.js";
export { consoleTripwires, reportTripwire } from "./tripwires.js";
