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
  COMPOSING_NAMED_CAP,
  COMPOSING_RECEIVED_STALE_MS,
  HIDDEN_INVITE_CAP,
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
  MAX_REPAIRABLE_SEQUENCE_GAP,
  MOUNT_INVENTORY_READ_CAP,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
  PRE_INITIALISATION_BUFFER_CAP,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  RESOLVED_PROSE_INLINE_CAP,
  SCENARIO_PENDING_REPLY_CAP,
  SCENARIO_TICK_MS,
  SESSION_BACK_TIER_VISIBLE_CAP,
  SETTLED_INVITE_VISIBLE_CAP,
  TOOL_ALLOWLIST_NAMED_CAP,
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
export {
  compareInstants,
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
export { ConsoleRefusalError, isConsoleRefusal, refuse, type ConsoleRefusal } from "./refusal.js";
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
  type WireRefusal,
} from "./wire-rejection.js";
