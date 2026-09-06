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
// The clock seam's third implementation: one identity over a clock the window
// replaces underneath a live mount.
export { ForwardingConsoleClock } from "./forwarding-clock.js";
export {
  APPLY_COALESCE_MS,
  CAST_BAR_CHIP_CAP,
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
  PRE_INITIALISATION_BUFFER_CAP,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  SCENARIO_PENDING_REPLY_CAP,
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
// The millisecond unit factors, beside the reading that makes the millisecond this
// console's unit. Through the door because a duration is composed and compared above
// every family: the presence model, the deadline wake and the invite shelf each wrote
// their own chain of them before this.
//
// Each claim below is the set of tasks whose branch carries a PRODUCTION module that
// will rebind through this door — measured over the six family tips, not inferred
// from who might want a duration. A `core/` sibling reaches `./instant.js` and a
// suite reaches the declaring module, so neither is a reader a door line can be
// retired by, and a claim naming one could never be discharged.
export {
  compareInstants,
  /** @consumedBy T-023p-1C-4 */
  MILLISECONDS_PER_DAY,
  /** @consumedBy T-023p-1C-4 */
  MILLISECONDS_PER_HOUR,
  /** @consumedBy T-023p-1C-4, T-023p-1C-5 */
  MILLISECONDS_PER_MINUTE,
  /** @consumedBy T-023p-1C-4 */
  MILLISECONDS_PER_SECOND,
  parseInstant,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6 */
  type Instant,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6 */
  type InstantOffsetPolicy,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6 */
  type InstantOrder,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6 */
  type InstantReading,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6 */
  type MalformedInstant,
} from "./instant.js";
// The registry classes leave through this door; the two symbols only their own
// suites read do not. `DuplicateRegistrationError` is what `KeyedRegistry` throws
// and `consoleTripwires` is the singleton `reportTripwire` writes to, so a family
// consumes each of them by calling the symbol beside it rather than by naming it.
// A test asserting on either reaches the module that declares it.
export { KeyedRegistry } from "./keyed-registry.js";
export {
  ConsoleRefusalError,
  isConsoleRefusal,
  refuse,
  type ConsoleRefusal,
  // The narrowing `refuse` returns. Through the door because a producer that owns a
  // closed code union declares its own refusal type as an instantiation of this one
  // rather than re-declaring the same interface: five of them in `workspace/` alone,
  // and five copies of one shape is where the shape starts to differ.
  type NarrowedRefusal,
} from "./refusal.js";
// The registered widenings of that shape. Through the door because a family rendering
// a refusal's ledger reads the members, and a family that widened a refusal without
// registering it here would have its members dropped by the normalizer's rebuild.
export {
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type ConsoleRefusalExtensions,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type ExtendedConsoleRefusal,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type WireRetryHint,
} from "./refusal-extensions.js";
export { reportTripwire } from "./tripwires.js";
export {
  normalizeWireRejection,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type RejectionFallback,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type WireRefusal,
} from "./wire-rejection.js";
// The two predicates a reading of an untyped wire value starts from, each written
// separately by the families that needed it. They ship through this door rather than
// from the family that happened to need one first, because their readers sit at three
// different heights on the DAG — `persistence/`, `bridge/`, `frame/` — and two of
// those cannot reach the third, so the floor is the only home all of them share.
export { isWireRecord } from "./wire-record.js";
export { readWireString } from "./wire-strings.js";

// The cross-process leaf's lossy renderer for a value that has no honest string.
//
// `src/shared/` sits under no rung of the console DAG, so a VIEW family may not read
// it and the console reaches it through the layer family that owns the concern. Three
// modules in this family already read that leaf for its guarded property reads and its
// rejection vocabulary, which makes the floor that family: a diagnostic string is the
// same concern one step along, and a second reading of it above here would be the
// drift the one-home rule exists to stop.
export { lossyStringify } from "../../../../shared/wire-errors.js";
