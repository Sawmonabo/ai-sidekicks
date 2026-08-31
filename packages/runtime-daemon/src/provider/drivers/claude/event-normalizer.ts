// Claude event normalizer (Plan-005 Phase 3, T3.10).
//
// The Claude leg of the driver normalize boundary, and the deliberate mirror
// of `../codex/event-normalizer.ts` (T3.5) — Plan-005 pairs the two as
// symmetric tasks. A PURE, TOTAL mapping from the pinned Claude stream-json /
// control-channel frame kind to the Plan-006 normalized event family it
// belongs to. Nothing here parses a payload, mints an envelope, or touches
// session state: it answers exactly one question, "which normalized family
// does this native frame belong to", which is the whole of what
// `Spec-005 §Required Behavior` (drivers emit normalized runtime events, not
// provider-native types) asks of this seam.
//
// Spec coverage:
//   - `Spec-005 §Required Behavior` — drivers emit normalized runtime events,
//     not provider-native types. The session engine never sees a Claude
//     `subtype` string; it sees an `EventCategory` and a `SessionEventType`.
//   - `Spec-005 §Required Behavior` — the required normalized event families
//     (run lifecycle, assistant output, tool activity, interactive request,
//     artifact publication, usage/quota telemetry). Three of the six are
//     reachable from the pinned Claude census; the other three are NOT, and
//     that is a corpus fact rather than a hole in this table. It is recorded
//     as a checked value (`CLAUDE_FAMILY_REACHABILITY`) rather than as prose,
//     so the ledger cannot drift away from the mapping it describes.
//
// Verifies invariant: none. Normalization is structural; family-level
// coverage is verified by the Plan-006 taxonomy tests.
//
// ---------------------------------------------------------------------------
// Where every row of the table below comes from
// ---------------------------------------------------------------------------
//
// Two corpus sources, and no third:
//
//   (1) `docs/reference/provider-wire/claude.md` — the version-pinned Claude
//       wire reference (pin `2.1.251`; the schema-constructor census these
//       subtype and stream-surface names come from was read at `2.1.245` on
//       2026-08-25 from the native single-file build and is CARRIED to the pin,
//       with every name below re-verified present in the `2.1.251` binary on
//       2026-08-28 — see that file's §Version pin "Carried census" row). It
//       records the fifteen control-request subtypes in
//       full (§Control-request registry), the censused-absent-but-answering
//       `mcp_set_servers` and the `control_response` envelope shape (same
//       section), and the result subtypes, the `system/api_retry` shape with
//       its `system/api_error` mapping arm, and the adjacent stream subtypes
//       (§Result and stream surface).
//   (2) `docs/plans/006-session-event-taxonomy-and-audit-log.md`
//       §Event-Kind Disposition Table — the disposition contract. Its 35-kind
//       census fixes each normalized kind's target category and type; its
//       "Explicitly-discarded boundary subtypes" table names nine Claude
//       system-channel wire strings with a reason apiece; and its
//       "current-wire delta families" table fixes FAMILY-level dispositions
//       for the Claude delta rows (result-subtype, the `api_retry` typed-error
//       enum, `worker_shutting_down`, the plugin family, the hook family).
//
// Nothing in this table is transcribed from provider prose docs or invented.
// The "regenerate, don't transcribe" rule
// (`docs/reference/provider-wire/README.md` §Evidence rules) governs the wire
// SHAPES; this file maps frame KINDS, each of which is recorded verbatim in
// one of the two sources above, and the `__fixtures__/` census vectors carry
// the claude.md-recorded subset so a re-pin diff shows up as a failing test
// rather than as prose drift.
//
// ---------------------------------------------------------------------------
// What is deliberately NOT in the closed census (and why)
// ---------------------------------------------------------------------------
//
// Each exclusion below is a frame the corpus mentions but does not settle a
// disposition for. Excluding it is not a drop: an excluded kind reaches
// {@link UnknownClaudeWireFrameError}, which Plan-005 T3.11 re-points at the
// daemon diagnostic default branch. That is precisely the fail-open half of
// the Plan-005 boundary rule ("an unknown-but-parseable kind ... is never
// dropped and never forced into an envelope"). Putting a guessed row in the
// table instead would convert a loud unknown into a silent fabrication.
//
//   - The Claude `assistant` / `user` stream-json MESSAGE frames, and with
//     them every census kind that only they could feed (`text_delta`,
//     `thinking`, `tool_start`, `tool_complete`, `content_block_start`,
//     `content_block_stop`, `user_text`, `todo_update`, `diff`,
//     `command_output`, `task_create`, `task_update`,
//     `background_task_terminal`, `background_task_notification`).
//     claude.md §Gaps records the reason directly: "No authless protocol probe
//     exists for this provider ... there is no way to observe Claude's
//     stream-json handshake without a token." The reference therefore records
//     no discriminant for these frames, and minting one here would give an
//     assumed shape the appearance of pinned provenance.
//   - `SubagentStart` / `SubagentStop`. Plan-005 T3.11 claims them by name
//     ("Claude `SubagentStart` / `SubagentStop` normalize into
//     `subagent.started` / `subagent.completed` ... carrying
//     `parent_tool_use_id` copied verbatim"), and T3.11 landed them in this
//     file as the dedicated subagent-lifecycle band below
//     ({@link normalizeClaudeSubagentLifecycle}) rather than as census rows:
//     the census carries only reference-recorded kinds, and these two are
//     recorded by the plan row, not by claude.md.
//   - The four adjacent stream subtypes claude.md records at the pin but no
//     disposition table covers: `command_lifecycle`, `queued_notification`,
//     `model_refusal_fallback`, `model_refusal_no_fallback`. All four are
//     Binary-probe/Verified additions dated 2026-08-25, which POSTDATES the
//     35-kind census they would have to join. They are excluded uniformly
//     rather than selectively: `model_refusal_fallback` could be argued onto
//     census row 21 (`model_rerouted`) by inference, but its sibling
//     `model_refusal_no_fallback` has no such argument, and mapping one by
//     inference while excluding the other would make the table's evidence
//     grade inconsistent row to row. `queued_notification` has a second
//     reason: claude.md quotes the vendor describing it as a message "the CLI
//     accepts inbound", i.e. daemon -> CLI, so an occurrence on the inbound
//     stream is itself the anomaly the diagnostic exists to surface.
//   - `prompt_suggestion`. claude.md names it as an example of a trailing
//     event that "can arrive after `result`", which is why the driver read
//     loop reads to EOF — but it records neither the frame's container nor its
//     subtype position, so a census row would have to guess between
//     `prompt_suggestion` and `system/prompt_suggestion`.
//   - `set_effort`, `rewind`, and `compact` as control-request subtypes.
//     claude.md's counterexample hunt puts each at count 0 in the registry
//     census. Note that absence is NOT read here as proof of non-existence —
//     the same section states outright that "neither presence nor absence in
//     it may decide a capability", which is exactly why `mcp_set_servers`
//     (censused absent, Verified answering at three builds) IS in the table
//     below and these three, for which no probe answer is recorded, are not.
//
// ---------------------------------------------------------------------------
// Why `artifact_publication` has no Claude producer
// ---------------------------------------------------------------------------
//
// It has none by the corpus's own routing, not for want of a mapping. Row 32
// (`diff`) and row 33 (`command_output`) of the disposition table — the two
// census kinds that carry a file-change capability — both target
// `tool_activity` / `tool.result`. The `files_persisted` discard reason states
// the split in one sentence: the file-change capability is "already carried"
// by those adopted rows "plus `artifact_publication`", i.e. the publication
// family is reached by the daemon's own artifact surface (Plan-014), never by
// a provider frame passing through this seam. A row inventing a Claude
// producer for it would contradict two census rows and one discard reason.
//
// Refs: Plan-005 §Phase 3 / T3.10 (symmetric with T3.5), `Spec-005 §Required Behavior`,
// `docs/reference/provider-wire/claude.md`, `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)`.

import {
  EVENT_DISPOSITION_BY_KIND,
  SESSION_EVENT_TYPES,
  type EventCategory,
  type NormalizedEventKind,
  type ProviderUsageLimitSignal,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import type { DriverDiagnosticRecord, DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import {
  TerminalEmissionGate,
  type TerminalEmissionDecision,
  type TerminalRunFrame,
  type TerminalSuppressionReason,
} from "../../terminal-emission-gate.js";
import type { ChildThreadAnnouncement, ThreadFrameFamilyClass } from "../../thread-frame-router.js";
import {
  UNRECOGNIZED_TURN_EVIDENCE,
  observedTurnEvidence,
  type TurnEvidenceClass,
  type TurnEvidenceClassification,
} from "../outbound-frame.js";

// --------------------------------------------------------------------------
// The wire channel a frame arrives on.
// --------------------------------------------------------------------------

/**
 * Which of Claude's channels carried the frame.
 *
 * `stream` is the stdout stream-json channel (`type: "system"` /
 * `type: "result"`); `control-request` and `control-response` are the two
 * halves of the control channel, both of which claude.md
 * §Control-request registry records.
 *
 * Deliberately NOT a direction axis. The control channel carries traffic both
 * ways under the same `control_request` frame type — `can_use_tool` is a
 * CLI-originated ask, while `interrupt` and `mcp_set_servers` are
 * daemon-originated — and claude.md states the direction in prose for only
 * some subtypes, so a `direction` member would have to be inferred for the
 * rest. Each row's `reason` (or its `interactive_request` target) carries the
 * direction claim instead, at the evidence grade that row actually has.
 *
 * Carried as OUTPUT rather than demanded as input, for the reason the Codex
 * sibling records for its `transport`: the caller has a frame kind off the
 * wire and needs to learn which channel discipline applies. Making it an input
 * would ask the caller to already know the answer.
 */
export type ClaudeWireChannel = "stream" | "control-request" | "control-response";

// --------------------------------------------------------------------------
// The closed census of Claude inbound frame kinds this normalizer maps.
// --------------------------------------------------------------------------

/**
 * The pinned Claude inbound frame-kind census — every server-originated frame
 * the corpus both records by exact name AND settles a normalized disposition
 * for.
 *
 * Each member is the frame's `type` joined to its subtype with `/`, the same
 * `system/init` and `system/api_retry` spelling claude.md itself uses.
 * {@link composeClaudeWireFrameKind} is the only supported way to build one
 * from a live frame; see its docstring for where the subtype sits on each
 * container, which differs by channel.
 *
 * Closed on purpose: a literal union is what makes the backing record's
 * `satisfies` check a compile-time totality proof, so a kind added here
 * without a mapping row (or a row added without a union member) is a build
 * failure rather than a runtime surprise. The exclusions are enumerated in
 * this module's header comment, each with its citation.
 */
export type ClaudeWireFrameKind =
  // Stream channel, `type: "system"`. Six carry a disposition; the nine after
  // them are the "Explicitly-discarded boundary subtypes" table verbatim.
  | "system/init"
  | "system/api_retry"
  | "system/api_error"
  | "system/rate_limit_event"
  | "system/compact_boundary"
  | "system/worker_shutting_down"
  | "system/hook_started"
  | "system/hook_progress"
  | "system/hook_response"
  | "system/notification"
  | "system/files_persisted"
  | "system/tool_use_summary"
  | "system/memory_recall"
  | "system/local_command_output"
  | "system/task_progress"
  // Stream channel, `type: "result"` — the five-member result-subtype census
  // (claude.md §Result and stream surface), dispositioned as a family by
  // `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)`'s Claude delta row.
  | "result/success"
  | "result/error_max_turns"
  | "result/error_max_budget_usd"
  | "result/error_during_execution"
  | "result/error_max_structured_output_retries"
  // Control channel, CLI -> daemon. The fifteen censused subtypes plus
  // `mcp_set_servers`, which the census does not list and three builds answer.
  | "control_request/can_use_tool"
  | "control_request/elicitation"
  | "control_request/request_user_dialog"
  | "control_request/hook_callback"
  | "control_request/mcp_message"
  | "control_request/mcp_set_servers"
  | "control_request/interrupt"
  | "control_request/set_permission_mode"
  | "control_request/set_model"
  | "control_request/get_usage"
  | "control_request/get_context_usage"
  | "control_request/get_session_cost"
  | "control_request/list_models"
  | "control_request/get_binary_version"
  | "control_request/apply_flag_settings"
  | "control_request/rewind_files"
  // Control channel, CLI -> daemon, answering a daemon-originated request.
  | "control_response/success"
  | "control_response/error";

// --------------------------------------------------------------------------
// Emission readiness — the Plan-005 §Campaign B10 Amendment no-silent-loss boundary, made checkable.
// --------------------------------------------------------------------------

/**
 * Whether a normalized row's target type can legally be built into an
 * envelope YET.
 *
 * Plan-006 T1.10's flip-is-not-emission rule and the Plan-005 normalize
 * boundary rule together forbid forcing a frame "into an envelope against a
 * missing type or a missing union variant". Naming a `SessionEventType` is
 * therefore not license to construct one: the target must ALSO have a payload
 * variant registered in `SessionEventSchema`. `payload-variant-pending` rows
 * are inputs to the T3.11 daemon diagnostic, never to an envelope builder.
 */
export type ClaudeEmissionReadiness = "envelope-constructible" | "payload-variant-pending";

/**
 * The `SessionEventType` literals with a registered `SessionEventSchema`
 * payload variant, as a set.
 *
 * Derived from the contracts package's own `SESSION_EVENT_TYPES` roster rather
 * than restated here. That roster is annotated `readonly SessionEvent["type"][]`,
 * which binds its membership to the live schema union at COMPILE time, and
 * contracts' own non-vacuity guard asserts set-equality between the roster and
 * the union's branches. So this set widens by itself the moment an emitting
 * plan lands a variant — the readiness answers below cannot go stale, and no
 * mirror of the registered set exists in this package to drift.
 */
const REGISTERED_PAYLOAD_VARIANT_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set(
  SESSION_EVENT_TYPES,
);

/**
 * Resolve whether `eventType` may be built into a `SessionEvent` envelope
 * today.
 *
 * Pure and total over `SessionEventType`. Exported because it is the single
 * place the boundary rule is decided, and because both answers must be
 * exercised by a test — at the current tree state every Claude target is
 * `payload-variant-pending`, so a test that only ever normalized Claude frames
 * would leave the other answer unproven.
 */
export function resolveClaudeEmissionReadiness(
  eventType: SessionEventType,
): ClaudeEmissionReadiness {
  return REGISTERED_PAYLOAD_VARIANT_EVENT_TYPES.has(eventType)
    ? "envelope-constructible"
    : "payload-variant-pending";
}

// --------------------------------------------------------------------------
// The normalization result — a two-arm discriminated union.
// --------------------------------------------------------------------------

/**
 * A frame that carries a session-timeline capability: it normalizes into
 * exactly one Plan-006 family and names the `SessionEventType` that family
 * emission targets.
 *
 * `normalizedKind` is the row's kind in the closed 35-kind
 * `NormalizedEventKind` census, or `null` for a Claude delta-family member the
 * census does not name. `null` is a real state rather than a defect:
 * `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)` says of `worker_shutting_down`
 * verbatim that it is "wire-layer rather than a T1.8 registry key", so a
 * non-null kind would have to be invented for it. `eventType` is total either
 * way, which is what downstream consumers actually key on.
 *
 * `emissionReadiness` carries the Plan-005 boundary answer alongside the
 * target so a consumer cannot read `eventType` without also being handed the
 * question of whether it may build one. See {@link ClaudeEmissionReadiness}.
 *
 * Every property is `readonly` and every entry is frozen — the resolver hands
 * out module-level shared singletons, so an unfrozen entry would let one
 * consumer's `entry.family = ...` corrupt the mapping process-wide (the same
 * reasoning `packages/contracts/src/event.ts` records for
 * `EventKindDisposition`).
 */
export interface ClaudeNormalizedFamilyEmission {
  readonly disposition: "normalized";
  readonly frameKind: ClaudeWireFrameKind;
  readonly channel: ClaudeWireChannel;
  readonly family: EventCategory;
  readonly eventType: SessionEventType;
  readonly normalizedKind: NormalizedEventKind | null;
  readonly emissionReadiness: ClaudeEmissionReadiness;
}

/**
 * A frame the pin records, that carries no session-timeline capability, and
 * that therefore normalizes to no family at all.
 *
 * The mandatory non-empty `reason` mirrors the `correlate` / `discard` idiom
 * in `EVENT_DISPOSITION_BY_KIND`: under the Plan-006 no-silent-capability-loss
 * default, a non-emission is admissible only with a stated justification, so
 * the type makes an unreasoned one unrepresentable. The `?: never` keys forbid
 * a not-evented row from smuggling a taxonomy target.
 *
 * This is NOT the unknown-frame path — an unknown kind throws (see
 * {@link UnknownClaudeWireFrameError}). It is the path for a KNOWN frame whose
 * record the daemon already owns, or whose capability another census row
 * already carries.
 */
export interface ClaudeNotEventedFrameDisposition {
  readonly disposition: "not-evented";
  readonly frameKind: ClaudeWireFrameKind;
  readonly channel: ClaudeWireChannel;
  readonly reason: string;
  readonly family?: never;
  readonly eventType?: never;
  readonly normalizedKind?: never;
  readonly emissionReadiness?: never;
}

/** The total result of normalizing one pinned Claude inbound frame kind. */
export type ClaudeFrameNormalization =
  | ClaudeNormalizedFamilyEmission
  | ClaudeNotEventedFrameDisposition;

/**
 * A row of the mapping table BEFORE `emissionReadiness` is derived onto it.
 *
 * The readiness answer is computed once when the lookup map is built, from the
 * live `SESSION_EVENT_TYPES` roster, so no row may hand-state it: a stated
 * answer would be a second source of truth for a fact contracts already owns,
 * and it would go stale silently the moment an emitting plan landed a payload
 * variant. Splitting the row type from the result type is what makes that
 * unstateable rather than merely discouraged.
 */
type ClaudeFrameNormalizationTableRow =
  | Omit<ClaudeNormalizedFamilyEmission, "emissionReadiness">
  | ClaudeNotEventedFrameDisposition;

// --------------------------------------------------------------------------
// Unknown-frame refusal — the single T3.11 seam.
// --------------------------------------------------------------------------

/**
 * Thrown when a Claude inbound frame kind resolves to no census row.
 *
 * The typed carrier (rather than a bare `Error`) is what lets Plan-005 T3.11
 * replace the refusal with a `DriverDiagnosticRecord` without inspecting a
 * message string: `frameKind` is already the `rawWireType` that record needs.
 * The verbatim kind is preserved rather than sanitized — it is untrusted
 * provider output, so it is carried as data and never interpolated into
 * anything that executes.
 *
 * Discrimination is by CLASS IDENTITY plus `frameKind`, and deliberately NOT
 * by a dotted `code` member — the twin `UnknownCodexInboundFrameError` carries
 * none either. `error-contracts.md` §Driver is a closed census of seven
 * `driver.*` codes, so minting an eighth here would register a wire code in
 * code that no contract doc declares, and this refusal rides no error envelope
 * at all: T3.11 converts it into a daemon diagnostic record, which keys on
 * `frameKind`. The `code` members on the error classes in
 * `../../provider-registry.ts` are not a counter-precedent — each of those
 * names a code the §Driver registry actually lists.
 */
export class UnknownClaudeWireFrameError extends Error {
  readonly frameKind: string;

  constructor(frameKind: string) {
    super(
      `Unmapped Claude inbound frame kind: ${JSON.stringify(frameKind)}. ` +
        "The pinned census does not cover it; the daemon diagnostic default branch " +
        "replaces this refusal on the routed normalize path.",
    );
    this.name = "UnknownClaudeWireFrameError";
    this.frameKind = frameKind;
  }
}

// --------------------------------------------------------------------------
// The mapping table.
// --------------------------------------------------------------------------

// A `satisfies Record<ClaudeWireFrameKind, ClaudeFrameNormalization>` check on
// a plain object literal, and NOT a `switch`. The record proves totality more
// strongly than a switch's `never` guard does — a missing key fails the build
// at the record, whereas a missing switch case only fails if every other arm
// returns, and excess-property checking rejects a row whose key left the union.
// It also keeps this file structurally identical to its T3.5 sibling, which
// Plan-005 pairs it with. The T3.11 default-branch swap is a one-body edit to
// `refuseUnmappedClaudeWireFrame` below rather than a restructure of a
// dispatch, which is the property that mattered.
//
// `emissionReadiness` is deliberately absent from the literals: it is derived
// per row when the lookup map is built, so no row can hand-state an answer
// that contradicts the live `SessionEventSchema` registration.
const CLAUDE_FRAME_NORMALIZATION_RECORD = {
  // ------------------------------------------------------------------
  // Stream channel, `type: "system"` — the six dispositioned subtypes.
  // ------------------------------------------------------------------

  // Census row 1: "`init` ... adopt `run_lifecycle` (run-start marker) — type
  // `run.provider_initialized`". The same row pins the limit of this mapping:
  // "the daemon's `run.*` state transitions stay daemon-emitted, not
  // provider-init-mapped", so this is a forward marker, not a state change.
  "system/init": {
    disposition: "normalized",
    frameKind: "system/init",
    channel: "stream",
    family: "run_lifecycle",
    eventType: "run.provider_initialized",
    normalizedKind: "init",
  },
  // Census row 18 plus the Claude delta row that enriches it: the typed-error
  // enum "enriches census row 18's `api_retry` kind — the same kind, not a
  // distinct one". The enum members themselves are carried verbatim by the
  // payload layer, never validated against a closed set here: claude.md marks
  // that union's arity Derived, "since a string census cannot prove a set is
  // closed", so rejecting an unrecognized member would fail closed on a set
  // the evidence cannot close.
  "system/api_retry": {
    disposition: "normalized",
    frameKind: "system/api_retry",
    channel: "stream",
    family: "usage_telemetry",
    eventType: "usage.api_retry",
    normalizedKind: "api_retry",
  },
  // claude.md §Result and stream surface states the mapping arm verbatim:
  // "the mapping arm is `system/api_error` -> `system/api_retry`". Same
  // destination as the row above by the reference's own equation, not by
  // this file's inference.
  "system/api_error": {
    disposition: "normalized",
    frameKind: "system/api_error",
    channel: "stream",
    family: "usage_telemetry",
    eventType: "usage.api_retry",
    normalizedKind: "api_retry",
  },
  // Census row 20 is the only RENAME in the table, and it names this wire
  // string explicitly: "the Claude wire string `rate_limit_event` renames onto
  // `rate_limits`: an account-plane quota snapshot, never context-window
  // telemetry". claude.md adds why it is the preferred carrier: it is a push
  // channel that "does not require the experimental `get_usage` round trip".
  "system/rate_limit_event": {
    disposition: "normalized",
    frameKind: "system/rate_limit_event",
    channel: "stream",
    family: "usage_telemetry",
    eventType: "usage.rate_limit_update",
    normalizedKind: "rate_limits",
  },
  // Census row 19: provider context-window compaction, "distinct from the
  // daemon `event.compacted` retention pass".
  "system/compact_boundary": {
    disposition: "normalized",
    frameKind: "system/compact_boundary",
    channel: "stream",
    family: "usage_telemetry",
    eventType: "usage.context_compacted",
    normalizedKind: "compact_boundary",
  },
  // Claude delta row: "`worker_shutting_down` ... adopt `run_lifecycle`
  // diagnostic (mid-run worker-shutdown recovery signal — capability-bearing)
  // — type `run.worker_shutdown` ... wire-layer rather than a T1.8 registry
  // key". Hence `normalizedKind: null`: the corpus assigns it a category and a
  // type but deliberately no census kind. The container is the system channel
  // by its siblings in the same delta table; if it turns out to ride another
  // container, the composed kind misses this row and reaches the T3.11 seam,
  // which is loud rather than silent.
  "system/worker_shutting_down": {
    disposition: "normalized",
    frameKind: "system/worker_shutting_down",
    channel: "stream",
    family: "run_lifecycle",
    eventType: "run.worker_shutdown",
    normalizedKind: null,
  },

  // ------------------------------------------------------------------
  // Stream channel, `type: "system"` — the nine explicitly-discarded
  // boundary subtypes. Reasons are the disposition table's own, quoted
  // rather than paraphrased so a re-read of that table is a diff.
  // ------------------------------------------------------------------

  "system/hook_started": {
    disposition: "not-evented",
    frameKind: "system/hook_started",
    channel: "stream",
    reason:
      "hook-lifecycle progress; hook execution is daemon-internal orchestration, not an audit-timeline capability",
  },
  "system/hook_progress": {
    disposition: "not-evented",
    frameKind: "system/hook_progress",
    channel: "stream",
    reason: "intra-hook progress; same daemon-internal-orchestration reason",
  },
  "system/hook_response": {
    disposition: "not-evented",
    frameKind: "system/hook_response",
    channel: "stream",
    reason: "hook result consumed by the hook dispatcher, not a timeline capability",
  },
  "system/notification": {
    disposition: "not-evented",
    frameKind: "system/notification",
    channel: "stream",
    reason:
      "distinct from the census `notification` kind (row 17, Codex-fed); the user-facing-notice capability is already carried there — this Claude system subtype is redundant transport noise",
  },
  "system/files_persisted": {
    disposition: "not-evented",
    frameKind: "system/files_persisted",
    channel: "stream",
    reason:
      "file-write summary; the adopted `diff` (32) / `command_output` (33) rows plus `artifact_publication` already carry the file-change capability",
  },
  "system/tool_use_summary": {
    disposition: "not-evented",
    frameKind: "system/tool_use_summary",
    channel: "stream",
    reason:
      "aggregate over the adopted `tool_start` (3) / `tool_complete` (4) rows; no new capability",
  },
  "system/memory_recall": {
    disposition: "not-evented",
    frameKind: "system/memory_recall",
    channel: "stream",
    reason: "provider-internal memory-retrieval signal; no audit-timeline capability",
  },
  "system/local_command_output": {
    disposition: "not-evented",
    frameKind: "system/local_command_output",
    channel: "stream",
    reason:
      "superseded by the adopted `command_output` (33) kind; the local variant carries no additional capability",
  },
  "system/task_progress": {
    disposition: "not-evented",
    frameKind: "system/task_progress",
    channel: "stream",
    reason:
      "intra-task progress; the adopted `task_create` (15) / `task_update` (16) + `todo_update` snapshots carry the durable task state",
  },

  // ------------------------------------------------------------------
  // Stream channel, `type: "result"` — the five-member result-subtype
  // family. The Claude delta row disposes the whole family into the
  // `run_lifecycle` terminal; the split below between the success and the
  // four failure subtypes is the census's own, via row 6 (`turn_complete`
  // -> `run.completed`) and row 13 (`error` -> `run.failed`).
  //
  // Reading a result frame does NOT end the driver's read loop: claude.md
  // records that trailing events "can arrive after `result`, so the driver
  // read-loop reads to EOF rather than breaking on `result`". That is the
  // read loop's obligation (T3.9), not this table's, but it is the reason
  // no row here is marked terminal-for-the-stream.
  // ------------------------------------------------------------------

  "result/success": {
    disposition: "normalized",
    frameKind: "result/success",
    channel: "stream",
    family: "run_lifecycle",
    eventType: "run.completed",
    normalizedKind: "turn_complete",
  },
  "result/error_max_turns": {
    disposition: "normalized",
    frameKind: "result/error_max_turns",
    channel: "stream",
    family: "run_lifecycle",
    eventType: "run.failed",
    normalizedKind: "error",
  },
  "result/error_max_budget_usd": {
    disposition: "normalized",
    frameKind: "result/error_max_budget_usd",
    channel: "stream",
    family: "run_lifecycle",
    eventType: "run.failed",
    normalizedKind: "error",
  },
  "result/error_during_execution": {
    disposition: "normalized",
    frameKind: "result/error_during_execution",
    channel: "stream",
    family: "run_lifecycle",
    eventType: "run.failed",
    normalizedKind: "error",
  },
  "result/error_max_structured_output_retries": {
    disposition: "normalized",
    frameKind: "result/error_max_structured_output_retries",
    channel: "stream",
    family: "run_lifecycle",
    eventType: "run.failed",
    normalizedKind: "error",
  },

  // ------------------------------------------------------------------
  // Control channel, CLI -> daemon. Three of the sixteen are asks aimed at
  // the human and therefore carry an `interactive_request` capability; the
  // rest are answered by the driver's control dispatcher (T3.8) and reach
  // no timeline.
  // ------------------------------------------------------------------

  // Census row 7: "`approval_request` ... adopt `interactive_request`
  // (`driver_ask.requested`, permission ask)". claude.md states this
  // subtype's direction outright — it "remains the `--permission-prompt-tool`
  // plumbing (`{tool_name, input}` -> `{behavior: allow | deny, ...}`)", i.e.
  // the CLI asks and the daemon answers.
  "control_request/can_use_tool": {
    disposition: "normalized",
    frameKind: "control_request/can_use_tool",
    channel: "control-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "approval_request",
  },
  // Census row 9: "`user_input_request` ... adopt `interactive_request`
  // (`driver_ask.requested`, input ask)". Both subtypes below are input asks
  // by the registry's own naming; claude.md does not state their direction in
  // prose, so the direction is Derived from the subtype name rather than
  // Verified. Recorded here because that is the grade a reviewer needs: if a
  // later probe shows either to be daemon-originated, the row moves to
  // not-evented beside `interrupt` and nothing else changes.
  "control_request/elicitation": {
    disposition: "normalized",
    frameKind: "control_request/elicitation",
    channel: "control-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "user_input_request",
  },
  "control_request/request_user_dialog": {
    disposition: "normalized",
    frameKind: "control_request/request_user_dialog",
    channel: "control-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "user_input_request",
  },
  // The Claude delta table disposes the whole hook family `discard`, "hook
  // -lifecycle; daemon-internal orchestration, not an audit-timeline
  // capability (consistent with the `hook_*` discards above)". This is the
  // control-channel member of that family.
  "control_request/hook_callback": {
    disposition: "not-evented",
    frameKind: "control_request/hook_callback",
    channel: "control-request",
    reason:
      "hook family, disposed `discard` by `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)`: hook-lifecycle, daemon-internal orchestration, not an audit-timeline capability",
  },
  "control_request/mcp_message": {
    disposition: "not-evented",
    frameKind: "control_request/mcp_message",
    channel: "control-request",
    reason:
      "MCP transport passthrough between the CLI and a configured server; the MCP governance surface is owned by Spec-028 / Plan-028 and events its own decisions (`mcp.*`), so relaying the transport frame would double-record a plane the daemon already audits",
  },
  // Censused ABSENT yet Verified answering at 2.1.234 / 2.1.245 / 2.1.246
  // (claude.md: "a subtype absent from the census above may still answer").
  // It is in this union because it demonstrably dispatches; it is not-evented
  // because the daemon is the party that sends it.
  "control_request/mcp_set_servers": {
    disposition: "not-evented",
    frameKind: "control_request/mcp_set_servers",
    channel: "control-request",
    reason:
      "daemon-originated live server-set reconcile; the driver's control dispatcher owns the round trip and the resulting server-set change is already evented by the Plan-028 MCP governance surface",
  },
  "control_request/interrupt": {
    disposition: "not-evented",
    frameKind: "control_request/interrupt",
    channel: "control-request",
    reason:
      "daemon-originated control request; the intervention that caused it is already evented by the Plan-004 intervention surface, and the driver's control dispatcher owns the request/response round trip",
  },
  "control_request/set_permission_mode": {
    disposition: "not-evented",
    frameKind: "control_request/set_permission_mode",
    channel: "control-request",
    reason:
      "daemon-originated control request; execution posture is daemon-owned and evented when the daemon applies it, so relaying the request would double-record a mutation the daemon authored",
  },
  "control_request/set_model": {
    disposition: "not-evented",
    frameKind: "control_request/set_model",
    channel: "control-request",
    reason:
      "daemon-originated control request; the agent-configuration change it carries is evented by the daemon that applied it, not by the wire frame that requested it",
  },
  "control_request/get_usage": {
    disposition: "not-evented",
    frameKind: "control_request/get_usage",
    channel: "control-request",
    reason:
      "daemon-originated read of the experimental usage surface; its ANSWER is what carries telemetry, and the push carrier `system/rate_limit_event` is the preferred source where both are available",
  },
  "control_request/get_context_usage": {
    disposition: "not-evented",
    frameKind: "control_request/get_context_usage",
    channel: "control-request",
    reason:
      "daemon-originated read; the request carries no observation, and the context-window telemetry its answer yields reaches the timeline through the driver's own usage emission",
  },
  "control_request/get_session_cost": {
    disposition: "not-evented",
    frameKind: "control_request/get_session_cost",
    channel: "control-request",
    reason:
      "daemon-originated read; cost reaches the timeline through the driver's `usage.cost_update` emission, never through the request that polled for it",
  },
  "control_request/list_models": {
    disposition: "not-evented",
    frameKind: "control_request/list_models",
    channel: "control-request",
    reason: "daemon-originated capability discovery; a discovery read is not a timeline capability",
  },
  "control_request/get_binary_version": {
    disposition: "not-evented",
    frameKind: "control_request/get_binary_version",
    channel: "control-request",
    reason:
      "daemon-originated version read; the reported CLI version is persisted on the binding record at the Plan-005 Phase-2 write seam, not evented",
  },
  "control_request/apply_flag_settings": {
    disposition: "not-evented",
    frameKind: "control_request/apply_flag_settings",
    channel: "control-request",
    reason:
      "daemon-originated settings push; the daemon authored the settings and its typed refusal is classified by the control dispatcher, so neither half is a provider observation",
  },
  "control_request/rewind_files": {
    disposition: "not-evented",
    frameKind: "control_request/rewind_files",
    channel: "control-request",
    reason:
      "daemon-originated file-side rewind; the rollback that drove it is evented by the Plan-004 intervention surface, and claude.md records that a cloud-hosted session refuses this subtype outright, which is a dispatcher classification rather than a timeline row",
  },

  // ------------------------------------------------------------------
  // Control channel, CLI -> daemon, answering a daemon-originated request.
  // claude.md records both arms of the envelope: the error arm as
  // `{ type: "control_response", response: { subtype: "error", request_id,
  // error } }`, and a success arm whose body it reproduces verbatim for
  // `mcp_set_servers` (carried in `__fixtures__/`).
  // ------------------------------------------------------------------

  "control_response/success": {
    disposition: "not-evented",
    frameKind: "control_response/success",
    channel: "control-response",
    reason:
      "answer to a daemon-originated control request, correlated by `request_id`; the control dispatcher resolves the pending call and whatever the answer authorizes is evented by the surface that acted on it",
  },
  "control_response/error": {
    disposition: "not-evented",
    frameKind: "control_response/error",
    channel: "control-response",
    reason:
      "typed control-channel refusal, correlated by `request_id`; claude.md requires every control request be feature-detected at call time by classifying this arm, which makes it a capability signal for the dispatcher rather than a timeline row",
  },
} as const satisfies Record<ClaudeWireFrameKind, ClaudeFrameNormalizationTableRow>;

// --------------------------------------------------------------------------
// Exported census + lookup.
// --------------------------------------------------------------------------

/**
 * The census as an iterable tuple — the same affordance
 * `NORMALIZED_EVENT_KINDS` gives over `NormalizedEventKind`.
 *
 * Derived from the record's own keys rather than restated, so a tuple / union
 * drift is impossible by construction (the `satisfies` check above already
 * proves the record's keys ARE the union). The explicit annotation keeps the
 * export `--isolatedDeclarations`-clean.
 */
export const CLAUDE_WIRE_FRAME_KINDS: readonly ClaudeWireFrameKind[] = Object.freeze(
  Object.keys(CLAUDE_FRAME_NORMALIZATION_RECORD) as ClaudeWireFrameKind[],
);

/**
 * The Claude native frame-kind -> normalized-family mapping, as a
 * prototype-pollution-safe `ReadonlyMap`.
 *
 * A `Map` and NOT the backing object literal, for the reason
 * `packages/contracts/src/event.ts` records at
 * `SESSION_EVENT_CATEGORY_BY_TYPE`: this module's key is composed from
 * untrusted provider-supplied strings, and `lookup["__proto__"]` /
 * `lookup["constructor"]` on an object literal return truthy non-values,
 * whereas `map.get(...)` returns `undefined` for anything but an explicit
 * entry. Here that immunity decides whether a hostile frame kind reaches the
 * timeline as a fabricated normalization or reaches the unknown seam.
 *
 * Entries are frozen singletons, so repeated resolution of one kind is
 * identity-stable — the property the determinism test asserts. The
 * `emissionReadiness` member is derived here, once, from the live registered
 * set rather than hand-stated per row.
 */
export const CLAUDE_FRAME_NORMALIZATION_BY_KIND: ReadonlyMap<
  ClaudeWireFrameKind,
  ClaudeFrameNormalization
> = new Map(
  // Cast justified by the `satisfies` check above: the record's own enumerable
  // keys are exactly the `ClaudeWireFrameKind` literals (totality +
  // excess-property checks), so narrowing `Object.entries`' `[string, ...]` is
  // sound.
  (
    Object.entries(CLAUDE_FRAME_NORMALIZATION_RECORD) as ReadonlyArray<
      [ClaudeWireFrameKind, ClaudeFrameNormalizationTableRow]
    >
  ).map(([frameKind, normalization]) => [
    frameKind,
    Object.freeze(
      normalization.disposition === "normalized"
        ? {
            ...normalization,
            emissionReadiness: resolveClaudeEmissionReadiness(normalization.eventType),
          }
        : normalization,
    ),
  ]),
);

/**
 * Compose the census key for a live frame from its `type` and its subtype.
 *
 * Pure string composition, deliberately: this function does NOT walk a frame
 * object, because the subtype does not sit in one place across Claude's
 * channels and claude.md records only some of those positions. Making the
 * caller supply both halves keeps the position knowledge at the driver core
 * (T3.6 / T3.9), which reads the frame, instead of encoding an assumed
 * traversal here.
 *
 * The positions the reference DOES record, for the caller's benefit:
 *   - `type: "system"` / `type: "result"` — subtype at the frame's own
 *     `subtype` (claude.md writes these as `system/init`, `system/api_retry`).
 *   - `type: "control_response"` — subtype at `response.subtype`, per the
 *     recorded envelope `{ type: "control_response", response: { subtype:
 *     "error", request_id, error } }`.
 *   - `type: "control_request"` — the registry names the subtypes; the
 *     request body carries them.
 *
 * A `null` subtype yields the bare `type`, which is in the census for no kind
 * today and therefore reaches the T3.11 seam rather than silently matching.
 *
 * @param frameType - The frame's `type`, verbatim off the wire. Untrusted.
 * @param subtype - The frame's subtype, verbatim off the wire, or `null` when
 *   the frame carries none. Untrusted.
 */
export function composeClaudeWireFrameKind(frameType: string, subtype: string | null): string {
  return subtype === null ? frameType : `${frameType}/${subtype}`;
}

/**
 * The bare resolver's refusal for a kind outside the census.
 *
 * T3.11 landed the daemon-diagnostic default branch as
 * {@link resolveClaudeFrameEmissionRoute} below — the driver core's entry
 * point, which converts this refusal into a typed `DriverDiagnosticRecord`
 * onto `driver-diagnostics.ts` and never throws. THIS function remains the
 * bare resolver's contract for direct misuse: a caller that bypasses the
 * diagnostic-aware route must still fail loudly rather than silently.
 */
function refuseUnmappedClaudeWireFrame(frameKind: string): never {
  throw new UnknownClaudeWireFrameError(frameKind);
}

/**
 * Normalize one Claude inbound frame kind into its Plan-006 family
 * disposition.
 *
 * Total over the pinned census and pure: no I/O, no clock, no mutation, and
 * the same input always yields the identical frozen singleton. A kind outside
 * the census throws {@link UnknownClaudeWireFrameError} — never a silent drop,
 * and never a fabricated family.
 *
 * Fail-open vs fail-closed, per the Plan-005 normalize-boundary rule: THIS
 * function is the fail-OPEN half. It is reached only once the frame's bytes
 * have already parsed into a wire message, so its unknown path routes the
 * frame onward to the diagnostic. Bytes that do not parse as a valid provider
 * wire message fail CLOSED at the read loop (T3.9) and never reach here — a
 * malformed frame must not be turned into a partial event by composing a kind
 * out of whatever fields survived.
 *
 * @param frameKind - The composed `type/subtype` key, ideally from
 *   {@link composeClaudeWireFrameKind}. Untrusted provider output: it is used
 *   only as a `Map` key and echoed into the refusal as data.
 */
export function normalizeClaudeWireFrame(frameKind: string): ClaudeFrameNormalization {
  const normalization = CLAUDE_FRAME_NORMALIZATION_BY_KIND.get(frameKind as ClaudeWireFrameKind);
  if (normalization === undefined) {
    refuseUnmappedClaudeWireFrame(frameKind);
  }
  return normalization;
}

// --------------------------------------------------------------------------
// Family reachability ledger.
// --------------------------------------------------------------------------

/**
 * One family's reachability answer: either the frame kinds that reach it, or a
 * stated reason no pinned Claude frame does.
 *
 * The ledger exists because "totality over the six families" is otherwise
 * unfalsifiable prose. Half the families have no Claude producer at this pin,
 * and the difference between "we forgot" and "the corpus routes it elsewhere"
 * is the entire value of the record — so `unreachedCensusKinds` names the
 * specific 35-kind census members left unfed, which is what tells the next
 * wire probe what to look for.
 */
export interface ClaudeFamilyReachability {
  readonly family: EventCategory;
  /** Frame kinds in the census that normalize into this family. May be empty. */
  readonly reachedBy: readonly ClaudeWireFrameKind[];
  /**
   * Census kinds in this family that no pinned Claude frame kind feeds, with
   * the reason. Empty for a family with no shortfall.
   */
  readonly unreachedCensusKinds: readonly NormalizedEventKind[];
  /** Why the shortfall exists, or `null` when there is none. */
  readonly shortfallReason: string | null;
}

/**
 * The six `Spec-005 §Required Behavior` normalized families, each with its
 * reachability answer at this pin.
 *
 * Total over those six by construction and asserted so by the test suite. It
 * is NOT a claim that the normalizer only ever emits into six categories — the
 * 35-kind census routes some kinds into `session_lifecycle` and
 * `approval_flow`, which are outside this ledger's scope by design.
 *
 * `reachedBy` is stated rather than computed so that the ledger and the
 * mapping table are two independent statements; the test asserts they agree,
 * which is what makes a silent divergence a build failure instead of a
 * comment that went stale.
 */
export const CLAUDE_FAMILY_REACHABILITY: readonly ClaudeFamilyReachability[] = Object.freeze([
  Object.freeze({
    family: "run_lifecycle",
    reachedBy: Object.freeze([
      "system/init",
      "system/worker_shutting_down",
      "result/success",
      "result/error_max_turns",
      "result/error_max_budget_usd",
      "result/error_during_execution",
      "result/error_max_structured_output_retries",
    ] as const),
    unreachedCensusKinds: Object.freeze(["turn_start", "session_status"] as const),
    shortfallReason:
      "`turn_start` (census row 5) would ride a Claude stream-json message frame, whose shape claude.md §Gaps records as unobservable without credentials; `session_status` (row 11) is routed to `session_lifecycle`, outside this ledger's six families, and carries the no-fabricated-transition rule besides",
  }),
  Object.freeze({
    family: "usage_telemetry",
    reachedBy: Object.freeze([
      "system/api_retry",
      "system/api_error",
      "system/rate_limit_event",
      "system/compact_boundary",
    ] as const),
    unreachedCensusKinds: Object.freeze(["token_usage", "model_rerouted"] as const),
    shortfallReason:
      "`token_usage` (census row 12) rides a stream-json message frame the pin cannot observe; `model_rerouted` (row 21) has a plausible Claude carrier in the `model_refusal_fallback` / `model_refusal_no_fallback` pair, but claude.md records that pair only as adjacent subtypes present at the pin (2026-08-25) and no disposition table covers it, so both are excluded uniformly rather than one mapped by inference",
  }),
  Object.freeze({
    family: "interactive_request",
    reachedBy: Object.freeze([
      "control_request/can_use_tool",
      "control_request/elicitation",
      "control_request/request_user_dialog",
    ] as const),
    unreachedCensusKinds: Object.freeze(["user_input_resolved"] as const),
    shortfallReason:
      "`user_input_resolved` (census row 10) records the daemon's own answer to an ask, so the resolution is emitted by the surface that answered rather than observed on an inbound frame; census row 8 (`approval_resolved`) routes to `approval_flow`, outside this ledger's six families",
  }),
  Object.freeze({
    family: "assistant_output",
    reachedBy: Object.freeze([] as const),
    unreachedCensusKinds: Object.freeze([
      "text_delta",
      "thinking",
      "proposed_plan",
      "content_block_start",
      "content_block_stop",
    ] as const),
    shortfallReason:
      "every one of these rides a Claude `assistant` stream-json message frame, and claude.md §Gaps records that no authless protocol probe exists for this provider, so the reference pins no discriminant for those frames; `content_block_start` / `content_block_stop` are `discard` rows besides (census rows 23-24). Closing this family is a wire-reference obligation (an authenticated-leg probe), not a mapping obligation",
  }),
  Object.freeze({
    family: "tool_activity",
    reachedBy: Object.freeze([] as const),
    unreachedCensusKinds: Object.freeze([
      "tool_start",
      "tool_complete",
      "todo_update",
      "task_create",
      "task_update",
      "background_task_terminal",
      "background_task_notification",
      "diff",
      "command_output",
    ] as const),
    shortfallReason:
      "same unobservable `assistant` / `user` message frames as `assistant_output`; the Claude plugin delta family is dispositioned into this category by `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)` but claude.md records no wire string for any plugin frame, so no row can name one. The two Claude subagent-lifecycle kinds that DO land here (`SubagentStart` / `SubagentStop` -> `subagent.started` / `subagent.completed`) arrive through the T3.11 subagent-lifecycle band (`normalizeClaudeSubagentLifecycle`) rather than through this census, whose rows carry only reference-recorded kinds",
  }),
  Object.freeze({
    family: "artifact_publication",
    reachedBy: Object.freeze([] as const),
    unreachedCensusKinds: Object.freeze([] as const),
    shortfallReason:
      "no census kind targets this family at all, for either provider. The two kinds carrying a file-change capability, `diff` (row 32) and `command_output` (row 33), are both routed to `tool_activity` / `tool.result`, and the `files_persisted` discard reason states that the capability is carried by those rows plus `artifact_publication` — i.e. publication is reached by the daemon's own artifact surface (Plan-014), never by a provider frame crossing this seam. There are no unreached census kinds here because there are no candidate kinds",
  }),
]);

// --------------------------------------------------------------------------
// T3.11 — the daemon-diagnostic default branch (P0-1).
// --------------------------------------------------------------------------

/** The census-mapped emission answer, or the frame's routed diagnostic. */
export type ClaudeFrameEmissionRoute =
  | { readonly route: "emit"; readonly normalization: ClaudeNormalizedFamilyEmission }
  | { readonly route: "not-evented"; readonly normalization: ClaudeNotEventedFrameDisposition }
  | { readonly route: "diagnostic"; readonly record: DriverDiagnosticRecord };

/**
 * The T3.11 P0-1 default branch — the driver core's entry point onto this
 * table. Total over EVERY composed frame kind and never throws: a kind
 * outside the pinned census, an interim `typePending` kind whose literal has
 * not landed, and a censused kind whose target has no registered payload
 * variant all route to a typed `DriverDiagnosticRecord` emitted through the
 * injected `driver-diagnostics.ts` surface — never a `session_events`
 * envelope and never a silent drop. `EVENT_DISPOSITION_BY_KIND` is the single
 * disposition source consulted for the interim-`typePending` verdict (the
 * Plan-006 T1.8 interim-disposition seam).
 */
export function resolveClaudeFrameEmissionRoute(
  frameKind: string,
  diagnostics: DriverDiagnosticsEmitter,
): ClaudeFrameEmissionRoute {
  const normalization = CLAUDE_FRAME_NORMALIZATION_BY_KIND.get(frameKind as ClaudeWireFrameKind);
  if (normalization === undefined) {
    const record: DriverDiagnosticRecord = {
      provider: "claude",
      kind: "unmapped_wire_kind",
      rawWireType: frameKind,
      dispositionReason:
        "wire kind outside the pinned Claude inbound census; routed to the daemon diagnostic default branch, never silently dropped and never forced into an envelope",
      details: {},
    };
    diagnostics.emit(record);
    return { route: "diagnostic", record };
  }
  if (normalization.disposition === "not-evented") {
    return { route: "not-evented", normalization };
  }
  if (normalization.normalizedKind !== null) {
    const registryDisposition = EVENT_DISPOSITION_BY_KIND.get(normalization.normalizedKind);
    if (registryDisposition !== undefined && registryDisposition.typePending !== undefined) {
      const record: DriverDiagnosticRecord = {
        provider: "claude",
        kind: "unmapped_wire_kind",
        rawWireType: frameKind,
        dispositionReason:
          "interim typePending kind whose SessionEventType literal has not landed; routed to the diagnostic branch until the census amendment lands its literal",
        details: { normalizedKind: normalization.normalizedKind },
      };
      diagnostics.emit(record);
      return { route: "diagnostic", record };
    }
  }
  if (normalization.emissionReadiness === "payload-variant-pending") {
    const record: DriverDiagnosticRecord = {
      provider: "claude",
      kind: "payload_variant_pending",
      rawWireType: frameKind,
      dispositionReason:
        "censused kind whose target SessionEventType has no registered SessionEventSchema payload variant; envelope construction is forbidden without one, so the frame routes to the diagnostic branch",
      details: { eventType: normalization.eventType },
    };
    diagnostics.emit(record);
    return { route: "diagnostic", record };
  }
  return { route: "emit", normalization };
}

// --------------------------------------------------------------------------
// T3.11 — subagent-lifecycle normalization (NS-91 + the B10 subagent leg).
// --------------------------------------------------------------------------

/**
 * The two Claude subagent-lifecycle signals, arriving in the PARENT's own
 * stream with `parent_tool_use_id` on them. Deliberately outside the census
 * union above: the census carries only kinds the version-pinned reference
 * records, and claude.md §Gaps records the message-frame surface as
 * unobservable without credentials — these two are claimed by name by
 * Plan-005 T3.11 ("Claude `SubagentStart` / `SubagentStop` normalize into
 * `subagent.started` / `subagent.completed` ... carrying `parent_tool_use_id`
 * copied verbatim"), which is their corpus record.
 */
export const CLAUDE_SUBAGENT_START_SIGNAL = "SubagentStart" as const;
export const CLAUDE_SUBAGENT_STOP_SIGNAL = "SubagentStop" as const;

/** One Claude subagent-lifecycle signal, as the driver core read it. */
export interface ClaudeSubagentLifecycleSignal {
  /**
   * Derived from the two wire-name constants rather than re-spelled, so a wire
   * rename is a compile error at every reader instead of a silently
   * never-matching comparison.
   */
  readonly signal: typeof CLAUDE_SUBAGENT_START_SIGNAL | typeof CLAUDE_SUBAGENT_STOP_SIGNAL;
  /** The provider-attributed subagent identity, verbatim off the wire. */
  readonly subagentId: string;
  /** `parent_tool_use_id`, copied verbatim so the subagent tree pairs. */
  readonly parentToolUseId: string | null;
}

/** The normalized subagent-lifecycle emission plus its router registration. */
export interface ClaudeSubagentLifecycleNormalization {
  readonly family: EventCategory;
  readonly eventType: SessionEventType;
  readonly subagentId: string;
  readonly parentToolUseId: string | null;
  /**
   * The parent-linked announcement the thread-frame router registers a
   * `SubagentStart` under — the arrival in the parent's OWN stream is the
   * declared lineage, so the announcement names the session's own thread as
   * parent. `null` for a `SubagentStop`, which completes an existing
   * registration rather than creating one.
   */
  readonly announcement: ChildThreadAnnouncement | null;
}

/**
 * Normalize one Claude subagent-lifecycle signal into its `subagent.started`
 * / `subagent.completed` emission (`tool_activity`, provider-attributed,
 * Spec-006 B1) and, for a start, the router announcement that registers the
 * child ahead of the refusal rule. The subagent identity doubles as the child
 * thread identity — Claude multiplexes children over the parent stream with
 * no thread-id member, so the provider-attributed subagent id IS the child's
 * identity axis.
 */
export function normalizeClaudeSubagentLifecycle(
  lifecycleSignal: ClaudeSubagentLifecycleSignal,
  sessionThreadId: string,
): ClaudeSubagentLifecycleNormalization {
  if (lifecycleSignal.signal === CLAUDE_SUBAGENT_START_SIGNAL) {
    return Object.freeze({
      family: "tool_activity",
      eventType: "subagent.started",
      subagentId: lifecycleSignal.subagentId,
      parentToolUseId: lifecycleSignal.parentToolUseId,
      announcement: Object.freeze({
        childThreadId: lifecycleSignal.subagentId,
        declaredParentThreadId: sessionThreadId,
        subagentId: lifecycleSignal.subagentId,
      }),
    });
  }
  return Object.freeze({
    family: "tool_activity",
    eventType: "subagent.completed",
    subagentId: lifecycleSignal.subagentId,
    parentToolUseId: lifecycleSignal.parentToolUseId,
    announcement: null,
  });
}

// --------------------------------------------------------------------------
// T3.11 — family classification for the thread-frame router (NS-91).
// --------------------------------------------------------------------------

/**
 * Classify one Claude frame kind's FAMILY for the thread-frame router
 * (`Spec-005 §Required Behavior`'s family-scoped routing rule). The censused
 * connection- and account-scoped families — `system/api_retry` →
 * `usage.api_retry`, `rate_limit_event` → `usage.rate_limit_update`, and the
 * capability/initialization and control-channel frames — route without a
 * thread identity, because their own shapes carry none; thread-scoped
 * families demand one; an unlisted shape is `unknown`, never presumed
 * connection-scoped.
 *
 * `observation` is REQUIRED rather than optional. Omitting it silently reverts
 * to kind-only classification, which drops a registered child's spend on this
 * provider (see the carve-out note below) — a defect the type system can only
 * catch if every call site is forced to state what the frame carries. A caller
 * with nothing to declare passes `{ cumulativeUsage: undefined }` explicitly.
 */
export function classifyClaudeFrameFamilyForRouting(
  frameKind: string,
  observation: { readonly cumulativeUsage: unknown },
): ThreadFrameFamilyClass {
  const kindClass = classifyClaudeFrameKindForRouting(frameKind);
  // The usage carve-out is decided by what the frame CARRIES, not only by what
  // it is called. This provider publishes its cumulative token readings on the
  // same frames that carry assistant content, and no frame kind is reserved for
  // usage — so a kind-only classification would route a registered child's
  // usage-bearing frame to plain transcript suppression, and the child's spend
  // would be scoped out of existence rather than metered under its own
  // attribution. Narrowed to already-thread-scoped kinds on purpose: a
  // connection-scoped frame routes and meters without an identity anyway, and
  // an unclassified kind must stay fail-closed rather than become routable
  // because it happened to carry a number.
  if (observation.cumulativeUsage != null && kindClass.scope === "thread") {
    return { scope: "thread", capability: "usage" };
  }
  return kindClass;
}

function classifyClaudeFrameKindForRouting(frameKind: string): ThreadFrameFamilyClass {
  switch (frameKind) {
    // Connection- and account-scoped: retry / rate-limit / initialization
    // frames (the pinned stream-surface census's connection-scoped class) and
    // the control channel, which is a connection-level discipline in both
    // directions.
    case "system/api_retry":
    case "system/api_error":
    case "system/rate_limit_event":
    case "system/init":
    case "system/worker_shutting_down":
    case "control_request/can_use_tool":
    case "control_request/elicitation":
    case "control_request/request_user_dialog":
    case "control_request/hook_callback":
    case "control_request/mcp_message":
    case "control_request/mcp_set_servers":
    case "control_request/interrupt":
    case "control_request/set_permission_mode":
    case "control_request/set_model":
    case "control_request/get_usage":
    case "control_request/get_context_usage":
    case "control_request/get_session_cost":
    case "control_request/list_models":
    case "control_request/get_binary_version":
    case "control_request/apply_flag_settings":
    case "control_request/rewind_files":
    case "control_response/success":
    case "control_response/error":
      return { scope: "connection" };
    // Thread-scoped usage: the compaction marker rides the thread it compacts.
    case "system/compact_boundary":
      return { scope: "thread", capability: "usage" };
    // Subagent lifecycle signals: thread-scoped lifecycle (the start is also
    // the router's registration input via its parent-linked announcement).
    case CLAUDE_SUBAGENT_START_SIGNAL:
    case CLAUDE_SUBAGENT_STOP_SIGNAL:
      return { scope: "thread", capability: "lifecycle" };
    // Thread-scoped content: the stream-json result terminals and the
    // remaining system-channel subtypes, all riding the session's own stream.
    case "result/success":
    case "result/error_max_turns":
    case "result/error_max_budget_usd":
    case "result/error_during_execution":
    case "result/error_max_structured_output_retries":
    case "system/hook_started":
    case "system/hook_progress":
    case "system/hook_response":
    case "system/notification":
    case "system/files_persisted":
    case "system/tool_use_summary":
    case "system/memory_recall":
    case "system/local_command_output":
    case "system/task_progress":
      return { scope: "thread", capability: "content" };
    default:
      return { scope: "unknown" };
  }
}

// --------------------------------------------------------------------------
// The terminal-emission boundary (Plan-005 T3.14 P1-1 + P1-2-driver).
// --------------------------------------------------------------------------
//
// The Claude leg's half of the boundary the Codex normalizer carries for its
// own provider. Same two properties, same reasoning, one provider-specific
// difference worth stating: the Claude leg already carries an explicit
// intended-close signal on its own transport in `ClaudeChannelDisposalReason
// .session_closed`, so the lifecycle module has a typed place to read the
// intent from rather than inferring it from a teardown's timing.
//
//   P1-1 — INTENDED CLOSE. `closeSession` signals into this boundary before
//   it disposes the channel, so the `result/*` terminal the disposal provokes
//   is stamped as a clean shutdown rather than classified as a crash
//   (`Spec-006 §Run Lifecycle (run_lifecycle)`).
//
//   P1-2-driver — DUPLICATE SUPPRESSION. At most one terminal per
//   `(runId, runVersion)` epoch, absorbed here rather than left to fail loud
//   on Plan-006's partial unique index.
//
// Routing is CONSUMED, never re-decided: only a frame the T3.11 router routed
// to the session's own thread settles a run, so a subagent's `result/*` never
// settles the parent's.

/**
 * The Claude leg's bindings for the provider-neutral emission gate.
 *
 * The suppression rule itself lives once at `provider/terminal-emission-gate.ts`
 * — both driver legs feed ONE shared uniqueness index (the Plan-006 partial
 * unique index), and two implementations of one invariant is one more than the
 * invariant can survive. What stays here is the Claude-named binding.
 */
export type ClaudeTerminalRunFrame = TerminalRunFrame;
export type ClaudeTerminalSuppressionReason = TerminalSuppressionReason;
export type ClaudeTerminalEmissionDecision = TerminalEmissionDecision;

/**
 * The Claude terminal-emission gate — one instance per provider session, held
 * by the lifecycle module for that session's lifetime.
 *
 * An empty extension rather than an alias, for the same reason as its Codex
 * sibling: no census-specific gate input exists today, and the named subclass
 * is what a later one would land on.
 */
export class ClaudeTerminalEmissionGate extends TerminalEmissionGate {}

// --------------------------------------------------------------------------
// T3.18 — turn evidence on the terminal `result` frame
// --------------------------------------------------------------------------

/**
 * The four `result` subtypes that ARE a declared failure.
 *
 * Derived from this module's own frame-kind census rather than restated, so a
 * subtype added to the census joins this set without a second edit. `success`
 * is excluded by construction: it is the subtype a swallowed turn wears, and
 * treating it as a declared failure would make the tripwire unreachable.
 */
const CLAUDE_DECLARED_FAILURE_RESULT_SUBTYPES: ReadonlySet<string> = new Set(
  CLAUDE_WIRE_FRAME_KINDS.filter((kind) => kind.startsWith("result/error_")).map((kind) =>
    kind.slice("result/".length),
  ),
);

/** Every `result` subtype the pin censuses, failure and success alike. */
const CLAUDE_RESULT_SUBTYPES: ReadonlySet<string> = new Set(
  CLAUDE_WIRE_FRAME_KINDS.filter((kind) => kind.startsWith("result/")).map((kind) =>
    kind.slice("result/".length),
  ),
);

/** True for a number that is finite and strictly positive. */
function isPositiveFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** True for a non-array object carrying at least one own key. */
function isNonEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/**
 * Reads a settling Claude `result` frame for positive, typed evidence that a
 * model turn happened (T3.18, I-005-7).
 *
 * WHAT IT READS AND WHY. The discriminants are the ones measured side by side
 * against the pinned build — `num_turns`, `duration_api_ms`, `total_cost_usd`,
 * and `modelUsage` — recorded in `docs/reference/provider-wire/claude.md`.
 * They move together on a real turn and are all zero-valued on an intercepted
 * one.
 *
 * WHAT IT DELIBERATELY DOES NOT READ, which is the sharper half:
 *
 *   * `is_error` does not discriminate. The intercepted run reports `false`;
 *     a genuine turn that ends in a provider-side refusal reports `true`.
 *   * The assistant frame's `message.model === "<synthetic>"` marker does not
 *     discriminate either — the same measurement shows a genuine API-errored
 *     turn rendering synthetic. It is evidence of a locally-composed frame,
 *     never evidence that no turn occurred.
 *   * The `<local-command-stdout>` wrapper and the `is_meta` marker are real
 *     and are NOT consulted. They recognize DISPATCH, and the set of shapes a
 *     command layer can emit is open, so a classifier keyed on them fails open
 *     the day the wrapper changes. This function only ever recognizes the
 *     presence of a turn.
 *
 * No message prose is parsed anywhere in it.
 */
export function classifyClaudeTurnEvidence(terminalFrame: unknown): TurnEvidenceClassification {
  if (typeof terminalFrame !== "object" || terminalFrame === null || Array.isArray(terminalFrame)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const frame = terminalFrame as Record<string, unknown>;
  if (frame["type"] !== "result") {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const subtype = frame["subtype"];
  if (typeof subtype !== "string" || !CLAUDE_RESULT_SUBTYPES.has(subtype)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }

  const observations: TurnEvidenceClass[] = [];
  if (
    isPositiveFiniteNumber(frame["num_turns"]) ||
    isPositiveFiniteNumber(frame["duration_api_ms"]) ||
    isPositiveFiniteNumber(frame["total_cost_usd"])
  ) {
    observations.push("turn_accounting");
  }
  if (isNonEmptyRecord(frame["modelUsage"])) {
    observations.push("model_output");
  }
  if (CLAUDE_DECLARED_FAILURE_RESULT_SUBTYPES.has(subtype)) {
    observations.push("declared_turn_failure");
  }
  return observedTurnEvidence(...observations);
}

// --------------------------------------------------------------------------
// T3.16 — Typed provider usage-limit signal, Claude leg
// (`Spec-005 §Fallback Behavior`; verifies I-005-6)
// --------------------------------------------------------------------------

/** The retry frame's discriminating `type` / `subtype` pair. */
export const CLAUDE_API_RETRY_FRAME_TYPE = "system" as const;
export const CLAUDE_API_RETRY_FRAME_SUBTYPE = "api_retry" as const;

/**
 * The single `api_retry` typed-error member that names a spent allowance.
 *
 * `billing_error` sits beside it in the same enum and is deliberately NOT a
 * member here: a payment fault is remediated by a human, not by a window turning
 * over, so admitting it would park a run against a boundary that never arrives.
 * That is the same split the Codex leg makes for a depleted credit balance, and
 * it is what keeps this axis meaning "resolves unattended".
 */
export const CLAUDE_USAGE_LIMIT_RETRY_ERROR_MEMBER = "rate_limit" as const;

/**
 * Classifies a Claude `system/api_retry` frame for a spent usage allowance
 * (T3.16, I-005-6), or `null` when it states none.
 *
 * THE WEAKER OF THE TWO LEGS, and recorded as such. The Codex account plane
 * publishes a dedicated reached-type enum beside provider-stated reset instants;
 * Claude publishes a retry notification whose typed `error` member names the
 * condition and whose only temporal member is a backoff delay. The frame's shape
 * is graded Derived in `docs/reference/provider-wire/claude.md` — a string
 * census cannot prove the `error` union closed — so this leg RECOGNIZES a member
 * and never REJECTS one: an unfamiliar `error` value takes the same `null` path
 * as any other unrecognized shape.
 *
 * RECOGNITION IS TYPED-ONLY, gated on the frame's `type` / `subtype` pair and
 * the typed `error` member. In particular `error_status` — the HTTP status the
 * reference calls out as sitting beside the typed member — is NOT read, on this
 * axis or any other: a bare `429` is emitted for transport-level throttling that
 * no allowance is spent on, so keying on it would park runs the provider is
 * still willing to serve the moment it retried. No message prose is parsed.
 *
 * THE BOUNDARY IS RUNTIME-DERIVED, and the stamp says so. `retry_delay_ms` is
 * when the provider intends to try again, not when the allowance is restored;
 * the frame carries no documented reset field at all. Composing an instant from
 * the delay is still worth doing — an armed schedule beats an unbounded wait —
 * but the consumer must be able to tell it apart from an instant the provider
 * actually stated, which is exactly what the provenance member is for.
 *
 * `observedAtEpochMs` is an EXPLICIT PARAMETER rather than a `Date.now()` read,
 * so this classifier stays pure and total: the same frame with the same clock
 * always yields the same signal, which is what makes the boundary assertable in
 * a test instead of approximable.
 *
 * A recognized refusal with no usable delay still returns the CAUSE. A missing
 * boundary changes only whether a resume is scheduled — never whether the run is
 * known to be limited.
 *
 * `attempt` AND `max_retries` ARE DELIBERATELY NOT READ, and the frame carries
 * both, so the omission is a decision rather than an oversight. This classifier
 * reports an OBSERVED CONDITION — the provider refused this request because a
 * rolling allowance is spent — and says nothing about whether to wait it out. A
 * signal suppressed until the ladder's final attempt would leave the run with no
 * recognized reason for the whole ladder, which is the "generic failure path
 * with nothing telling anyone why" the contract's own no-capability-flag
 * rationale rejects. Where the honesty is owed instead: the derived boundary is
 * the provider's OWN next-attempt instant, so a consumer arming a schedule from
 * an early-attempt frame arms it exactly where the provider was going to retry
 * anyway. The residual is the consumer's and is stated rather than absorbed — a
 * pacing surface that treats any recognized refusal as terminal will act on a
 * ladder the provider may still complete, and this axis carries no attempt
 * member to help it, because minting one here would mint a member ahead of its
 * reader. The signal fires on ANY attempt; a test pins that.
 */
export function classifyClaudeUsageLimitSignal(
  frame: unknown,
  observedAtEpochMs: number,
): ProviderUsageLimitSignal | null {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return null;
  }
  const record = frame as Record<string, unknown>;
  if (
    record["type"] !== CLAUDE_API_RETRY_FRAME_TYPE ||
    record["subtype"] !== CLAUDE_API_RETRY_FRAME_SUBTYPE ||
    record["error"] !== CLAUDE_USAGE_LIMIT_RETRY_ERROR_MEMBER
  ) {
    return null;
  }

  const retryDelayMs = record["retry_delay_ms"];
  if (!isPositiveFiniteNumber(retryDelayMs) || !Number.isFinite(observedAtEpochMs)) {
    return { cause: "plan-allowance-exhausted" };
  }
  const instant = new Date(observedAtEpochMs + (retryDelayMs as number));
  if (Number.isNaN(instant.getTime())) {
    return { cause: "plan-allowance-exhausted" };
  }
  return {
    cause: "plan-allowance-exhausted",
    resetBoundary: { resetsAt: instant.toISOString(), provenance: "runtime-derived" },
  };
}
