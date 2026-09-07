// The bottom of the console's family DAG.
//
// `core/` holds what every other family may depend on and what depends on nothing:
// the named bounds, the tripwire registry, the clock seam, and the three shapes
// that were being reinvented per family — a keyed registry, a refusal, an emitter.
//
// The rule that makes this family work is that it imports NOTHING from the console
// above it. No store, no bridge, no React, no DOM beyond what the clock needs. If
// a symbol here ever needs a type from `store/` or `bridge/`, it is not core.

export { encodeBase64 } from "./base64.js";
export { ManualClock, RealClock, type ConsoleClock, type ScheduledHandle } from "./clock.js";
// The clock seam's third implementation: one identity over a clock the window
// replaces underneath a live mount.
export { ForwardingConsoleClock } from "./forwarding-clock.js";
export {
  ANSI_SPAN_RENDER_CAP,
  APPLY_COALESCE_MS,
  ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
  BOUNDED_ENUMERATION_MAX_ROWS,
  CAST_BAR_CHIP_CAP,
  CHAPTER_VISIBLE_ROW_CAP,
  CODE_HIGHLIGHT_SOURCE_BYTE_CAP,
  CODE_TOKEN_CACHE_BYTE_CAP,
  CODE_WORKER_THRESHOLD_BYTES,
  COMPOSING_NAMED_CAP,
  COMPOSING_RECEIVED_STALE_MS,
  DECK_RESTORED_PANE_CAP,
  DIFF_FILE_LIST_SCROLL_THRESHOLD,
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
  FIND_MATCH_CAP,
  FOOTNOTE_DEFINITION_CAP,
  HIDDEN_INVITE_CAP,
  IDENTIFIER_MAX_LENGTH,
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
  INLINE_DIFF_CARD_HEIGHT_CAP_PX,
  LEDGER_MAX_ELEMENT_HEIGHT_PX,
  LEDGER_PARKED_LEASE_CAP,
  LEDGER_WINDOW_ROW_CAP,
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
  MARKDOWN_BLOCK_CACHE_BYTE_CAP,
  MAXIMUM_LIVE_DRAFT_COUNT,
  MAX_REPAIRABLE_SEQUENCE_GAP,
  MOUNT_INVENTORY_READ_CAP,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  PARTITION_FOLD_THRESHOLD,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
  PHASE_GRAPH_MAX_ZOOM,
  PHASE_GRAPH_MIN_ZOOM,
  POSITION_SIBLING_OBSERVER_CAP,
  PRE_INITIALISATION_BUFFER_CAP,
  RAIL_FISHEYE_MAX_SCALE,
  RAIL_MAX_TICKS_PER_PIXEL,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  RESOLVED_PROSE_INLINE_CAP,
  RESTORE_PATH_ROW_HEIGHT_PX,
  RESTORE_PATH_VIRTUALIZATION_THRESHOLD,
  RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX,
  REVEAL_CHECKPOINT_TAIL_CAP,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_LITERAL_BACKTRACK_CAP,
  SCENARIO_PENDING_REPLY_CAP,
  SCENARIO_TICK_MS,
  SESSION_BACK_TIER_VISIBLE_CAP,
  SETTLED_INVITE_VISIBLE_CAP,
  SIDEBAR_MAXIMUM_WIDTH_PERCENT,
  TERMINAL_DEFAULT_SCROLLBACK_LINES,
  TERMINAL_LEASE_LEDGER_CAP,
  TERMINAL_WEBGL_POOL_CAP,
  TOOL_ALLOWLIST_NAMED_CAP,
  TOOL_SUMMARY_MAX_CHARACTERS,
  WHEN_CLAUSE_MAX_DEPTH,
  WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS,
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
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
//
// `MILLISECONDS_PER_SECOND` is absent for exactly that reason, measured over the same
// six tips: none of them carries a reader of it. `instant.ts` derives the minute from
// it inside the module that declares it and `instant.test.ts` reaches `./instant.js`,
// so the claim this line used to carry named a task that could never discharge it —
// and because the tag is what suppresses the dead-code finding, the line was invisible
// to the gate that would otherwise have reported it. A symbol no task will name is
// deleted from the door rather than tagged.
export {
  compareInstants,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
  parseInstant,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  type Instant,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  type InstantOffsetPolicy,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  type InstantOrder,
  type InstantReading,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
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
  // rather than re-declaring the same interface: five of them in `workspace/`, and
  // five copies of one shape is where the shape starts to differ.
  type NarrowedRefusal,
} from "./refusal.js";
// The registered widenings of that shape. Through the door because a family rendering
// a refusal's ledger reads the members, and a family that widened a refusal without
// registering it here would have its members dropped by the normalizer's rebuild.
export {
  /** @consumedBy T-023p-1C-3, T-023p-1C-4 */
  type ConsoleRefusalExtensions,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4 */
  type ExtendedConsoleRefusal,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4 */
  type WireRetryHint,
} from "./refusal-extensions.js";
export { reportTripwire } from "./tripwires.js";
export {
  normalizeWireRejection,
  type RejectionFallback,
  type WireRefusal,
  type WireErrorEnvelope,
} from "./wire-rejection.js";
// The two predicates a reading of an untyped wire value starts from, each written
// separately by the families that needed it. They ship through this door rather than
// from the family that happened to need one first, because their readers sit at three
// different heights on the DAG — `persistence/`, `bridge/`, `frame/` — and two of
// those cannot reach the third, so the floor is the only home all of them share.
export { isWireRecord } from "./wire-record.js";
export { readWireString } from "./wire-strings.js";

// The cross-process leaf's lossy renderer for a value that has no honest string,
// re-published here rather than re-declared.
//
// `src/shared/` sits under no rung of the console DAG, so a VIEW family may not read
// it and the console reaches it through the layer family that owns the concern. Three
// modules in this family already read that leaf for its guarded property reads and its
// rejection vocabulary, which makes the floor that family: a diagnostic string is the
// same concern one step along, and a second reading of it above here would be the
// drift the one-home rule exists to stop. `core/wire-rejection.ts` already states that
// this layer — not that one — is the console's home for turning an unknown into
// displayable text. Until this line existed the door published nothing for it, so two
// view families reached five directories up past `core/` to the declaration and the
// layering hole was invisible to every rule.
export { lossyStringify } from "../../../../shared/wire-errors.js";

// The leaf's code-scoped envelope reader, re-published on exactly the reasoning above.
//
// `store/timeline-resume.ts` asks one question of a rejected read — is this the daemon
// refusing a cursor this console submitted — and the honest instrument for it is the
// guarded reader, not a `rejection.code === …` comparison: a rejection is whatever a
// producer threw, its `code` may be an accessor, and an accessor that throws would
// propagate out of the `catch` that exists to classify the failure. The store family
// sits below `bridge/` and may not reach `src/shared/` itself, so it takes the reader
// through the floor that already owns this leaf's vocabulary.
export { readWireErrorEnvelopeWithCode } from "../../../../shared/wire-errors.js";
