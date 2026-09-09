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
// The console's named bounds. All of them.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".
// `apps/desktop/AGENTS.md` says where: "One value, one home: budgets and their unit
// factors in `budgets.json`, caps in `console/core/constants/` with a rationale
// each."
//
// ONE HOME MEANS ONE HOME, AND A DIRECTORY IS A HOME. The home used to say a view
// family adds its own module beside its subtree, and four families took that licence
// — `agents/constants.ts`, `collaboration/constants.ts`, `sessions/bounds.ts`,
// `settings/constants.ts` — so a cap audit's answer depended on which of five places
// it looked in, and a bound was spelled `constants` in three of them and `bounds` in
// the fourth. Every bound lives in `core/constants/` now, and
// `test/console/architecture/cap-single-home.test.ts` fails the build if a second home
// appears.
//
// ONE MODULE PER CONCERN, named for who spends it, appended within a module. The home
// was one 1 051-line file whose own banner comments already drew these seams; a file
// that long is doing two jobs by the package's own rule, and the seams were the split.
// The rationale travels with the value: a bound moved here without the paragraph that
// says why it is that number is a number, and a number is what this home exists to
// prevent. `core/` is the bottom of the family DAG, so every family may import from it
// and no family crosses another to reach a bound.
//
// THE DIRECTORY CARRIES NO INNER DOOR. No module inside `core/constants/` reads
// another, so a sub-module door would publish names only this door could reach — and
// this door re-exports from the module that DECLARES each bound, which is the rule a
// family door follows everywhere else in the console.
//
// WITH ONE SHAPE THE GATE DECIDES, and it decides against a family keeping its own.
// `test/console/architecture/cap-constant-home.test.ts` reads DECLARATIONS, names
// `core/constants/` the one place a bound may be declared in, and fails a view family
// that declares one of its own. So a family's bound TABLE — a record keyed by the
// names it declares in one tuple, which is what `browser/bounds/browser-bounds.ts` is
// — stays beside its readers, while a plain `export const SOMETHING_CAP = …` lands in
// this home whichever family spends it. The rationale travels with the value: each
// module below carries the paragraph its bound was written with.
//
// A MEASUREMENT IS NOT A BOUND, and that is the line the gates draw. A row height,
// an overscan count, a rounding factor, and an encoding's byte width are sizes and
// factors rather than ceilings — nothing is checked against them — so they stay with
// the code that computes with them, and `console/repos/diff-pane/diff-bounds.ts` is
// the case that says so out loud. `cap-constant-home.test.ts` beside `cap-single-home`
// matches the name segments that make an identifier a ceiling; what comes here is what
// a value is tested against.
//
// A number that appears inline anywhere under `console/` and is not a layout
// literal is a review rejection: the rationale is the point, not the constant.
//
// Four of the home's bounds are deliberately absent below, each with its readers
// inside `core/` or in a suite that reaches the declaring module: the encoder stride,
// the restore list's visible-row cap, the terminal budget's measurement width, and the
// tripwire report cap. A door line no production importer reaches is a dead export the
// barrel census fails. The cast bar's chip cap has left that list — the bar is built
// and reads it through this door.
export { RESOLVED_PROSE_INLINE_CAP, TOOL_ALLOWLIST_NAMED_CAP } from "./constants/agents-caps.js";
export { BROAD_ALLOW_LIST_THRESHOLD } from "./constants/approvals-caps.js";
export { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./constants/artifact-caps.js";
export {
  ATTACHMENT_BYTE_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
} from "./constants/attachment-caps.js";
export {
  CAPTURED_OBJECT_ROW_CAP,
  PARTITION_FOLD_THRESHOLD,
  POSITION_SIBLING_OBSERVER_CAP,
  RELAYED_TOOL_CALL_ROW_CAP,
} from "./constants/browser-caps.js";
export {
  COMPOSING_IDLE_STOP_MS,
  COMPOSING_NAMED_CAP,
  COMPOSING_PUBLISH_INTERVAL_MS,
  COMPOSING_RECEIVED_STALE_MS,
  SETTLED_INVITE_VISIBLE_CAP,
} from "./constants/collaboration-caps.js";
export {
  DIFF_FILE_LIST_SCROLL_THRESHOLD,
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
  DIFF_PATCH_CHARACTER_CAP,
  INLINE_DIFF_CARD_HEIGHT_CAP_PX,
} from "./constants/diff-caps.js";
export { SCENARIO_PENDING_REPLY_CAP, SCENARIO_TICK_MS } from "./constants/fixture-caps.js";
export {
  PENDING_INVITE_DEFERRED_PLACE_MAX,
  PENDING_INVITE_QUEUE_MAX,
  PENDING_INVITE_RETAINED_REFUSAL_MAX,
} from "./constants/invite-caps.js";
export {
  ANSI_SPAN_RENDER_CAP,
  CODE_HIGHLIGHT_SOURCE_BYTE_CAP,
  CODE_TOKEN_CACHE_BYTE_CAP,
  CODE_WORKER_THRESHOLD_BYTES,
  FOOTNOTE_DEFINITION_CAP,
  MARKDOWN_BLOCK_CACHE_BYTE_CAP,
  TOOL_SUMMARY_MAX_CHARACTERS,
} from "./constants/ledger-card-caps.js";
export {
  LEDGER_EARLIER_PAGE_ROWS,
  LEDGER_MAX_ELEMENT_HEIGHT_PX,
  LEDGER_PARKED_LEASE_CAP,
  LEDGER_WINDOW_ROW_CAP,
  REVEAL_CHECKPOINT_TAIL_CAP,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_LITERAL_BACKTRACK_CAP,
} from "./constants/ledger-frame-caps.js";
export {
  CHAPTER_BODY_RETAINED_ROW_CAP,
  CHAPTER_VISIBLE_ROW_CAP,
  FIND_MATCH_CAP,
  RAIL_FISHEYE_MAX_SCALE,
  RAIL_MAX_TICKS_PER_PIXEL,
} from "./constants/ledger-structure-caps.js";
export {
  LIVE_ANNOUNCEMENT_HOLD_MS,
  LIVE_ANNOUNCEMENT_QUEUE_CAP,
} from "./constants/live-announcement-caps.js";
export {
  BOUNDED_ENUMERATION_MAX_ROWS,
  PALETTE_RECENTS_CAP,
  PALETTE_RESULT_CAP,
  WHEN_CLAUSE_MAX_DEPTH,
  WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS,
} from "./constants/palette-caps.js";
export {
  IDENTIFIER_MAX_LENGTH,
  MAXIMUM_LIVE_DRAFT_COUNT,
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
} from "./constants/persistence-caps.js";
export {
  PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP,
  UTILIZATION_BAR_FULL_SCALE,
} from "./constants/provider-quota-caps.js";
export {
  APPLY_COALESCE_MS,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
} from "./constants/refresh-caps.js";
export {
  RESTORE_PATH_ROW_HEIGHT_PX,
  RESTORE_PATH_VIRTUALIZATION_THRESHOLD,
  RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX,
} from "./constants/restore-caps.js";
export {
  AWAITING_RUN_IDS_NAMED_CAP,
  INTERVENTION_OUTCOME_CAP,
  PROJECTED_RUN_CAP,
  QUEUE_ROWS_RENDERED_CAP,
  RUN_STATUS_ROW_CAP,
  SEATED_KNOWN_RUN_CAP,
  STUCK_RUN_ESCALATION_MS,
  STUCK_RUN_NOTICE_MS,
} from "./constants/runs-caps.js";
export { SESSION_GOAL_MAX_LENGTH, SESSION_GOAL_MIN_LENGTH } from "./constants/session-goal-caps.js";
export {
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PRE_INITIALISATION_BUFFER_CAP,
} from "./constants/session-store-caps.js";
export {
  ATTENTION_NOTIFIED_ITEM_CAP,
  HIDDEN_INVITE_CAP,
  SESSION_BACK_TIER_VISIBLE_CAP,
} from "./constants/sessions-caps.js";
export { MOUNT_INVENTORY_READ_CAP } from "./constants/settings-caps.js";
export { INTERRUPTED_RUN_IDS_NAMED_CAP } from "./constants/shell-caps.js";
export {
  TERMINAL_DEFAULT_SCROLLBACK_LINES,
  TERMINAL_LEASE_LEDGER_CAP,
  TERMINAL_WEBGL_POOL_CAP,
} from "./constants/terminal-caps.js";
export {
  PHASE_GRAPH_MAX_ZOOM,
  PHASE_GRAPH_MIN_ZOOM,
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
} from "./constants/workflows-caps.js";
export {
  CAST_BAR_CHIP_CAP,
  DECK_RESTORED_PANE_CAP,
  LOAD_PROGRESS_MAX,
  LOAD_PROGRESS_MIN,
  SIDEBAR_MAXIMUM_WIDTH_PERCENT,
} from "./constants/workspace-caps.js";
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
// What one session's ledger viewport is showing, and the registry that carries it.
// Declared at the floor for `TransportReconnectObservable`'s reason with the two ends
// swapped: the producer is a VIEW family (the top of the DAG) and the consumer is
// `frame/session/session-event-binder.ts` (below every view family), so neither can
// import the other and the floor is the only home both can reach. The registry CLASS
// does not leave — the singleton beside it is what both sides take, exactly as
// `reportTripwire` is what a family takes rather than `TripwireRegistry`.
export { consoleLedgerWindows, type LedgerWindowReading } from "./ledger-window-diagnostics.js";

// The one keyed-record rebuild. At the floor because its readers are `settings/` and
// `collaboration/`, two VIEW families, and a view family never imports another — so the
// floor is the only home either could have taken it from.
export { withoutKey } from "./keyed-record.js";
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
  refusedMemberPaths,
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
  type ExtendedConsoleRefusal,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4 */
  type WireRetryHint,
  type WireReferencingArtifacts,
  readRefusalExtensions,
} from "./refusal-extensions.js";
// What a surface DOES about a named refusal, beside rendering the daemon's words:
// the shape its blast radius calls for, the operator's next move, and whether the
// control it answered has anything left to do. Through the door because the codes
// reach the composer, the runs pane, and the approvals pane alike, and one code
// answered in three sets of words is a remedy a person cannot learn once. The
// LOOKUP is what crosses the door and its two types are not: every reader outside
// this family reads the answer's fields off the returned value, and a door line
// nothing imports is a dead export the census fails.
export { refusalRemedyFor } from "./refusal-remedies.js";
// The one tuple-to-key encoder. At the floor because its two readers sit at different
// heights on the DAG — `bridge/quotas/`'s `(accountId, limitId)` reading key and
// `settings/`'s scope-qualified MCP binding key — and neither family may reach the
// other, so the floor is the only home both can take it from.
export { structuralKey } from "./structural-key.js";
// Which two members name one provider ask. At the floor because its readers are two
// sibling VIEW families — the ledger's ask card and the workspace's cast bar — so
// neither may reach the other, and an ask filed under two spellings of its identity is
// an answer landing on the wrong run's card.
export { driverAskIdentitySegments } from "./driver-ask-identity.js";
// The subscribe view of the console's one transport-reconnect signal. Declared at
// the floor because its producer is `bridge/` and its consumer is `store/`, and the
// DAG puts the consumer below the producer — so the floor is the only home both can
// reach. The emitter itself stays in `bridge/`.
export type { TransportReconnectObservable } from "./transport-reconnect.js";
export { NO_TRANSPORT_RECONNECT } from "./transport-reconnect.js";
export { reportTripwire } from "./tripwires.js";
export {
  normalizeWireRejection,
  type RejectionFallback,
  type WireRefusal,
  type WireErrorEnvelope,
} from "./wire-rejection.js";
// The three predicates a reading of an untyped wire value starts from, each written
// separately by the families that needed one. They ship through this door rather than
// from the family that happened to need one first, because their readers sit at three
// different heights on the DAG — `persistence/`, `bridge/`, `frame/` — and two of
// those cannot reach the third, so the floor is the only home all of them share.
export { isWireRecord } from "./wire-record.js";
export { readWireNumber, readWireString } from "./wire-strings.js";
// The other question a fold asks of an untyped payload, and it is about two members
// rather than one: whether the session the payload states is the session the envelope
// delivered it on. Here for the predicates' reason — its readers are `frame/`,
// `bridge/`, and a VIEW family, and a view family may import neither of the others.
export { payloadContradictsSession, payloadNamesSession } from "./wire-session-attribution.js";
// The total stringifier, re-published rather than re-declared. It is DECLARED in
// `src/shared/wire-errors.ts`, which both processes compile, and `core/wire-rejection.ts`
// already states that this layer — not that one — is the console's home for turning an
// unknown into displayable text. Until this line existed the door published nothing for
// it, so two view families reached five directories up past `core/` to the declaration
// and the layering hole was invisible to every rule.
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

// The shell's shutdown budget, on the same rule and for the same reason. It is
// DECLARED in `src/shared/shutdown-budget.ts` because `src/main/sidecar-lifecycle.ts`
// races the quit drain against it, and a value main reads cannot live in a console
// file. The console's stake is one sentence, so it takes the figure through the floor
// rather than reaching past the DAG to the cross-process leaf that holds it.
export { DAEMON_SHUTDOWN_FLUSH_BUDGET_MS } from "../../../../shared/shutdown-budget.js";

// The console's one airspace: which overlays are on screen in a window, so a native
// view yields to them (`Spec-023 §Console Design (Meridian)` 12.3, §4.3). At the DAG
// floor because its registrants are `primitives/` and its reader is a view family,
// and this is the only rung both of them stand above.
export {
  AirspaceRegistry,
  type AirspaceMotionObserver,
  type AirspaceOverlayElement,
  type AirspaceOverlayKind,
  type AirspaceRect,
} from "./airspace-registry.js";
export { airspaceRegistryFor } from "./airspace-registries.js";
