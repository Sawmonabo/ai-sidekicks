// Codex event normalizer (Plan-005 Phase 3, T3.5).
//
// The Codex leg of the driver normalize boundary: a PURE, TOTAL mapping from
// the pinned Codex `app-server` inbound wire method to the Plan-006 normalized
// event family it belongs to. Nothing here parses a payload, mints an
// envelope, or touches session state — it answers exactly one question, "which
// normalized family does this native frame belong to", which is the whole of
// what `Spec-005 §Required Behavior` (drivers emit normalized runtime events,
// not provider-native types) asks of this seam.
//
// Spec coverage:
//   • `Spec-005 §Required Behavior` — drivers emit normalized runtime events,
//     not provider-native types. The session engine never sees a Codex method
//     string; it sees an `EventCategory` and a `SessionEventType`.
//   • `Spec-005 §Required Behavior` — the required normalized event families
//     (run lifecycle, assistant output, tool activity, interactive request,
//     artifact publication, usage/quota telemetry). Five of the six are
//     reachable from the pinned Codex inbound census; `artifact_publication`
//     is reachable from none, and that is a CORPUS fact rather than a gap in
//     this table. Grounded below under:
//     "Why `artifact_publication` is reachable from no Codex frame".
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
//   (1) `docs/reference/provider-wire/codex.md` — the version-pinned Codex
//       wire reference (pin `codex-cli 0.150.1`, regenerated 2026-08-28 from
//       the binary's own generated schema). It records the ten `ServerRequest`
//       methods in full (§Server-requests), the legacy bare-camelCase
//       notifications (§Method namespace), the nineteen experimental-gated
//       notifications (§The experimental gate), and a set of modern
//       slash-namespaced notifications by exact name (§Capability shapes,
//       §Adjacent currency facts).
//   (2) `docs/plans/006-session-event-taxonomy-and-audit-log.md`
//       §Event-Kind Disposition Table — the disposition contract this task's
//       `Consumes:` row names. Its 35-kind census fixes each normalized kind's
//       target category, and its "current-wire delta families" table fixes
//       FAMILY-level dispositions for the Codex delta rows while stating
//       verbatim that "per-member normalization is Plan-005 T3.5/T3.10 driver
//       detail" — which is the license under which this file assigns a
//       specific census kind to a specific method inside a family the corpus
//       has already settled.
//
// Nothing in this table is transcribed from provider prose docs or invented.
// The `regenerate, don't transcribe` rule (`docs/reference/provider-wire/README.md`
// §Evidence rules) applies to the wire shapes; this file maps method NAMES,
// each of which is recorded verbatim in one of the two sources above, and the
// `__fixtures__/` census vectors carry the codex.md-recorded subset so a
// re-pin diff shows up as a failing test rather than as prose drift.
//
// ---------------------------------------------------------------------------
// What is deliberately NOT in the closed union (and why)
// ---------------------------------------------------------------------------
//
//   • The eleven `thread/realtime/*` server notifications
//     (`thread/realtime/started`, `.../closed`, `.../error`, `.../itemAdded`,
//     `.../sdp`, `.../outputAudio/delta`, `.../transcript/delta`,
//     `.../transcript/done`, `.../item/started`, `.../item/transcript/delta`,
//     `.../item/completed` — the last three added by the `0.150.1` pin BESIDE
//     the older spellings, not in place of them). Three independent corpus
//     statements put them outside this table: the Spec-006 `realtime_*` family
//     is RESERVED with no V1 emitter, so there is no family emission to make;
//     the driver suppresses them at the source via Codex
//     `initialize.capabilities.optOutNotificationMethods`
//     (Plan-005 T3.12 C-16 / T3.15 leg 7), so they do not arrive on this
//     connection; and Plan-005 T3.11 states verbatim that the normalizer
//     "routes each of the eleven Codex realtime wire kinds ... to the
//     default-branch diagnostic", and that a twelfth upstream-added
//     `thread/realtime/*` name "still falls through to the same P0-1
//     default-branch diagnostic — never silently dropped". Leaving all eleven
//     out of the union is what makes that sentence true: they reach the
//     unknown seam below, which T3.11 re-points at its diagnostic surface.
//     Listing them here as a suppression constant would duplicate the
//     `optOutNotificationMethods` list T3.12/T3.15 owns, so they are named in
//     this comment and nowhere in the code.
//
//   • `mcpServer/event/stream/notification`, the fourth arm the `0.150.1` pin
//     added and the only non-realtime one. It is experimental-gated like the
//     other three, so a connection negotiating `experimentalApi: false` never
//     receives it, and no corpus row assigns it a normalized family. It is
//     therefore left OUT of the union deliberately rather than mapped on a
//     guess: should a later posture or pin make it deliverable, it reaches the
//     unknown seam below and surfaces as an operator-visible T3.11 diagnostic,
//     which is the discovery path this module wants for growth it has not
//     been given a disposition for.
//
//   • `rawResponse/completed` and `rawResponseItem/completed`. codex.md records
//     both by name and records that neither reaches the pinned binary's
//     generated schema ("Source declares 81; the binary generates 79"). The
//     generated schema is the pin, so they are not members of the pinned native
//     set. Should a later build start emitting one, the unknown seam surfaces
//     it as an operator-visible T3.11 diagnostic — which is the correct
//     outcome for a frame the pin says cannot arrive.
//
//   • Client-request RESPONSES. The union is keyed on server-originated frames
//     (`ServerNotification` ∪ `ServerRequest`). The `account/rateLimits/read`
//     PULL leg feeds the same `rate_limits` normalized kind as the
//     `account/rateLimits/updated` PUSH row below (Plan-005 T3.11 P0-1, C-9),
//     but it arrives as a reply to a daemon-issued request rather than as an
//     inbound frame, so its plumbing belongs to the request path, not here.
//
// ---------------------------------------------------------------------------
// What IS in the union but cannot arrive today
// ---------------------------------------------------------------------------
//
// Excluded and dormant are different states, and collapsing them would be a
// bug in both directions. Twelve census members — one `ServerRequest` and
// eleven `ServerNotification`s — are experimental-gated at the pin and so
// unreachable while the driver negotiates `experimentalApi: false`. They are
// mapped anyway, and named in {@link CODEX_NEGOTIATION_GATED_METHODS} with the
// full reasoning. The short version: their dispositions are already settled by
// the corpus, so keeping the rows makes a posture flip or a pin bump free,
// whereas deleting them would route twelve settled frames into the T3.11
// diagnostic at once. The realtime eleven above are the opposite case — opted
// out by name at the source AND targeting a family with no V1 emitter, so no
// corpus row supplies a disposition to keep.
//
// ---------------------------------------------------------------------------
// Why `artifact_publication` is reachable from no Codex frame
// ---------------------------------------------------------------------------
//
// This is the one Spec-005 required family no row below targets, so the reason
// is recorded here rather than left as an absence a later reader must
// re-derive. Three independent corpus facts, none of them a gap in this table:
//
//   1. Nothing in the normalized census adopts into it. Plan-006's 35-kind
//      census assigns each kind a target category, and `EVENT_DISPOSITION_BY_KIND`
//      names only `run_lifecycle`, `assistant_output`, `tool_activity`,
//      `interactive_request`, `approval_flow`, `usage_telemetry`, and
//      `session_lifecycle`. `artifact_publication` is never a target. There is
//      therefore no kind this driver could route to it without inventing one.
//
//   2. The one plausible candidate is routed elsewhere BY THE CORPUS.
//      `turn/diff/updated` carries file-change content, so it looks like an
//      artifact producer; the `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)` delta row
//      routes it to the `diff` kind (row 32) in `tool_activity` / `tool.result`.
//      This table follows that verbatim rather than second-guessing it.
//
//   3. The family's emitter is not a driver. Plan-006's event-family ownership
//      table assigns all six `artifact_publication` types to Plan-014
//      (Artifacts, Files And Attachments) — daemon-side emitters, reached
//      through the artifact pipeline, not through a provider frame. A Codex
//      normalizer producing one would be asserting an emitter the corpus gives
//      to another plan.
//
// So five-of-six is the correct coverage for THIS driver, and the sixth is not
// this module's to emit. The shortfall is pinned by the test
// "pins artifact_publication as reachable from NO Codex frame, and why"
// (describe block "Codex event normalizer — normalized-family coverage"),
// which asserts both that no row reaches the family and that no disposition
// entry targets it — so if either corpus fact ever changes, the suite fails
// loudly and the author must justify the new producer rather than discovering
// the drift later.
//
// ---------------------------------------------------------------------------
// The T3.11 seam
// ---------------------------------------------------------------------------
//
// A method outside the closed census resolves to nothing and reaches
// `refuseUnmappedCodexInboundFrame` below, which throws
// `UnknownCodexInboundFrameError`. That single function is the seam Plan-005
// T3.11 (PR-B) replaces with its typed daemon-diagnostic default branch
// (`DriverDiagnosticRecord` onto `driver-diagnostics.ts`). It is a THROW and
// not a silent drop on purpose: pre-T3.11 an unmapped frame must be loud, and
// `Spec-005 §Pitfalls To Avoid` plus the Plan-006 no-silent-capability-loss
// default both forbid the quiet alternative. Nothing else in this module
// branches on unknown-ness, so T3.11 adds a branch rather than restructuring
// a dispatch.
//
// This module deliberately does NOT read `EVENT_DISPOSITION_BY_KIND`. That
// registry is T3.11's runtime consume (it mirrors the adopt / rename /
// correlate / discard verdicts and drives the interim-`typePending` routing).
// What THIS task owes is the native-method -> family mapping, and the
// __tests__ suite cross-checks every row of it against both contracts
// registries so the two cannot drift while the runtime consume stays T3.11's.
//
// ---------------------------------------------------------------------------
// What this module consumes from its two peer seams
// ---------------------------------------------------------------------------
//
//   * `packages/contracts` (`SESSION_EVENT_TYPES`) — the roster of event types
//     with a REGISTERED `SessionEventSchema` payload variant. Every row's
//     `emissionReadiness` is derived from it at map-build time rather than
//     hand-stated, so the stamp widens by itself the moment an emitting plan
//     lands a variant and no mirror of the registered set exists here to go
//     stale. See {@link CodexEmissionReadiness}.
//   * `./tools.js` (`CodexToolName`) — the T3.4 tool-identity namespace, which
//     that module exports expressly for this consumer. Two census methods
//     embed a tool discriminant; they are bound to the namespace by the
//     annotation on {@link CODEX_TOOL_KEYED_APPROVAL_METHODS}, so a rename
//     there is a compile error here. Type-only: the pinned wire literals stay
//     literals, and nothing composes a method string at runtime.
//
// Refs: Plan-005 §Phase 3 / T3.5, `Spec-005 §Required Behavior`,
// `docs/reference/provider-wire/codex.md` (pin `codex-cli 0.150.1`),
// `docs/plans/006-session-event-taxonomy-and-audit-log.md`
// §Event-Kind Disposition Table.

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
import type { CodexToolName } from "./tools.js";

// --------------------------------------------------------------------------
// Transport role — which of the two server-originated JSON-RPC roots the
// frame arrives on.
// --------------------------------------------------------------------------

/**
 * Which generated protocol root a Codex inbound frame belongs to, per
 * `docs/reference/provider-wire/codex.md` §Method namespace / §Server-requests.
 *
 * Carried as OUTPUT rather than demanded as input: the caller has a method
 * string off the wire and needs to learn whether the frame must be answered
 * (`server-request`) or is fire-and-forget (`server-notification`). Making it
 * an input would ask the caller to already know the answer.
 */
export type CodexInboundFrameTransport = "server-request" | "server-notification";

// --------------------------------------------------------------------------
// The closed census of Codex inbound frame methods this normalizer maps.
// --------------------------------------------------------------------------

/**
 * The pinned Codex inbound method census — every server-originated frame the
 * corpus both records by exact name AND settles a normalized disposition for.
 *
 * Closed on purpose: a literal union is what makes the backing record's
 * `satisfies` check a compile-time totality proof, so a method added here
 * without a mapping row (or a row added without a union member) is a build
 * failure rather than a runtime surprise. The exclusions are enumerated in
 * this module's header comment, each with its citation.
 */
export type CodexInboundFrameMethod =
  // ServerRequest (10 of 10, codex.md §Server-requests — "the one root that
  // did not move across the floor").
  | "item/tool/call"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "execCommandApproval"
  | "applyPatchApproval"
  | "attestation/generate"
  | "account/chatgptAuthTokens/refresh"
  // ServerNotification — legacy bare camelCase (codex.md §Method namespace).
  | "error"
  | "warning"
  | "configWarning"
  | "deprecationNotice"
  | "guardianWarning"
  // ServerNotification — modern, ungated (codex.md §Capability shapes,
  // §Adjacent currency facts).
  | "thread/goal/updated"
  | "thread/goal/cleared"
  | "account/rateLimits/updated"
  | "thread/compacted"
  // The local skill-file watch signal. In the pinned generated
  // `ServerNotification` root beside the arms above and carrying NO
  // `#[experimental(...)]` marker, so it is delivered to this driver's
  // `experimentalApi: false` connection rather than being dormant like the
  // gated block below. Deliberately carries no `__fixtures__/` row: that
  // golden vector transcribes only the subset
  // `docs/reference/provider-wire/codex.md` names BY HAND, and it names this
  // one nowhere — inventing a fixture row to match a schema arm is exactly the
  // hand-transcription that file's header forbids.
  | "skills/changed"
  | "item/autoApprovalReview/started"
  | "item/autoApprovalReview/completed"
  | "model/safetyBuffering/updated"
  // ServerNotification — experimental-gated at the pin (codex.md §The
  // experimental gate). Delivered only to a connection that negotiated
  // `initialize.capabilities.experimentalApi`, which this driver does NOT:
  // the shipped `lifecycle.ts` sends `experimentalApi: false`. They are
  // mapped anyway and declared dormant — see
  // {@link CODEX_NEGOTIATION_GATED_METHODS}.
  | "process/outputDelta"
  | "process/exited"
  | "turn/moderationMetadata"
  | "autoApprovalReview/strictReviewRequired"
  | "thread/reverted"
  | "thread/queue/changed"
  | "project/changed"
  | "thread/project/updated"
  | "thread/environment/connected"
  | "thread/environment/disconnected"
  | "thread/settings/updated"
  // ServerNotification — Codex current-wire delta family whose DISPOSITION is
  // settled by `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)`
  // but whose WIRE NAMES are taken from the binary.
  //
  // The Plan-006 delta row spelled this family "`turn/diff` | `turn/plan` |
  // `turn/moderationMetadata`", and two of those three names do not exist on
  // the wire: regenerating the protocol schema from the pinned binary itself
  // (`codex app-server generate-json-schema --out <dir>` at codex-cli
  // 0.150.1) emits `turn/diff/updated` and `turn/plan/updated`. Only
  // `turn/moderationMetadata` is genuinely bare, and it is mapped above with
  // the other gated notifications. The generator output is canonical over
  // prose under the regenerate-don't-transcribe rule, so the generated names
  // were used here from the start; the Plan-006 delta-table row was corrected
  // to match on 2026-08-28, so doc and code now agree.
  //
  // Carried in `__fixtures__/` since that same 2026-08-28 pass: a golden
  // vector must be derivable from the version-pinned reference doc, and
  // `codex.md §Adjacent currency facts` now censuses both names by hand of the
  // same generation — which is exactly what had kept them out before.
  | "turn/diff/updated"
  | "turn/plan/updated";

// --------------------------------------------------------------------------
// Negotiation-gated methods — mapped, but dormant at the shipped posture.
// --------------------------------------------------------------------------

/**
 * The census methods that CANNOT arrive while the driver negotiates
 * `initialize.capabilities.experimentalApi: false` — the posture
 * `lifecycle.ts` ships, and the one Plan-005 T3.23 ratifies by building V1's
 * capability realization so it never needs the flag.
 *
 * Two different provider mechanisms produce the same unreachability, and the
 * distinction matters to whoever changes the posture:
 *
 *   * **Notifications (11)** are dropped by the transport itself.
 *     codex.md §The experimental gate records
 *     `should_skip_notification_for_connection` returning "skip" for any
 *     notification carrying an experimental reason on a connection that did
 *     not set the flag — "silently, with no error, no `deprecationNotice`, and
 *     no signal of any kind that the client is missing events."
 *   * **Requests (1)** — `item/tool/requestUserInput`, which the pinned
 *     binary's generated `ServerRequest` schema marks as the only EXPERIMENTAL
 *     arm of its ten. codex.md states plainly that "a default app-server
 *     session never delivers this method."
 *
 * WHY THEY STAY MAPPED. Deleting them would trade a dormant row for a live
 * hazard: the moment the posture flips (or a pin bump makes a gated surface
 * non-experimental), every one of these frames would reach the T3.11
 * default-branch diagnostic at once — a diagnostic flood standing in for
 * twelve dispositions the corpus has already settled. Keeping the mapping
 * makes that change free. This is the same reasoning that keeps the eleven
 * `thread/realtime/*` methods OUT: those are suppressed by name at the source
 * and route to a family with no V1 emitter, so mapping them would assert a
 * disposition no corpus row supplies. Dormant-but-settled is mapped;
 * suppressed-and-unsettled is excluded.
 *
 * This set is DECLARED rather than derived because the gate state lives in
 * neither of this module's inputs: the generated schema does not encode it
 * for notifications (the generator has no notification-side experimental
 * exclusion — regenerating at codex-cli 0.150.1 leaves 78 of 79
 * `ServerNotification` arms unmarked), and `tools.ts` knows nothing about
 * negotiation. The corpus source is codex.md §The experimental gate, which the
 * `__fixtures__/` gate tags transcribe; the test suite asserts this set equals
 * exactly the census members those fixtures tag gated, on BOTH transports, so
 * a census edit that changes gate state fails rather than drifts.
 *
 * The `CodexInboundFrameMethod` element type is load-bearing: a member renamed
 * or dropped from the union is a compile error here, not a silently stale
 * entry.
 */
export const CODEX_NEGOTIATION_GATED_METHODS: readonly CodexInboundFrameMethod[] = Object.freeze([
  // ServerRequest — 1 of 10 (the only EXPERIMENTAL-marked request arm).
  "item/tool/requestUserInput",
  // ServerNotification — 11 of this census's 26.
  "process/outputDelta",
  "process/exited",
  "turn/moderationMetadata",
  "autoApprovalReview/strictReviewRequired",
  "thread/reverted",
  "thread/queue/changed",
  "project/changed",
  "thread/project/updated",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
]);

// --------------------------------------------------------------------------
// Tool-identity binding — the T3.4 (`tools.ts`) namespace seam.
// --------------------------------------------------------------------------

/**
 * The wire shape of a per-tool approval request: `item/<toolName>/requestApproval`.
 *
 * Parameterized by `CodexToolName` so the tool-identity namespace `tools.ts`
 * declares is the ONLY source of the middle segment. `tools.ts` states its
 * half of this contract explicitly — `CODEX_TOOL_NAMES` is exported "SPECIFICALLY
 * so the T3.5 event normalizer imports the identity rather than restating string
 * literals: a namespace change becomes a compile error at the consumer instead
 * of a dead database lookup at recovery time."
 */
type CodexToolApprovalMethod<TToolName extends CodexToolName> = `item/${TToolName}/requestApproval`;

/**
 * The census methods whose middle segment IS a `CodexToolName` — the binding
 * between this module's pinned wire literals and the T3.4 tool namespace.
 *
 * Why the literals stay spelled out here rather than being template-expanded
 * into the union above: these are version-pinned wire strings, and
 * `docs/reference/provider-wire/codex.md` records them verbatim under the
 * regenerate-don't-transcribe rule. A reviewer diffing this census against the
 * reference must be able to grep `item/commandExecution/requestApproval` and
 * find it. Writing the union as `CodexToolApprovalMethod<"commandExecution">`
 * would make that grep fail and hide a pinned wire fact behind a type
 * application.
 *
 * The ANNOTATION is the seam, and it is an INTERSECTION for a reason found by
 * perturbation rather than by design: `CodexToolApprovalMethod<CodexToolName>`
 * alone expands to all seven conceivable per-tool approval methods, so it
 * would type these entries as members of a set five of whose elements are not
 * on the wire at all — and it never ties them back to this module's own
 * census. Intersecting with `CodexInboundFrameMethod` collapses the annotation
 * to exactly the two real literals and makes the declaration fail on BOTH
 * axes: renaming or dropping `commandExecution` / `fileChange` in
 * `CODEX_TOOL_NAMES` empties the tool half, and removing either method from
 * the census union empties the census half. Either is a compile error here —
 * exactly the failure `tools.ts` asks its consumer to produce, and never a
 * runtime string build that could drift from the pin.
 *
 * The reverse direction is deliberately NOT asserted. Requiring every
 * `CodexToolName` to have an approval method would demand
 * `item/webSearch/requestApproval` and four more the reference does not show —
 * inventing wire frames to satisfy a symmetry the protocol does not have. Only
 * the two mutating tools gate on approval at the pin.
 */
export const CODEX_TOOL_KEYED_APPROVAL_METHODS: readonly (CodexToolApprovalMethod<CodexToolName> &
  CodexInboundFrameMethod)[] = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

// --------------------------------------------------------------------------
// Emission readiness — derived, never stated.
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
 *
 * Structurally identical to the Claude driver's `ClaudeEmissionReadiness` and
 * deliberately NOT imported from it: a Codex module importing a Claude module
 * would couple two peer drivers through the wrong axis for a two-literal
 * string union. Structural identity is what lets T3.11 mirror verdicts across
 * both normalizers with no adapter; hoisting the alias to a shared
 * driver-local home is a T3.11 concern, and that file is not this task's.
 */
export type CodexEmissionReadiness = "envelope-constructible" | "payload-variant-pending";

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
 * exercised by a test. Re-derived when the durable content home registered the
 * five body-bearing payload variants: 3 of the 11 Codex targets
 * (`assistant.message`, `tool.invoked`, `tool.result`) now appear in the
 * 30-member registered roster and answer `envelope-constructible`; the other 8
 * stay `payload-variant-pending`. Both answers are therefore reachable through
 * ordinary Codex frames, and the tests additionally call this resolver directly
 * so neither arm depends on the census staying mixed.
 */
export function resolveCodexEmissionReadiness(eventType: SessionEventType): CodexEmissionReadiness {
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
 * `NormalizedEventKind` census, or `null` for a Codex delta-family member the
 * census does not name. `null` is a real state rather than a defect: the
 * Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census) assigns the delta families a
 * category and a target type WITHOUT minting a census kind for each member
 * ("Family-level dispositions are used for the delta rows"), so a non-null
 * kind would have to be invented for `thread/goal/updated`,
 * `turn/moderationMetadata`, and the guardian rows. `eventType` is total
 * either way, which is what downstream consumers actually key on.
 *
 * `eventType` names the family emission's target literal. Registration is not
 * emission license (Plan-006 T1.10's flip-is-not-emission rule): naming a
 * target here does not construct an envelope, and a target whose payload
 * variant has not joined `SessionEventSchema` still routes through T3.11.
 * `emissionReadiness` carries that second answer alongside the target so a
 * consumer cannot read `eventType` without also being handed the question of
 * whether it may build one — it is DERIVED at map-build from the live
 * `SESSION_EVENT_TYPES` roster, never stated per row. See
 * {@link CodexEmissionReadiness}.
 *
 * Every property is `readonly` and every entry is frozen — the resolver hands
 * out module-level shared singletons, so an unfrozen entry would let one
 * consumer's `entry.family = ...` corrupt the mapping process-wide (the same
 * reasoning `packages/contracts/src/event.ts` records for
 * `EventKindDisposition`).
 */
export interface CodexNormalizedFamilyEmission {
  readonly disposition: "normalized";
  readonly nativeMethod: CodexInboundFrameMethod;
  readonly transport: CodexInboundFrameTransport;
  readonly family: EventCategory;
  readonly eventType: SessionEventType;
  readonly normalizedKind: NormalizedEventKind | null;
  readonly emissionReadiness: CodexEmissionReadiness;
}

/**
 * A frame the pin records, that carries no session-timeline capability, and
 * that therefore normalizes to no family at all.
 *
 * The mandatory non-empty `reason` mirrors the
 * `correlate` / `discard` idiom in `EVENT_DISPOSITION_BY_KIND`: under the
 * Plan-006 no-silent-capability-loss default, a non-emission is admissible
 * only with a stated justification, so the type makes an unreasoned one
 * unrepresentable. The `?: never` keys forbid a not-evented row from
 * smuggling a taxonomy target.
 *
 * This is NOT the unknown-frame path — an unknown method throws (see
 * {@link UnknownCodexInboundFrameError}). It is the path for a KNOWN frame
 * whose record the daemon already owns.
 */
export interface CodexNotEventedFrameDisposition {
  readonly disposition: "not-evented";
  readonly nativeMethod: CodexInboundFrameMethod;
  readonly transport: CodexInboundFrameTransport;
  readonly reason: string;
  readonly family?: never;
  readonly eventType?: never;
  readonly normalizedKind?: never;
  readonly emissionReadiness?: never;
}

/** The total result of normalizing one pinned Codex inbound frame method. */
export type CodexFrameNormalization =
  | CodexNormalizedFamilyEmission
  | CodexNotEventedFrameDisposition;

/**
 * A row of the mapping table BEFORE `emissionReadiness` is derived onto it.
 *
 * The readiness answer is computed once when the lookup map is built, from the
 * live `SESSION_EVENT_TYPES` roster, so no row may hand-state it: a stated
 * answer would be a second source of truth for a fact contracts already owns,
 * and it would go stale silently the moment an emitting plan landed a payload
 * variant. Splitting the row type from the result type is what makes that
 * unstateable rather than merely discouraged.
 *
 * That the split is ENFORCED rather than merely conventional was verified by
 * perturbation, not by inspection: hand-stating `emissionReadiness` on one
 * record row fails the build with
 * `TS2353: Object literal may only specify known properties`. The check holds
 * even though the sibling not-evented arm declares the key as `?: never` —
 * which would ordinarily make it a KNOWN property of the union and suppress
 * the excess-property error — because `disposition` is a discriminant, so
 * TypeScript narrows to the single matching constituent BEFORE running that
 * check. Shape-identical to the Claude driver's
 * `ClaudeFrameNormalizationTableRow` on purpose: T3.11 mirrors disposition
 * verdicts across both normalizers, and a divergent row type there would cost
 * it an adapter.
 *
 * Known limit, stated rather than papered over: excess-property checking only
 * fires for FRESH object literals. A row assembled in a variable and then
 * assigned would carry a stated stamp past this type. Every row in this
 * module's record is a fresh literal, so the guard is total over the code as
 * written, and the runtime test asserting each entry's stamp equals
 * `resolveCodexEmissionReadiness(row.eventType)` covers the residue.
 */
type CodexFrameNormalizationTableRow =
  | Omit<CodexNormalizedFamilyEmission, "emissionReadiness">
  | CodexNotEventedFrameDisposition;

// --------------------------------------------------------------------------
// Unknown-frame refusal — the single T3.11 seam.
// --------------------------------------------------------------------------

/**
 * Thrown when a Codex inbound method resolves to no census row.
 *
 * The typed carrier (rather than a bare `Error`) is what lets Plan-005 T3.11
 * replace the refusal with a `DriverDiagnosticRecord` without inspecting a
 * message string: `nativeMethod` is already the `rawWireType` that record
 * needs. The verbatim method is preserved rather than sanitized — it is
 * untrusted provider output, so it is carried as data and never interpolated
 * into anything that executes.
 */
export class UnknownCodexInboundFrameError extends Error {
  readonly nativeMethod: string;

  constructor(nativeMethod: string) {
    super(
      `Unmapped Codex inbound frame method: ${JSON.stringify(nativeMethod)}. ` +
        "The pinned census does not cover it; the daemon diagnostic default branch " +
        "replaces this refusal on the routed normalize path.",
    );
    this.name = "UnknownCodexInboundFrameError";
    this.nativeMethod = nativeMethod;
  }
}

// --------------------------------------------------------------------------
// The mapping table.
// --------------------------------------------------------------------------
//
// Module-internal `Record` keyed by the closed union for compile-time
// totality (a missing method is a compile error, an unregistered key is one
// too), exported below as a prototype-pollution-safe `ReadonlyMap` — the
// idiom `packages/contracts/src/event.ts` establishes for
// `SESSION_EVENT_CATEGORY_BY_TYPE` and `EVENT_DISPOSITION_BY_KIND`, and the
// reason it is load-bearing applies with full force here: this module's input
// is an UNTRUSTED provider-supplied method string, and an object-literal
// lookup would resolve `__proto__` and `constructor` to truthy
// non-normalization values.

const CODEX_FRAME_NORMALIZATION_RECORD = {
  // ------------------------------------------------------------------
  // ServerRequest — the callback / interactive / approval surface.
  // ------------------------------------------------------------------

  // The callback-tool invocation. A tool call arriving from the provider is
  // the `tool_start` census kind (Plan-006 row 3) -> `tool.invoked`.
  "item/tool/call": {
    disposition: "normalized",
    nativeMethod: "item/tool/call",
    transport: "server-request",
    family: "tool_activity",
    eventType: "tool.invoked",
    normalizedKind: "tool_start",
  },
  // Structured input asks. codex.md §Server-requests marks
  // `item/tool/requestUserInput` EXPERIMENTAL — "a default app-server session
  // never delivers this method, so the Plan-005 interactive-request leg must
  // opt in at `initialize`" — and the pinned binary's own generated
  // `ServerRequest` schema confirms it as the ONE of ten request arms carrying
  // that marker. The shipped driver does not opt in (`experimentalApi: false`),
  // so this row is dormant at the current posture; it is declared as such in
  // {@link CODEX_NEGOTIATION_GATED_METHODS} rather than deleted, because the
  // gate decides DELIVERY and this table decides DISPOSITION.
  "item/tool/requestUserInput": {
    disposition: "normalized",
    nativeMethod: "item/tool/requestUserInput",
    transport: "server-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "user_input_request",
  },
  "mcpServer/elicitation/request": {
    disposition: "normalized",
    nativeMethod: "mcpServer/elicitation/request",
    transport: "server-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "user_input_request",
  },
  // Permission asks — modern trio then legacy pair. Plan-005 T3.14 P1-4-driver
  // binds all five plus the two input asks above to the four `driver_ask.*`
  // types, which the Plan-012 T2.8 normalizer routes into the Cedar pipeline
  // (CP-005-7). They are `approval_request` (Plan-006 row 7), NOT
  // `approval_resolved`: the ask reaches the daemon undecided, and the
  // approval_flow row is minted by the daemon's own adjudication downstream.
  "item/commandExecution/requestApproval": {
    disposition: "normalized",
    nativeMethod: "item/commandExecution/requestApproval",
    transport: "server-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "approval_request",
  },
  "item/fileChange/requestApproval": {
    disposition: "normalized",
    nativeMethod: "item/fileChange/requestApproval",
    transport: "server-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "approval_request",
  },
  "item/permissions/requestApproval": {
    disposition: "normalized",
    nativeMethod: "item/permissions/requestApproval",
    transport: "server-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "approval_request",
  },
  execCommandApproval: {
    disposition: "normalized",
    nativeMethod: "execCommandApproval",
    transport: "server-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "approval_request",
  },
  applyPatchApproval: {
    disposition: "normalized",
    nativeMethod: "applyPatchApproval",
    transport: "server-request",
    family: "interactive_request",
    eventType: "driver_ask.requested",
    normalizedKind: "approval_request",
  },
  // The two control-plane server-requests. Both are answered on the transport
  // and neither is a session observation, so adopting either would mint a
  // timeline row for a handshake.
  "attestation/generate": {
    disposition: "not-evented",
    nativeMethod: "attestation/generate",
    transport: "server-request",
    reason:
      "control-plane request answered on the transport (the initialize-declared requestAttestation capability, codex.md C-16); it asks the daemon to mint an attestation and carries no session observation, so it has no timeline capability to lose",
  },
  "account/chatgptAuthTokens/refresh": {
    disposition: "not-evented",
    nativeMethod: "account/chatgptAuthTokens/refresh",
    transport: "server-request",
    reason:
      "credential-refresh brokering answered on the transport (Spec-029 provider-account plane, which stores no credential material); routing a credential frame onto the session timeline would put an auth-plane event in the audit log and is exactly what that plane's un-evented posture forbids",
  },

  // ------------------------------------------------------------------
  // ServerNotification — legacy bare camelCase.
  // ------------------------------------------------------------------

  // Run-failure envelope (Plan-006 row 13).
  error: {
    disposition: "normalized",
    nativeMethod: "error",
    transport: "server-notification",
    family: "run_lifecycle",
    eventType: "run.failed",
    normalizedKind: "error",
  },
  // Generic user-facing notices. Plan-006 row 17 names `notification` the
  // Codex-fed census kind for exactly this: a provider notice that belongs on
  // the timeline but drives no state transition.
  warning: {
    disposition: "normalized",
    nativeMethod: "warning",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.notice",
    normalizedKind: "notification",
  },
  configWarning: {
    disposition: "normalized",
    nativeMethod: "configWarning",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.notice",
    normalizedKind: "notification",
  },
  deprecationNotice: {
    disposition: "normalized",
    nativeMethod: "deprecationNotice",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.notice",
    normalizedKind: "notification",
  },
  // Guardian auto-adjudication. The Plan-006 delta row "guardian +
  // `autoApprovalReview`" fixes the family as `approval_flow` OBSERVABILITY,
  // adding verbatim that guardian auto-adjudication is "normalized as
  // observability, never a Cedar-pipeline bypass". Inside that family the
  // target is forced by elimination: every other approval_flow literal
  // (`approval.approved` / `.rejected` / `.expired` / `.canceled` /
  // `.remembered` / `.rule_revoked`) records a DAEMON adjudication, so
  // emitting one from a provider auto-review would be the bypass the row
  // forbids and would contradict codex.md's own rationale for pinning
  // `approvalsReviewer: "user"`. `moderation.review_flagged` is the family's
  // only non-adjudicating observability row. No census kind covers it.
  guardianWarning: {
    disposition: "normalized",
    nativeMethod: "guardianWarning",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "moderation.review_flagged",
    normalizedKind: null,
  },

  // ------------------------------------------------------------------
  // ServerNotification — modern, ungated at the pin.
  // ------------------------------------------------------------------

  // Session goals. Plan-006 delta row: goals (`thread/goal/*`) adopt into
  // `session_lifecycle` as `session.goal_updated` / `session.goal_cleared`.
  // Per-member split is this task's, per that table's own deferral.
  "thread/goal/updated": {
    disposition: "normalized",
    nativeMethod: "thread/goal/updated",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.goal_updated",
    normalizedKind: null,
  },
  "thread/goal/cleared": {
    disposition: "normalized",
    nativeMethod: "thread/goal/cleared",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.goal_cleared",
    normalizedKind: null,
  },
  // Account-plane quota snapshot. Plan-006 row 20 is a RENAME precisely to
  // keep this off context-window telemetry, and Plan-005 T3.11 P0-1 corrects
  // the corpus checklist in the same direction: "the Codex `rate_limits`
  // account-quota kind maps to `usage.rate_limit_update` (account-quota
  // utilization is not context-window utilization)".
  "account/rateLimits/updated": {
    disposition: "normalized",
    nativeMethod: "account/rateLimits/updated",
    transport: "server-notification",
    family: "usage_telemetry",
    eventType: "usage.rate_limit_update",
    normalizedKind: "rate_limits",
  },
  // Provider context-window compaction (Plan-006 row 19) — distinct from the
  // daemon `event.compacted` retention pass.
  "thread/compacted": {
    disposition: "normalized",
    nativeMethod: "thread/compacted",
    transport: "server-notification",
    family: "usage_telemetry",
    eventType: "usage.context_compacted",
    normalizedKind: "compact_boundary",
  },
  // The skill-file watch signal (T3.26). NOT EVENTED, and the reason is that
  // it carries no observation at all: `SkillsChangedNotification` is
  // `Record<string, never>` in the pinned generation — an empty object whose
  // own doc comment says to "treat this as an invalidation signal and re-run
  // `skills/list` ... when refreshed skill metadata is needed". A timeline row
  // minted from it could say only that something under a watched path changed,
  // which is a fact about the operator's filesystem rather than about the
  // session, and the daemon already owns the only consequence it has: the
  // driver's held enumeration is discarded so the next read is a FULL re-read
  // rather than a patch. See `Spec-005 §Desktop Console Parity Surfaces`.
  "skills/changed": {
    disposition: "not-evented",
    nativeMethod: "skills/changed",
    transport: "server-notification",
    reason:
      "empty-payload invalidation signal for the provider's local skill-file watch; it carries no session observation to lose, and its only consequence — discarding the driver-held command enumeration so the next read re-reads in full — is daemon-side state the provider is telling the client to refresh",
  },
  // Auto-approval review lifecycle — same delta row, same anti-bypass
  // reasoning, as `guardianWarning` above.
  "item/autoApprovalReview/started": {
    disposition: "normalized",
    nativeMethod: "item/autoApprovalReview/started",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "moderation.review_flagged",
    normalizedKind: null,
  },
  "item/autoApprovalReview/completed": {
    disposition: "normalized",
    nativeMethod: "item/autoApprovalReview/completed",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "moderation.review_flagged",
    normalizedKind: null,
  },
  // codex.md records this name under "New at the pin and worth knowing about"
  // with no shape and no semantics. Under the Plan-006 no-silent-capability-
  // loss default, adopt-or-rename is the DEFAULT and a discard is what needs
  // justifying — so an undocumented provider notice lands on the census's own
  // generic-notice kind rather than being dropped on the grounds that the pin
  // did not describe it.
  "model/safetyBuffering/updated": {
    disposition: "normalized",
    nativeMethod: "model/safetyBuffering/updated",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.notice",
    normalizedKind: "notification",
  },

  // ------------------------------------------------------------------
  // ServerNotification — experimental-gated at the pin, and therefore dormant
  // at the shipped `experimentalApi: false` posture. Mapped deliberately;
  // gating decides delivery, not disposition. See
  // {@link CODEX_NEGOTIATION_GATED_METHODS}.
  // ------------------------------------------------------------------

  // Plan-006 delta row: `process/*` adopts into `tool_activity` (the
  // `codex_exec_result` / `terminal_interaction` family). Per-member split is
  // this task's: an output delta is process OUTPUT (`command_output`, row 33)
  // and an exit is the raw exec-result signal (`codex_exec_result`, row 29).
  // Both land the same family and the same target literal, so the split is a
  // fidelity choice inside a settled disposition, not a re-disposition.
  "process/outputDelta": {
    disposition: "normalized",
    nativeMethod: "process/outputDelta",
    transport: "server-notification",
    family: "tool_activity",
    eventType: "tool.result",
    normalizedKind: "command_output",
  },
  "process/exited": {
    disposition: "normalized",
    nativeMethod: "process/exited",
    transport: "server-notification",
    family: "tool_activity",
    eventType: "tool.result",
    normalizedKind: "codex_exec_result",
  },
  // Plan-006 delta row names this one's target explicitly:
  // "`moderationMetadata` -> `approval_flow` (`moderation.review_flagged`)".
  "turn/moderationMetadata": {
    disposition: "normalized",
    nativeMethod: "turn/moderationMetadata",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "moderation.review_flagged",
    normalizedKind: null,
  },
  // The gated member of the guardian + autoApprovalReview delta row.
  "autoApprovalReview/strictReviewRequired": {
    disposition: "normalized",
    nativeMethod: "autoApprovalReview/strictReviewRequired",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "moderation.review_flagged",
    normalizedKind: null,
  },

  // ------------------------------------------------------------------
  // ServerNotification — gated, and not-evented: every one of these is a
  // provider-side echo of a record the DAEMON already owns. Adopting them
  // would put a second, provider-authored record of the same fact on the
  // timeline, which is the failure ADR-029 rules out on its own terms.
  // ------------------------------------------------------------------

  "thread/reverted": {
    disposition: "not-evented",
    nativeMethod: "thread/reverted",
    transport: "server-notification",
    reason:
      'correlation-only wire echo, not an empty frame — it is the notification counterpart of `thread/revert`, which the V1 driver does not drive at all: `Spec-005 §Per-Driver Capability Matrix` binds the Codex rewind to `thread/fork` at an inclusive `lastTurnId` (amended 2026-08-26), and `thread/revert` is separately `#[experimental("thread/revert")]` and paginated-threads-only at the pin, so this frame is off the V1 rewind path rather than on its hot path. Where it does arrive it correlates a revert the daemon requested, and the rewind-confirmation consumer is the lifecycle leg (T3.14), not the timeline: the durable rollback record is daemon-emitted (Spec-004 / `run.rolled_back`) when the daemon settles the intervention, so adopting this echo would mint a second record of a boundary the daemon already owns and could report a rollback the daemon refused',
  },
  "thread/queue/changed": {
    disposition: "not-evented",
    nativeMethod: "thread/queue/changed",
    transport: "server-notification",
    reason:
      "provider-side queue-depth notice; the daemon's own queue is the authority and already emits the `queue_item.*` interactive_request rows, so this frame carries no capability the timeline lacks",
  },
  "project/changed": {
    disposition: "not-evented",
    nativeMethod: "project/changed",
    transport: "server-notification",
    reason:
      "Codex project-scope bookkeeping; repo and workspace binding is daemon-owned (`repo.*` / `workspace.*` session_lifecycle rows sourced from the daemon's own mount state), so a provider-authored project notice would be a second source of truth for a binding the daemon set",
  },
  "thread/project/updated": {
    disposition: "not-evented",
    nativeMethod: "thread/project/updated",
    transport: "server-notification",
    reason:
      "per-thread projection of the same Codex project-scope bookkeeping as `project/changed`; same daemon-owned-binding reason",
  },
  "thread/environment/connected": {
    disposition: "not-evented",
    nativeMethod: "thread/environment/connected",
    transport: "server-notification",
    reason:
      "Codex environment-connection bookkeeping; runtime-node liveness is daemon-owned (`runtime_node.*`) and is observed by the daemon that spawned the process, so a provider-reported connection would report liveness the daemon can see directly",
  },
  "thread/environment/disconnected": {
    disposition: "not-evented",
    nativeMethod: "thread/environment/disconnected",
    transport: "server-notification",
    reason:
      "the paired disconnect of `thread/environment/connected`; same daemon-owned-liveness reason, and the run-terminal consequence of a real disconnect reaches the timeline through the lifecycle module's terminal emission rather than through this notice",
  },
  "thread/settings/updated": {
    disposition: "not-evented",
    nativeMethod: "thread/settings/updated",
    transport: "server-notification",
    reason:
      "provider-side settings echo; agent configuration is daemon-owned and already evented as `agent.config_updated` when the daemon applies it, so adopting the echo would double-record a mutation the daemon authored",
  },

  // ------------------------------------------------------------------
  // Delta-family members whose disposition Plan-006 settles and whose wire
  // names come from the pinned binary's generator; censused in `__fixtures__/`
  // since 2026-08-28 (see header).
  // ------------------------------------------------------------------

  // Wire name from the binary's own `codex app-server generate-json-schema`
  // output at codex-cli 0.150.1; the Plan-006 delta-table row carried the
  // truncated `turn/diff` until its 2026-08-28 correction.
  //
  // Disposition from that same delta row: "`diff` -> persisted (32)".
  // Row 32 puts the `diff` census kind in `tool_activity` /
  // `tool.result` — NOT in `artifact_publication`. That is the corpus's call
  // and it is followed here verbatim. Full grounding in this module's header:
  // "Why `artifact_publication` is reachable from no Codex frame".
  "turn/diff/updated": {
    disposition: "normalized",
    nativeMethod: "turn/diff/updated",
    transport: "server-notification",
    family: "tool_activity",
    eventType: "tool.result",
    normalizedKind: "diff",
  },
  // Wire name from the binary's own `codex app-server generate-json-schema`
  // output at codex-cli 0.150.1; the Plan-006 delta-table row carried the
  // truncated `turn/plan` until its 2026-08-28 correction.
  //
  // Disposition from that same delta row: "`plan` -> `proposed_plan` (35)";
  // row 35 puts `proposed_plan` in `assistant_output` / `assistant.message`.
  "turn/plan/updated": {
    disposition: "normalized",
    nativeMethod: "turn/plan/updated",
    transport: "server-notification",
    family: "assistant_output",
    eventType: "assistant.message",
    normalizedKind: "proposed_plan",
  },
} as const satisfies Record<CodexInboundFrameMethod, CodexFrameNormalizationTableRow>;

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
export const CODEX_INBOUND_FRAME_METHODS: readonly CodexInboundFrameMethod[] = Object.freeze(
  Object.keys(CODEX_FRAME_NORMALIZATION_RECORD) as CodexInboundFrameMethod[],
);

/**
 * The Codex native-method -> normalized-family mapping, as a
 * prototype-pollution-safe `ReadonlyMap`.
 *
 * A `Map` and NOT the backing object literal, for the reason
 * `packages/contracts/src/event.ts` records at
 * `SESSION_EVENT_CATEGORY_BY_TYPE`: this module's key is an untrusted
 * provider-supplied method string, and `lookup["__proto__"]` /
 * `lookup["constructor"]` on an object literal return truthy non-values,
 * whereas `map.get(...)` returns `undefined` for anything but an explicit
 * entry. Here that immunity decides whether a hostile method string reaches
 * the timeline as a fabricated normalization or reaches the unknown seam.
 *
 * Entries are frozen singletons, so repeated resolution of one method is
 * identity-stable — the property the determinism test asserts. The
 * `emissionReadiness` member is derived here, once, from the live registered
 * set rather than hand-stated per row.
 */
export const CODEX_FRAME_NORMALIZATION_BY_METHOD: ReadonlyMap<
  CodexInboundFrameMethod,
  CodexFrameNormalization
> = new Map(
  // Cast justified by the `satisfies` check above: the record's own enumerable
  // keys are exactly the `CodexInboundFrameMethod` literals (totality +
  // excess-property checks), so narrowing `Object.entries`' `[string, ...]` is
  // sound.
  (
    Object.entries(CODEX_FRAME_NORMALIZATION_RECORD) as ReadonlyArray<
      [CodexInboundFrameMethod, CodexFrameNormalizationTableRow]
    >
  ).map(([nativeMethod, normalization]) => [
    nativeMethod,
    Object.freeze(
      normalization.disposition === "normalized"
        ? {
            ...normalization,
            emissionReadiness: resolveCodexEmissionReadiness(normalization.eventType),
          }
        : normalization,
    ),
  ]),
);

/**
 * The bare resolver's refusal for a method outside the census.
 *
 * T3.11 landed the daemon-diagnostic default branch as
 * {@link resolveCodexFrameEmissionRoute} below — the driver core's entry
 * point, which converts this refusal into a typed `DriverDiagnosticRecord`
 * onto `driver-diagnostics.ts` and never throws. THIS function remains the
 * bare resolver's contract for direct misuse: a caller that bypasses the
 * diagnostic-aware route must still fail loudly rather than silently.
 */
function refuseUnmappedCodexInboundFrame(nativeMethod: string): never {
  throw new UnknownCodexInboundFrameError(nativeMethod);
}

/**
 * Normalize one Codex inbound frame method into its Plan-006 family
 * disposition.
 *
 * Total over the pinned census and pure: no I/O, no clock, no mutation, and
 * the same input always yields the identical frozen singleton. A method
 * outside the census throws {@link UnknownCodexInboundFrameError} — never a
 * silent drop, and never a fabricated family.
 *
 * @param nativeMethod - The JSON-RPC `method` string exactly as it arrived off
 *   the Codex `app-server` wire. Untrusted provider output: it is used only as
 *   a `Map` key and echoed into the refusal as data.
 */
export function normalizeCodexInboundFrame(nativeMethod: string): CodexFrameNormalization {
  const normalization = CODEX_FRAME_NORMALIZATION_BY_METHOD.get(
    nativeMethod as CodexInboundFrameMethod,
  );
  if (normalization === undefined) {
    refuseUnmappedCodexInboundFrame(nativeMethod);
  }
  return normalization;
}

// --------------------------------------------------------------------------
// T3.11 — the daemon-diagnostic default branch (P0-1).
// --------------------------------------------------------------------------

/** The census-mapped emission answer, or the frame's routed diagnostic. */
export type CodexFrameEmissionRoute =
  | { readonly route: "emit"; readonly normalization: CodexNormalizedFamilyEmission }
  | { readonly route: "not-evented"; readonly normalization: CodexNotEventedFrameDisposition }
  | { readonly route: "diagnostic"; readonly record: DriverDiagnosticRecord };

/**
 * The T3.11 P0-1 default branch — the driver core's entry point onto this
 * table. Total over EVERY method string and never throws: a method outside
 * the pinned census, an interim `typePending` kind whose literal has not
 * landed, and a censused kind whose target has no registered payload variant
 * all route to a typed `DriverDiagnosticRecord` emitted through the injected
 * `driver-diagnostics.ts` surface — never a `session_events` envelope and
 * never a silent drop. `EVENT_DISPOSITION_BY_KIND` is the single disposition
 * source consulted for the interim-`typePending` verdict (the Plan-006 T1.8
 * interim-disposition seam).
 */
export function resolveCodexFrameEmissionRoute(
  nativeMethod: string,
  diagnostics: DriverDiagnosticsEmitter,
): CodexFrameEmissionRoute {
  const normalization = CODEX_FRAME_NORMALIZATION_BY_METHOD.get(
    nativeMethod as CodexInboundFrameMethod,
  );
  if (normalization === undefined) {
    const record: DriverDiagnosticRecord = {
      provider: "codex",
      kind: "unmapped_wire_kind",
      rawWireType: nativeMethod,
      dispositionReason:
        "wire method outside the pinned Codex inbound census; routed to the daemon diagnostic default branch, never silently dropped and never forced into an envelope",
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
        provider: "codex",
        kind: "unmapped_wire_kind",
        rawWireType: nativeMethod,
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
      provider: "codex",
      kind: "payload_variant_pending",
      rawWireType: nativeMethod,
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
// T3.11 — family classification for the thread-frame router (NS-91).
// --------------------------------------------------------------------------

/**
 * The two router-band wire names the census union deliberately does not
 * carry. Both are recorded by the corpus — Plan-005 T3.11's routing and
 * usage-delta legs name them verbatim, and `Spec-005 §References`' vendor
 * -schema entry (codex-cli `0.150.1`, regenerated 2026-08-28) records their
 * generated shapes (`ThreadStartedNotification` with `Thread.parentThreadId`;
 * `ThreadTokenUsageUpdatedNotification` with required `threadId` / `turnId`)
 * — but neither is dispositioned by the Plan-006 table into a family
 * emission of its own: `thread/started` is the REGISTRATION INPUT to the
 * thread-frame router, and `thread/tokenUsage/updated` is the READING the
 * usage-delta accountant meters, each consumed at its own T3.11 band rather
 * than projected through the mapping table above.
 */
export const CODEX_THREAD_STARTED_METHOD = "thread/started" as const;
export const CODEX_THREAD_TOKEN_USAGE_METHOD = "thread/tokenUsage/updated" as const;

/**
 * The `turn/*` lifecycle pair, likewise absent from the census union above and
 * likewise router-band rather than mapping-table input.
 *
 * `turn/completed` is the provider's ONLY terminal-turn notification (the
 * generated `ServerNotification` union at the pin carries no `turn/failed` and
 * no `turn/interrupted`; a failed or interrupted turn arrives here and is
 * discriminated by `turn.status`), and it carries a top-level `threadId`, so it
 * is routable by thread identity: on the session's own thread it is the frame
 * the T3.14 emission gate admits, and on a registered child it is that child's
 * terminal — the completion signal the router releases child state on. There is
 * no `thread/status/changed` or `thread/ended` anywhere in the pinned generated
 * root or in `docs/reference/provider-wire/codex.md`, which is why the child
 * terminal is read off this method rather than off a thread-lifecycle one.
 */
export const CODEX_TURN_STARTED_METHOD = "turn/started" as const;
export const CODEX_TURN_COMPLETED_METHOD = "turn/completed" as const;

/**
 * The two census methods the T3.26 console-parity band binds against by
 * IDENTITY rather than by re-spelling (`Spec-005 §Desktop Console Parity
 * Surfaces`).
 *
 * Both are members of the census union above, so unlike the router-band
 * constants beside them these are not "absent from the table" markers — they
 * exist so `lifecycle.ts` compares against the same symbol the mapping table
 * and the family classifier use. A re-spelling in one place and not the other
 * would silently stop settling compaction waits, or silently stop invalidating
 * the held command enumeration, and neither failure has a loud symptom: the
 * first looks like a slow provider and the second like a stale palette.
 */
export const CODEX_THREAD_COMPACTED_METHOD = "thread/compacted" as const;
export const CODEX_SKILLS_CHANGED_METHOD = "skills/changed" as const;

/**
 * The `ThreadSourceKind` arms that mark a provider-attributed SUBAGENT child
 * (spend rides the (`runId`, `provider`, `subagentId`) triple), versus the
 * provider-internal arm (`subAgentCompact` — a compaction thread) whose spend
 * attributes to the parent run at run scope. Per the generated schema at
 * codex-cli `0.150.1` (`Spec-005 §References`).
 */
export const CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS: readonly string[] = Object.freeze([
  "subAgent",
  "subAgentReview",
  "subAgentThreadSpawn",
  "subAgentOther",
]);

/**
 * Derive the router's `ChildThreadAnnouncement` from a Codex `thread/started`
 * notification's identity members, verbatim off the wire. The child thread id
 * doubles as the provider-attributed subagent identity on the subagent-
 * attributed source kinds; a compaction child carries none, so its spend
 * attributes to the parent run.
 */
export function deriveCodexChildThreadAnnouncement(threadStarted: {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly threadSourceKind: string;
}): ChildThreadAnnouncement {
  const subagentAttributed = CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS.includes(
    threadStarted.threadSourceKind,
  );
  return {
    childThreadId: threadStarted.threadId,
    declaredParentThreadId: threadStarted.parentThreadId,
    subagentId: subagentAttributed ? threadStarted.threadId : null,
  };
}

/**
 * Classify one Codex inbound method's FAMILY for the thread-frame router
 * (`Spec-005 §Required Behavior`'s family-scoped routing rule). The census is
 * the discriminator: connection- and account-scoped families route without a
 * thread identity, thread-scoped families demand one, and an unlisted shape
 * is `unknown` — never presumed connection-scoped.
 */
export function classifyCodexFrameFamilyForRouting(nativeMethod: string): ThreadFrameFamilyClass {
  switch (nativeMethod) {
    // Connection- and account-scoped: notices, account-plane quota, auth
    // brokering, attestation, model-level capability signals — and the
    // skill-file watch cue, whose pinned payload is the empty object — frames
    // whose own shape carries no thread identity.
    //
    // Listing `skills/changed` here rather than leaving it `unknown` is
    // load-bearing: an unlisted method quarantines, and quarantining would emit
    // a `thread_frame_quarantined` diagnostic on every save of every watched
    // skill file.
    case "error":
    case "warning":
    case "configWarning":
    case "deprecationNotice":
    case "guardianWarning":
    case "account/rateLimits/updated":
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case "model/safetyBuffering/updated":
    case CODEX_SKILLS_CHANGED_METHOD:
      return { scope: "connection" };
    // Thread-scoped usage: the cumulative token reading the accountant
    // meters, and the thread-level compaction marker.
    case CODEX_THREAD_TOKEN_USAGE_METHOD:
    case CODEX_THREAD_COMPACTED_METHOD:
      return { scope: "thread", capability: "usage" };
    // Thread-scoped lifecycle: the thread-start announcement (the router's
    // registration input) and the turn-boundary pair. `turn/completed` MUST be
    // classified here — it is the session's own terminal, and an unclassified
    // terminal would quarantine instead of reaching the T3.14 emission gate,
    // which admits only a `project` route.
    case CODEX_THREAD_STARTED_METHOD:
    case CODEX_TURN_STARTED_METHOD:
    case CODEX_TURN_COMPLETED_METHOD:
      return { scope: "thread", capability: "lifecycle" };
    // Thread-scoped interactive requests: the approval / input / tool asks.
    case "item/tool/call":
    case "item/tool/requestUserInput":
    case "mcpServer/elicitation/request":
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "execCommandApproval":
    case "applyPatchApproval":
      return { scope: "thread", capability: "interactive-request" };
    // Thread-scoped content and thread-level bookkeeping.
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "process/outputDelta":
    case "process/exited":
    case "turn/moderationMetadata":
    case "autoApprovalReview/strictReviewRequired":
    case "thread/reverted":
    case "thread/queue/changed":
    case "thread/project/updated":
    case "thread/environment/connected":
    case "thread/environment/disconnected":
    case "thread/settings/updated":
    case "turn/diff/updated":
    case "turn/plan/updated":
      return { scope: "thread", capability: "content" };
    // Project-level bookkeeping rides the connection, not a thread.
    case "project/changed":
      return { scope: "connection" };
    default:
      // The realtime family and anything the census does not list: unknown.
      // Never presumed connection-scoped.
      return { scope: "unknown" };
  }
}

// --------------------------------------------------------------------------
// The terminal-emission boundary (Plan-005 T3.14 P1-1 + P1-2-driver).
// --------------------------------------------------------------------------
//
// This module is the SOLE terminal-emission boundary for the Codex leg: the
// provider-native → `run_lifecycle` mapping above lives here, so the two
// properties that attach to a terminal frame attach here too.
//
//   P1-1 — INTENDED CLOSE. A daemon-initiated `closeSession` signals its
//   intent into this boundary through the lifecycle module; the boundary
//   stamps `intendedClose` on the terminal payload so the recovery classifier
//   reads a clean shutdown as a clean shutdown rather than as a crash
//   (`Spec-006 §Run Lifecycle (run_lifecycle)`). The lifecycle module cannot
//   stamp it — it does not own the terminal frame.
//
//   P1-2-driver — DUPLICATE SUPPRESSION. At most one terminal per
//   `(runId, runVersion)` epoch. The primary guard is Plan-004's dispatcher
//   and the schema backstop is Plan-006's partial unique index; without THIS
//   boundary-level suppression a duplicate provider terminal — the ordinary
//   post-interrupt double, or a `turn/completed` racing a process exit —
//   reaches that index and fails loud on a condition the driver could have
//   absorbed.
//
// Routing is CONSUMED here, never re-decided (T3.14's own routing clause): the
// gate takes the `ThreadFrameRoute` the T3.11 router already produced and
// settles a run only on `project`. A child thread's terminal therefore never
// settles the parent's run, and this boundary adds no second source of truth
// for whose stream a frame came from.

/**
 * The Codex leg's bindings for the provider-neutral emission gate.
 *
 * The suppression rule itself lives once at `provider/terminal-emission-gate.ts`
 * — the two driver legs feed ONE shared uniqueness index (the Plan-006 partial
 * unique index), and two implementations of one invariant is one more than the
 * invariant can survive. What stays here is the Codex-named binding, so the
 * driver's own callers and its barrel keep naming a Codex symbol.
 */
export type CodexTerminalRunFrame = TerminalRunFrame;
export type CodexTerminalSuppressionReason = TerminalSuppressionReason;
export type CodexTerminalEmissionDecision = TerminalEmissionDecision;

/**
 * The Codex terminal-emission gate — one instance per provider session, held
 * by the lifecycle module for that session's lifetime.
 *
 * An empty extension rather than an alias: the Codex leg carries no
 * census-specific gate input TODAY, and inventing one to justify a body would
 * be a parameter minted ahead of its reader. The named subclass is what a
 * later census-specific input would land on.
 */
export class CodexTerminalEmissionGate extends TerminalEmissionGate {}

// --------------------------------------------------------------------------
// T3.18 — turn evidence on the Codex wire
// --------------------------------------------------------------------------

/** The `ThreadItem` variant that IS model output at the pin. */
const CODEX_MODEL_OUTPUT_ITEM_TYPE = "agentMessage";

/**
 * `TurnStatus` members that are a DECLARED non-completion.
 *
 * `failed` is the ordinary typed failure (`TurnError.codexErrorInfo` names the
 * cause). `interrupted` joins it because an interrupt is a deliberate daemon
 * act with its own record — loud by construction, never a silent swallow — and
 * a turn stopped on purpose must not be reported as a neutralization failure.
 *
 * `completed` is excluded, and that exclusion is the whole tripwire: a
 * client-side command dispatch reports SUCCESS, so treating `completed` as
 * evidence would make the check unreachable.
 */
const CODEX_DECLARED_NON_COMPLETION_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "interrupted",
]);

/** Every `TurnStatus` member the pin's generated schema carries. */
const CODEX_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);

/** One in-flight turn-evidence reading, keyed by the turn it belongs to. */
export interface CodexTurnEvidenceObservation {
  readonly turnId: string;
  readonly observation: TurnEvidenceClass;
}

function readCodexRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads one in-flight notification for evidence that a model turn is producing
 * output (T3.18), or `null` when the frame carries none.
 *
 * WHY THIS EXISTS AT ALL, rather than reading the terminal frame alone: at the
 * pin `turn/completed` can carry `itemsView: "notLoaded"` beside an EMPTY
 * `items` array — measured, not supposed (`docs/reference/provider-wire/codex.md`).
 * An empty list under that view is an absence of loading, not an absence of
 * output, so a classifier that read only the terminal would call a real turn
 * evidence-free and trip on it. Evidence therefore accrues as the turn runs.
 *
 * Keyed on the item's TYPE tag rather than on any text: `agentMessage` is model
 * output and `userMessage` is the provider's verbatim echo of what was sent —
 * the echo is emphatically NOT evidence that a model saw it, which is exactly
 * the confusion this hazard lives in.
 */
export function classifyCodexTurnEvidenceObservation(
  method: string,
  params: unknown,
): CodexTurnEvidenceObservation | null {
  if (!method.startsWith("item/")) {
    return null;
  }
  const payload = readCodexRecord(params);
  if (payload === null) {
    return null;
  }
  const turnId = payload["turnId"];
  if (typeof turnId !== "string" || turnId.length === 0) {
    return null;
  }
  const item = readCodexRecord(payload["item"]);
  if (item === null || item["type"] !== CODEX_MODEL_OUTPUT_ITEM_TYPE) {
    return null;
  }
  return { turnId, observation: "model_output" };
}

/**
 * Reads a settling `turn/completed` payload for positive, typed evidence that a
 * model turn happened (T3.18, I-005-7).
 *
 * Every field consulted is a typed member of the pinned generated protocol —
 * `TurnStatus`, `TurnError`, and the `ThreadItem` type tag. No message prose is
 * parsed, and in particular `TurnError.message` is never inspected: its text is
 * vendor prose that changes without notice, while `codexErrorInfo` beside it is
 * a typed enum. What the classifier needs from an error is only that one is
 * DECLARED, so it does not read either.
 *
 * `turn.durationMs` is deliberately NOT read as accounting evidence. The
 * measured quota-exhausted turn carried `durationMs: 2838` having reached no
 * model at all, so a duration says the provider spent wall-clock time, not that
 * it spent a turn — and a discriminant that fires on a turn which reached
 * nothing is a discriminant that fails open.
 */
export function classifyCodexTurnEvidence(params: unknown): TurnEvidenceClassification {
  const payload = readCodexRecord(params);
  if (payload === null) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const turn = readCodexRecord(payload["turn"]);
  if (turn === null) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const status = turn["status"];
  if (typeof status !== "string" || !CODEX_TURN_STATUSES.has(status)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }

  const observations: TurnEvidenceClass[] = [];
  const items = turn["items"];
  if (
    Array.isArray(items) &&
    items.some((entry) => readCodexRecord(entry)?.["type"] === CODEX_MODEL_OUTPUT_ITEM_TYPE)
  ) {
    observations.push("model_output");
  }
  if (
    CODEX_DECLARED_NON_COMPLETION_STATUSES.has(status) &&
    typeof readCodexRecord(turn["error"])?.["message"] === "string"
  ) {
    observations.push("declared_turn_failure");
  } else if (status === "interrupted") {
    // An interrupt need not carry an error payload — the daemon knows it asked
    // for one — so the status alone is the declaration here.
    observations.push("declared_turn_failure");
  }
  return observedTurnEvidence(...observations);
}

// --------------------------------------------------------------------------
// T3.16 — Typed provider usage-limit signal, Codex leg
// (`Spec-005 §Fallback Behavior`; verifies I-005-6)
// --------------------------------------------------------------------------
//
// The two account-plane carriers this leg reads, named as constants so the
// binding is by IDENTITY rather than by a string repeated at a call site. Both
// carry the same `RateLimitSnapshot`; they differ only in how it arrives.
//
// The PULL leg is a reply to a daemon-issued request and so is deliberately not
// a member of the inbound-frame census above — the census header states that
// exclusion, and naming the method here does not change it.
export const CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD = "account/rateLimits/read" as const;
export const CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD = "account/rateLimits/updated" as const;

/**
 * Every `RateLimitReachedType` member the pin's generated schema carries —
 * TRANSCRIBED BY HAND from the `RateLimitReachedType` enum published by
 * `codex-cli 0.150.1`, which is the pin `Spec-005` records for this driver.
 *
 * Exported so a test can assert the two dispositions below PARTITION it. What
 * that assertion actually guards is a change to the CLASSIFIER: dropping an arm
 * from one disposition set without placing it in the other, or widening one set
 * past this census, fails it — and either would silently turn a decided arm into
 * an unrecognized one, which is indistinguishable from the outside from a shape
 * never seen before, though excluded and dormant are different states.
 *
 * WHAT IT DOES NOT GUARD, stated because the constant's name invites the wrong
 * reading: an arm the VENDOR adds in a later release is undetected here, since
 * this list is the test's own input rather than a read of the provider's schema.
 * A member new to the wire simply matches neither set and takes the unrecognized
 * path — the fail-quiet direction, and the only one available to a typed-only
 * recognizer, but not a covered case. Re-transcribing this list is part of
 * moving the pin.
 */
export const CODEX_RATE_LIMIT_REACHED_TYPES: readonly string[] = Object.freeze([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

/**
 * The arms that mean A ROLLING ALLOWANCE IS SPENT — the condition that clears on
 * its own when the window turns over, with no operator action.
 */
const CODEX_PLAN_ALLOWANCE_REACHED_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_reached",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

/**
 * The arms that are OPERATOR-REMEDIABLE and therefore deliberately produce NO
 * signal on this axis: a depleted credit balance is restored by a purchase, not
 * by a window turning over, so parking a run against a reset instant would be
 * promising a boundary at which nothing changes.
 *
 * Enumerated rather than left to the fall-through, so the decision is recorded
 * where the classifier is read and the partition test has both halves to check.
 */
const CODEX_OPERATOR_REMEDIABLE_REACHED_TYPES: ReadonlySet<string> = new Set([
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
]);

/**
 * The two account-plane readings a usage-limit classification is made from.
 *
 * BOTH, rather than one frame at a time, because the vendor says so: the push
 * notification's own schema documents it as a "sparse rolling rate-limit update"
 * whose clients "should merge available values into the most recent
 * `account/rateLimits/read` response", and states that a nullable member absent
 * from a rolling update "does not clear a previously observed value". A
 * classifier fed only the push frame would therefore read a routinely-absent
 * window as "the provider reported no reset boundary" — a false reading of a
 * sparse frame rather than a fact about the account.
 *
 * Either member may be `null` when that reading has not been taken; both `null`
 * is a legitimate state and yields no signal.
 *
 * CALLER OBLIGATION — RECENCY IS THE CALLER'S TO MAINTAIN, and it is stated here
 * because the caller is authored elsewhere. The merge below is unconditional:
 * a present value in `rollingUpdate` always wins, which is the vendor's rule and
 * is correct only while the update is the NEWER of the two readings. A caller
 * that refetches `account/rateLimits/read` must therefore DISCARD the rolling
 * update it was holding (set it back to `null`) in the same act, or a stale push
 * will override the fresh read it just took. This shape holds two readings and
 * no clock, so it cannot enforce that ordering itself; it is not inferred from
 * the values, because a boundary that legitimately did not move is
 * indistinguishable from one carried over.
 */
export interface CodexRateLimitObservation {
  /** The `account/rateLimits/read` REPLY body, or `null` if none has landed. */
  readonly latestRead: unknown;
  /** The `account/rateLimits/updated` NOTIFICATION params, or `null`. */
  readonly rollingUpdate: unknown;
}

/** The three snapshot members this classifier reads, after the vendor merge. */
interface CodexMergedRateLimitReading {
  readonly rateLimitReachedType: unknown;
  readonly primary: unknown;
  readonly secondary: unknown;
}

/** Lifts the `rateLimits` snapshot out of either account-plane carrier. */
function readCodexRateLimitSnapshot(carrier: unknown): Record<string, unknown> | null {
  const record = readCodexRecord(carrier);
  return record === null ? null : readCodexRecord(record["rateLimits"]);
}

/**
 * Applies the vendor's stated merge: a value present in the sparse update wins,
 * and a member absent or explicitly null there falls back to the last full read
 * rather than clearing it.
 *
 * Merged MEMBER-BY-MEMBER over exactly what the classifier consumes, not by
 * spreading the untrusted records. A spread-then-assign merge would write
 * attacker-chosen keys onto a prototype-bearing object; enumerating the three
 * read members removes that surface entirely and keeps the reader from carrying
 * fields nothing here looks at.
 *
 * UNCONDITIONAL, never recency-checked — see the caller obligation on
 * {@link CodexRateLimitObservation}.
 */
function mergeCodexRateLimitReading(
  latestRead: Record<string, unknown> | null,
  rollingUpdate: Record<string, unknown> | null,
): CodexMergedRateLimitReading {
  return {
    rateLimitReachedType:
      rollingUpdate?.["rateLimitReachedType"] ?? latestRead?.["rateLimitReachedType"],
    primary: rollingUpdate?.["primary"] ?? latestRead?.["primary"],
    secondary: rollingUpdate?.["secondary"] ?? latestRead?.["secondary"],
  };
}

/**
 * The reset instant of one window, but ONLY when the provider's own reading says
 * that window is the spent one.
 *
 * `usedPercent` is documented as "percentage of the window that has been
 * consumed", so reading it to identify WHICH of the provider's windows is
 * exhausted is not a threshold heuristic standing in for recognition —
 * recognition already happened, on the typed enum, before this is ever called.
 * What it buys is the honesty of the provenance stamp: the instant returned is
 * one the provider stated about the window the provider says is spent, rather
 * than a driver's pick among equals.
 *
 * Numbers are read TOLERANTLY (any finite value, no integer test): the consumed
 * fraction is `f64` in the core protocol type and `i32` in the app-server struct
 * at the pin, and a reader that rejected one of those would fail on the
 * provider's own wire.
 */
function readCodexSpentWindowResetEpochSeconds(window: unknown): number | null {
  const record = readCodexRecord(window);
  if (record === null) {
    return null;
  }
  const usedPercent = record["usedPercent"];
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 100) {
    return null;
  }
  const resetsAt = record["resetsAt"];
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
    return null;
  }
  return resetsAt;
}

/**
 * Unix SECONDS to RFC 3339 UTC, or `null` when the value cannot name an instant.
 *
 * The unit is verified against the pinned protocol source, where `resetsAt` is
 * documented as "Unix timestamp (seconds since epoch) when the window resets"
 * and is copied verbatim into the app-server struct. Reading it as milliseconds
 * would place every boundary about fifty-five years too early — an error that
 * surfaces as "the pacing surface resumes immediately", not as a parse failure.
 */
function codexEpochSecondsToRfc3339Utc(epochSeconds: number): string | null {
  const instant = new Date(epochSeconds * 1000);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * Classifies the account-plane rate-limit readings for a spent usage allowance
 * (T3.16, I-005-6), or `null` when they state none.
 *
 * RECOGNITION IS TYPED-ONLY, and the single gate is the `rateLimitReachedType`
 * enum. No prose is read — `limitName` and `planType` are provider-authored
 * strings this function never inspects — no exit code is read, and no HTTP
 * status is read. Neither is `usedPercent` a recognition input: a snapshot
 * sitting at a hundred percent with no reached-type arm is an account at its
 * ceiling, not a statement that a turn was refused, and treating it as one would
 * park runs the provider is still willing to serve.
 *
 * `spendControlReached` is likewise not read. It is an administrative budget
 * state carried on the snapshot rather than a refusal, and the pin's own schema
 * warns that its absence "is unavailable, not a sparse-update recovery" — a
 * member whose absence carries no information is not a discriminant.
 *
 * `TurnError.codexErrorInfo: "usageLimitExceeded"` is a typed arm that also
 * states this condition, and it is deliberately NOT a source here: it carries no
 * reset boundary of its own at the pin, and the turn-failure classification it
 * belongs to is the permanent-versus-transient refusal axis rather than this
 * one. The account plane is the only carrier stating both the refusal and the
 * instant it lifts.
 *
 * Returns `null` for everything it does not recognize, and that absence means
 * "not known to be limited" — never "known not to be limited".
 */
export function classifyCodexUsageLimitSignal(
  observation: CodexRateLimitObservation,
): ProviderUsageLimitSignal | null {
  const reading = mergeCodexRateLimitReading(
    readCodexRateLimitSnapshot(observation.latestRead),
    readCodexRateLimitSnapshot(observation.rollingUpdate),
  );
  const reachedType = reading.rateLimitReachedType;
  if (typeof reachedType !== "string" || !CODEX_PLAN_ALLOWANCE_REACHED_TYPES.has(reachedType)) {
    // Covers the operator-remediable arms, every unrecognized arm, and absence
    // alike — all three emit nothing rather than a default-caused signal.
    return null;
  }

  // LATEST among the windows the provider marks spent. Picking the earliest
  // would schedule a resume the other window still refuses, converting one park
  // into a retry ladder against a provider that has already said no.
  const spentResets = [reading.primary, reading.secondary]
    .map(readCodexSpentWindowResetEpochSeconds)
    .filter((epochSeconds): epochSeconds is number => epochSeconds !== null);
  if (spentResets.length === 0) {
    return { cause: "plan-allowance-exhausted" };
  }
  const resetsAt = codexEpochSecondsToRfc3339Utc(Math.max(...spentResets));
  if (resetsAt === null) {
    return { cause: "plan-allowance-exhausted" };
  }
  return {
    cause: "plan-allowance-exhausted",
    resetBoundary: { resetsAt, provenance: "provider-stated" },
  };
}

/**
 * The operator-remediable arms, exported for the partition assertion only.
 *
 * Read by no production path: the classifier's gate is the plan-allowance set,
 * and every other arm falls through to `null` by that gate alone. This export
 * exists so the decision to exclude these two is CHECKED rather than merely
 * written down.
 */
export const CODEX_USAGE_LIMIT_EXCLUDED_REACHED_TYPES: readonly string[] = Object.freeze([
  ...CODEX_OPERATOR_REMEDIABLE_REACHED_TYPES,
]);
