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
export { DuplicateRegistrationError, KeyedRegistry } from "./keyed-registry.js";
export { ConsoleRefusalError, isConsoleRefusal, refuse, type ConsoleRefusal } from "./refusal.js";
export { TRIPWIRE_FIXTURE_GLOBAL, consoleTripwires, reportTripwire } from "./tripwires.js";
