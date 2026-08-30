// Internal provider-driver contract — the normalized surface every provider
// integration (Codex, Claude, …) implements so the session engine never sees
// provider-native types. Exact field set mirrors the canonical TypeScript
// shapes in docs/architecture/contracts/api-payload-contracts.md § Plan-005 —
// Provider Driver Contract (verbatim — adding/removing/renaming a field here is
// a contract break and requires the spec edit first).
//
// Trust-boundary asymmetry — why some surfaces are nominal TS and others are Zod:
//   1. NOMINAL TypeScript (no runtime validation), of two distinct origins:
//        (a) daemon-CONSTRUCTED PARAMS — the `ProviderDriver` methods and all
//            param types (`CreateSessionParams` … `ApplyInterventionParams` + the
//            intervention payloads). The daemon constructs these in-process and
//            hands them to the driver; the caller IS the trusted runtime, so
//            there is genuinely nothing untrusted to parse.
//        (b) driver-CONSTRUCTED RETURNS — the capability / handle / model / mode
//            shapes (`DriverCapabilityFlag`, `DriverCapabilities`,
//            `GetCapabilitiesResult`, `ProviderSessionHandle`, `ProviderModel`,
//            `ProviderMode`). These are NOT daemon-constructed: `getCapabilities`
//            returns `GetCapabilitiesResult`/`DriverCapabilities`, `createSession`
//            returns `ProviderSessionHandle`, `listModels`/`listModes` return
//            `ProviderModel`/`ProviderMode`. They ship nominal by design (T1.2) —
//            see the two-boundary model below for why that is sound.
//        TWO-BOUNDARY MODEL: a driver MAY call a remote/native provider behind
//      these methods (I-005-1). The trust boundary is at the *driver*, not at
//      this contract layer. The driver — the Plan-005 Phase 3 implementation,
//      which is daemon-OWNED code — normalizes raw provider output at ITS
//      boundary and returns these nominal types to the daemon as already-trusted
//      normalized values. The contract-definition layer here does not re-parse
//      them; re-parsing trusted-after-normalization output would be redundant.
//        PRINCIPLE (what Phase 1 Zod-validates, and what it deliberately does
//      not): Phase 1 validates HERE only the returns that carry a
//      contract-level invariant or normalization — `DriverResumeResult`
//      (I-005-5 structural), `ProviderToolMetadata` (I-005-3 `.default()`
//      normalization), and `DriverInterventionResult` (ratified wire shape; see
//      (2)). EVERY OTHER provider-output return is validated at its
//      write/normalize seam — Plan-005 Phase 2 (T2.x persistence write path) or
//      Phase 3 (driver normalization) — NOT at this contract-definition layer.
//      Two concrete persisted fields are deferred-but-TRACKED this way:
//      `DriverCapabilities.contractVersion` (persisted to
//      `driver_contract_meta.contract_version`, a semver) and
//      `ProviderSessionHandle.resumeHandle` (persisted to
//      `runtime_bindings.resume_handle`) receive their length / format bounds at
//      the Phase-2 write seam (Plan-005 §Phase 2 provider-output-validation
//      obligation), NOT at this layer.
//   2. ZOD-VALIDATED HERE: the SEVEN driver RESULT envelopes
//      (`DriverInterventionResultSchema`, `DriverResumeResultSchema`, the
//      three T1.8 adds — `DriverRollbackResultSchema`, `DriverGoalResultSchema`,
//      `DriverAuthProbeResultSchema`, one per RESULT TYPE rather than one per
//      operation: T1.8 added FOUR value-returning operations, but
//      `setSessionGoal` and `clearSessionGoal` SHARE `DriverGoalResult`, so the
//      four collapse to three envelopes — and the two T3.19 adds,
//      `DriverTranscriptExportResultSchema` /
//      `DriverTranscriptReplayResultSchema`), the provider-DECLARED tool metadata
//      (`ProviderToolMetadataSchema`), and the two driver-NORMALIZED seam shapes
//      (`CallbackToolInvocationSchema`, `McpServerStatusEmissionSchema`), each
//      built from provider wire output BEFORE the daemon-injected
//      `CreateSessionParams` callback sees it. The canonical doc's trust-boundary
//      header enumerates the first EIGHT; the two transcript envelopes join them
//      on that same rule rather than on a new one — a driver constructs each from
//      what its own provider accepted, and each carries the closed-vocabulary
//      `declaredLosses`, where an unnamed loss class is precisely the drift a
//      caller reading "nothing was dropped" off an empty array must not inherit.
//      All TEN parse UNTRUSTED provider output — the trust boundary — so they need
//      runtime validation. `ProviderToolMetadataSchema` additionally carries the
//      parse-time `idempotency_class` → `manual_reconcile_only` normalization
//      that only a schema's `.default()` provides (I-005-3).
//        Within these Zod-validated surfaces there is a further asymmetry: the
//      result envelopes are `.strict()` (fixed-protocol response shapes — an
//      unknown key signals a protocol violation, so reject), while
//      `ProviderToolMetadataSchema` STRIPS unknown keys (extensible declaration
//      surface — `Spec-005 §Default Behavior` forward-compat: "Unknown capability fields are
//      ignored (tolerant reader)"). The two seam shapes side with the
//      ENVELOPES, not with the tool metadata: `CallbackToolInvocation` and
//      `McpServerStatusEmission` are fixed-field wire translations the DRIVER
//      constructs, so the tolerant-reader rationale (an extensible surface the
//      PROVIDER declares and later versions grow) does not reach them — an
//      unknown key there is a driver bug, so both are `.strict()`. And
//      every untrusted free-form string parsed here is length / non-whitespace /
//      NUL-bounded via the package's `wireFreeFormString` helper (session.ts),
//      not a bare `z.string()` — these defense-in-depth bounds prevent
//      persistence / log-injection hazards on values that reach `driver_tools`,
//      `runtime_bindings`, and `runtime_node.capability_*` events. After T1.8
//      this file realizes ALL TWELVE strings the canonical doc's twelve-string
//      enumeration names, over the EIGHT length caps declared below.
//   3. The CLIENT-FACING SDK-SEAM Zod schemas (`InterruptRunParamsSchema`,
//      `RunIdSchema`, …) validate client→daemon WIRE input — a DIFFERENT
//      boundary — and ship in Phase 4 (T4.2). Do not conflate them with (2):
//      (2) guards provider→daemon output; the SDK seam guards client→daemon input.
//
// I-005-1 (driver authority remains local even when the provider endpoint is
// remote): this contract IS the local surface. A driver MAY call a remote
// provider API behind these methods, but the control + execution authority
// stays attached to the local runtime node. The types deliberately carry no
// remote-authority handle, hosted-session reference, or control-plane dispatch
// shape — there is no way to express "execute via the control plane" in this
// contract, which is how the type system preserves the invariant.
//
// Refs: `Spec-005 §Required Behavior` (normalized contract), `Spec-005 §Required Behavior` (16-op surface),
// `Spec-005 §Required Behavior` (intervention surface), `Spec-005 §Required Behavior` (tool-metadata ingress),
// `Spec-005 §Default Behavior` (forward-compat unknown-field strip), `Spec-005 §Fallback Behavior` (resume-failure
// surfacing), `Spec-005 §Interfaces And Contracts` (Required driver operations anchor), Plan-005 Phase 1,
// ADR-011 (capability flags), CP-005-6 (RunId co-location).

import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { wireFreeFormString, SessionIdSchema, type SessionId, type ChannelId } from "./session.js";

// --------------------------------------------------------------------------
// Branded ID
// --------------------------------------------------------------------------
//
// `RunId` is the canonical run identifier. It is co-located here (NOT in
// session.ts) per CP-005-6: Plan-001 ships no run-domain symbol, and this
// driver contract is `RunId`'s lowest-tier consumer (the run-oriented method
// params `startRun` / `interruptRun` / `applyIntervention` / `respondToRequest`),
// so the brand originates with Plan-005.
//
// Brand form matches session.ts (`SessionId` etc.) verbatim — a TypeScript-only
// nominal type whose runtime is a plain UUID string. Making the shape
// structurally identical to api-payload-contracts.md § Branded ID Types lets
// cross-package consumers verify their imports against the doc.
//
// TYPE-ONLY at Phase 1 by design: the paired `RunIdSchema`
// (`brandedUuidIdSchema<RunId>("RunId")`) co-locates at T4.2 — its first
// consumer is `InterruptRunParamsSchema` at the SDK seam. Authoring the schema
// here would break the deliberate type-only ratification of Phase 1.
export type RunId = string & { readonly __brand: "RunId" };

// --------------------------------------------------------------------------
// ProviderDriver — the 16-operation normalized contract (`Spec-005 §Interfaces And Contracts`)
// --------------------------------------------------------------------------
//
// T1.1 shipped ten operations; T1.8 added the four R8 parity operations
// (`rollbackTo`, `setSessionGoal`, `clearSessionGoal`, `probeAuth`) and T3.19
// the two transcript operations (`exportTranscript`, `replayTranscript`), each at
// the position the canonical doc interleaves it, so this surface reads against
// api-payload-contracts.md § Plan-005 line-for-line rather than appending a
// tail block that would have to be re-sorted later.
//
// The two daemon-injected callbacks (`onCallbackToolCall`, `onMcpServerStatus`)
// are absent by design — they are `CreateSessionParams` MEMBERS, not operations,
// so they never widen this surface whatever its arity.
//
// The type names referenced by the signatures below (`ApplyInterventionParams`,
// `DriverInterventionResult`, `DriverResumeResult`, `GetCapabilitiesResult`,
// `RollbackToParams`, `DriverRollbackResult`, `SetSessionGoalParams`,
// `ClearSessionGoalParams`, `DriverGoalResult`, `DriverAuthProbeResult`,
// `ExportTranscriptParams`, `DriverTranscriptExportResult`,
// `ReplayTranscriptParams`, `DriverTranscriptReplayResult`) and
// their transitive dependencies
// (`DriverCapabilities` / `DriverCapabilityFlag`, `IdempotencyClass` /
// `ProviderToolMetadata`, `DriverCliVersionReport`, `ExecutionPosture`,
// `SessionCallbackTool`, `SubagentPolicy`, `CallbackToolInvocation` /
// `CallbackToolResult`, `McpServerStatusProducer`) are defined further down in
// this same file.
export interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;
  // Capability-GATED on the `rollback` flag (I-005-2): a call against an
  // undeclared flag refuses statically with `driver.capability_unsupported`
  // before dispatch. `degraded` is the DYNAMIC outcome of a driver that WAS
  // invoked and reported its fallback (I-005-4) — the two are not interchangeable.
  rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  // Both goal operations are capability-gated on the `session_goals` flag, under
  // the same static-refusal / dynamic-degrade split as `rollbackTo` above.
  setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult>;
  clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult>;
  closeSession(params: CloseSessionParams): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
  // NOT capability-gated — deliberately flagless, and REQUIRED of every driver:
  // a zero-turn authentication probe. There is no `auth_probe` capability flag to
  // declare, so a driver cannot opt out by silence (the same I-005-2 reasoning
  // that keeps `pause` off the flag list, applied in the opposite direction).
  probeAuth(): Promise<DriverAuthProbeResult>;
  // NOT capability-gated, and required of every driver: rendering the canonical
  // transcript is how a driver declares what it can carry, so a driver that
  // could not answer it could not report its losses either. PURE with respect to
  // session state — it mutates nothing, writes nothing, and starts no turn. The
  // transcript is passed IN rather than fetched: it is a projection the daemon
  // rebuilds per call, and a driver holding a handle to it would be holding a
  // second record of the log, which is the divergence ADR-029 eliminates.
  exportTranscript(params: ExportTranscriptParams): Promise<DriverTranscriptExportResult>;
  // Capability-GATED on the `transcript_replay` flag, under the same
  // static-refusal / dynamic-degrade split as `rollbackTo` above. Reconstitutes a
  // conversation into a FRESH provider session and never writes to the SOURCE
  // session. Returns only after the post-replay assertion passes, because the
  // injection surface is untyped at the wire: a returned success is validated
  // against nothing, so it is not evidence a replay worked.
  replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult>;
}

// --------------------------------------------------------------------------
// Method parameter + return shapes
// --------------------------------------------------------------------------
//
// Leaf param/return types required by the 14 signatures above. Authored here
// (not in a companion task) because the interface cannot resolve without them
// and no later Phase-1 task owns them. Fields mirror api-payload-contracts.md
// § Plan-005 verbatim.

export interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
  // Spawn-time realization of the native-cap-escape admitted cap: providers that
  // bind budget caps at process spawn (Claude `--max-budget-usd`) realize it here,
  // so the initial create path never launches a native-cap-admitted leg capless —
  // api-payload-contracts.md §Plan-005 CreateSessionParams mirror (Spec-016 §Cost
  // Derivation And Absent-Cost Semantics, campaign B6). Same idiom note as
  // StartRunParams below.
  admittedCostCapCents?: number | undefined;
  // The five spawn-bound parity legs (T1.8). Each is realized by the provider
  // legs that bind that surface AT PROCESS SPAWN — the per-run/per-turn carriers
  // are `StartRunParams` — so a leg that binds at spawn and receives nothing here
  // launches without it. `ResumeSessionParams` re-declares all of them plus the
  // two function legs below, because resume is a FRESH spawn (see there).
  executionPosture?: ExecutionPosture | undefined;
  // Gated on the `callback_tools` flag. Codex maps these onto function-form
  // `dynamicTools`; Claude hosts the same registry as a daemon-hosted ephemeral
  // MCP server (`--mcp-config`), where they surface as `mcp__<server>__<tool>`.
  callbackTools?: SessionCallbackTool[] | undefined;
  // Gated on the `subagents` flag.
  subagentPolicy?: SubagentPolicy | undefined;
  // Gated on the `structured_output` flag. A normalized JSON Schema constraining
  // schema-constrained final output. The Claude leg binds it PER SESSION here
  // (`--json-schema`); the Codex leg realizes it PER TURN via
  // `StartRunParams.outputSchema` — which is why both carriers declare it.
  outputSchema?: Record<string, unknown> | undefined;
  // Daemon-injected callback-tool dispatcher (gated on `callback_tools`). The
  // driver invokes it on a provider callback-tool request and answers the
  // provider with the result, so no invocation is left unanswered and no
  // approval bypass is invented. Its daemon-side host routes every invocation
  // through Plan-012's Cedar pipeline (CP-005-7) — Plan-005 authors no Plan-012
  // symbol, which is why this is an INJECTED closure rather than a dependency.
  onCallbackToolCall?:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  // Daemon-injected MCP server-status sink. Producer-only at Plan-005 (the
  // consumer is Plan-028's status normalizer). The daemon PRE-BINDS this closure
  // to the leg identity (sessionId + the store-minted bindingId) at spawn, so the
  // driver never supplies leg identity and cannot misattribute — or spoof —
  // another leg's rows; that is also why the init census the driver emits DURING
  // `createSession` needs no id the driver does not yet have.
  onMcpServerStatus?: McpServerStatusProducer | undefined;
}

export interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
  // Recovery wire-through of the native-cap-escape admitted cap: resume/relaunch
  // re-threads the run.queued server-stamped value so the provider-side hard stop
  // survives daemon restart and session relaunch — api-payload-contracts.md
  // §Plan-005 ResumeSessionParams mirror (Spec-016 §Cost Derivation And
  // Absent-Cost Semantics, campaign B6). Same idiom note as StartRunParams below.
  admittedCostCapCents?: number | undefined;
  // Resume is a FRESH PROCESS SPAWN (the C-12 posture-relaunch precedent — an
  // existing process never mutates into a resumed leg), so every spawn-bound
  // surface `CreateSessionParams` binds must RE-REALIZE here or the resumed leg
  // silently sheds it: a posture-less resume relaunches UNSANDBOXED, a
  // schema-less one unconstrained. That is a security property, not a
  // convenience, which is why these are duplicated rather than inherited.
  //
  // The four DATA legs are reconstructed by the daemon from the durable
  // `runtime_bindings.spawn_config` record (written at every spawn; the column
  // ships with T1.7's currency migration) — never from the original client
  // request, which recovery does not have. The two FUNCTION legs are re-injected
  // fresh at every spawn; functions are never stored in `spawn_config`.
  executionPosture?: ExecutionPosture | undefined;
  callbackTools?: SessionCallbackTool[] | undefined;
  subagentPolicy?: SubagentPolicy | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  // An omitted rebind would strand provider callback-tool requests unanswered on
  // the resumed leg.
  onCallbackToolCall?:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  // Re-injected census sink, pre-bound to the RESUMED leg's identity — the
  // resumed leg re-emits its init census through it.
  onMcpServerStatus?: McpServerStatusProducer | undefined;
}

export interface StartRunParams {
  runId: RunId;
  channelId: ChannelId;
  agentConfig: Record<string, unknown>;
  // Native-cap-escape wire-through: the run.queued server-stamped admitted family
  // cap, realized as the provider's native hard cap on cap-capable legs (Claude
  // `--max-budget-usd`) — api-payload-contracts.md §Plan-005 StartRunParams mirror
  // (Spec-016 §Cost Derivation And Absent-Cost Semantics, campaign B6).
  admittedCostCapCents?: number | undefined;
  // `?: T | undefined` (not bare `?: T`) per the package idiom under
  // `exactOptionalPropertyTypes: true` — see session.ts:252-257. T4.2 has no
  // `StartRunParamsSchema` (lifecycle ops are daemon-internal per Phase 4
  // decision #2), but the idiom is uniform across this package's interfaces.
  conversationHistory?: unknown[] | undefined;
  // The per-run EFFECTIVE posture — the same object the daemon stamps on
  // `run.running` (Spec-006 §Run Lifecycle). Codex realizes it per turn (the
  // `turn/start` sandbox params); a provider that binds posture at spawn realizes
  // it at session boundaries instead, and a mid-session posture change on such a
  // leg resolves via SESSION RELAUNCH — never a silent partial application.
  executionPosture?: ExecutionPosture | undefined;
  // Per-turn schema-constrained final output (the Codex `turn/start.outputSchema`
  // leg); the Claude leg binds the same schema at spawn via
  // `CreateSessionParams.outputSchema`. Gated on the `structured_output` flag.
  outputSchema?: Record<string, unknown> | undefined;
}

export interface InterruptRunParams {
  runId: RunId;
  // `?: T | undefined` per the package idiom under `exactOptionalPropertyTypes`
  // (session.ts:252-257). Load-bearing here: T4.2 pairs `InterruptRunParamsSchema`
  // (`Plan-005 §Phase 4 — Client SDK exposure + degraded-fallback`), whose Zod `.optional()` infers `string | undefined` — the
  // explicit `| undefined` keeps the interface and the inferred schema output aligned.
  reason?: string | undefined;
}

export interface RespondToRequestParams {
  runId: RunId;
  requestId: string;
  response: unknown;
}

export interface CloseSessionParams {
  sessionId: SessionId;
}

// Driver-CONSTRUCTED return (§1(b)) of `createSession` / `resumeSession`. Both
// fields are opaque provider-owned blobs. `resumeHandle` is persisted to
// `runtime_bindings.resume_handle` and bounded (non-empty + length + NUL-reject)
// at the Plan-005 Phase-2 write seam (§Phase 2 provider-output-validation
// obligation), NOT re-parsed here — `Spec-005 §Required Behavior` (drivers persist provider-owned
// resume handles separately from canonical session/run ids).
export interface ProviderSessionHandle {
  providerSessionId: string;
  resumeHandle: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
}

export interface ProviderMode {
  id: string;
  name: string;
}

// --------------------------------------------------------------------------
// T1.2 — Capability flags (`Spec-005 §Required Behavior`; verifies I-005-2)
// --------------------------------------------------------------------------
//
// Nominal TypeScript — NO Zod. The capability surface is a driver-CONSTRUCTED
// return (§1(b)): the driver normalizes raw provider output at its own Plan-005
// Phase-3 boundary and returns this already-trusted shape, so the contract layer
// does not re-parse it. `contractVersion` carries no contract-level invariant
// that forces a schema here — it is a provider-output value bounded (semver +
// length) at the Plan-005 Phase-2 write seam (§Phase 2 provider-output-validation
// obligation, persisted to `driver_contract_meta.contract_version`), not here.

// Canonical runtime companion to the DriverCapabilityFlag union — the SINGLE
// source the type below, the `driver_capabilities.capability_flag` CHECK list
// each migration freezes (a point-in-time copy — see note), the write-seam
// cardinality guard (`assertValidCapabilityFlags`), and the T2.4 test fixtures
// all derive from.
// Order mirrors api-payload-contracts.md §Shared Enums `DriverCapabilityFlag`
// verbatim. `pause` is intentionally EXCLUDED per ADR-011: pause is modeled as
// an `InterventionType`, not a static capability flag, so a driver cannot
// advertise a `pause` capability at all — the type system makes the
// mis-modeling unrepresentable.
//
// T1.7 widens this from T1.2's seven flags to THIRTEEN, appending
// `structured_output` / `rollback` / `session_goals` / `callback_tools` /
// `subagents` (campaign B3) and `cost_cap` (campaign B6).
//
// T3.19 widens it to FOURTEEN with `transcript_replay`, INSERTED between
// `subagents` and `cost_cap` rather than appended: this array's order IS the
// canonical §Shared Enums order, a conformance test compares it
// element-for-element, and an appended member would read as a different enum to
// every consumer that iterates it.
//
// Widening stays a coordinated change: this array + a NEW migration + every
// total `Record<DriverCapabilityFlag, boolean>` declaration. Each SHIPPED
// migration's CHECK is immutable history — 0003 froze the seven-flag list, and
// T1.7's currency migration supersedes it by widening the CHECK to all FOURTEEN
// canonical values at once (a CHECK is a whitelist; admitting a value ahead of
// its first row costs nothing, while a second CHECK-widening migration costs an
// ordinal) while backfilling ROWS only for the thirteen it declared. The row
// set, not the CHECK, is the leg that tracks this union's exact cardinality, and
// it is why migration 0012 exists at all: the writer's snapshot reader enforces
// an exact `DRIVER_CAPABILITY_FLAGS.length`, so a cache left at thirteen rows
// fails the NEXT HYDRATE — before any capability refresh could have healed it.
export const DRIVER_CAPABILITY_FLAGS = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "structured_output",
  "rollback",
  "session_goals",
  "callback_tools",
  "subagents",
  "transcript_replay",
  "cost_cap",
] as const;

export type DriverCapabilityFlag = (typeof DRIVER_CAPABILITY_FLAGS)[number];

// `flags` is a `Record<DriverCapabilityFlag, boolean>` (not a partial / array),
// so every flag MUST be answered — a driver cannot silently omit a capability,
// which is the structural form of I-005-2 (capabilities are explicit, not
// inferred from absence).
export interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
}

// --------------------------------------------------------------------------
// T1.3 — Tool metadata + idempotency (`Spec-005 §Required Behavior`;
//         `Spec-015 §Idempotency Classes and Recovery Behavior`; verifies I-005-3)
// --------------------------------------------------------------------------
//
// Per-tool idempotency classification used by the daemon's two-phase
// command-receipt protocol during crash recovery (Spec-005 §Tool Metadata;
// Spec-015 §Idempotency Protocol).
export type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

// Per-field length caps — defense-in-depth bounds on the UNTRUSTED free-form
// strings the three Zod schemas below parse at the provider→daemon trust
// boundary. The HTTP/JSON-RPC framework layer (Plan-004/005) is authoritative on
// body size; these caps are a SECOND line of defense (mirrors error.ts:130). All
// EIGHT are consumed via `wireFreeFormString` (rejects empty / whitespace-only /
// NUL / over-max) — bare `z.string()` would let unbounded provider output reach
// `driver_tools`, `runtime_bindings`, and `runtime_node.capability_*` events.
// Eight caps cover TWELVE fields because three are reused across surfaces that
// carry the same category of value (see the per-cap notes) — the twelve are
// exactly the canonical doc's twelve-string enumeration, all of which this file
// now realizes.
//
//   • DRIVER_TOOL_NAME_MAX_LEN (128) — the tool `name` on BOTH surfaces that
//     carry one (`ProviderToolMetadata.name`, the provider-DECLARED tool, and
//     `CallbackToolInvocation.toolName`, the driver-NORMALIZED invocation that
//     names it back); a name/label tier token. Same-category reuse — the
//     invocation's name is resolved against the declaration's, so a cap that
//     let the two diverge would make an unresolvable name representable.
//   • DRIVER_TOOL_DESCRIPTION_MAX_LEN (16384) — tool `description`; prose/message
//     tier. MCP-style descriptions can embed parameter-schema docs that exceed
//     8 KiB, and the helper REJECTS on overlength (no truncation), so this is
//     sized generously to avoid dropping a legitimate verbose description while
//     still bounding pathological sizes.
//   • DRIVER_FALLBACK_ACTION_MAX_LEN (128) — the `fallbackAction` hint on ALL
//     THREE degradable result envelopes (`DriverInterventionResult`,
//     `DriverRollbackResult`, `DriverGoalResult`); a short hint token (e.g.
//     `queue_and_interrupt`). One cap because it is one category of value —
//     a per-envelope cap would let the three drift apart for no reason.
//   • DRIVER_BINDING_ID_MAX_LEN (256) — the `bindingId` on BOTH envelopes that
//     report one (`DriverResumeResult`, `DriverRollbackResult.applied`); an
//     opaque store-minted session-binding surrogate persisted into
//     `runtime_bindings`. Same-category reuse as above.
//   • DRIVER_FAILURE_DETAIL_MAX_LEN (32768) — resume `providerFailureDetail`;
//     prose/message tier failure detail. Sized generously (32 KiB) because a
//     legitimate failure detail may wrap an upstream stack trace / nested-cause
//     chain, and a reject here would LOSE the signal `Spec-005 §Fallback Behavior` mandates; a
//     value still exceeding this is pathological (see the field comment below).
//   • DRIVER_AUTH_DETAIL_MAX_LEN (512) — `DriverAuthProbeResult.detail`; a
//     provider-reported account/plan descriptor (e.g. a plan name + seat email),
//     so the short-prose tier, NOT the 32 KiB failure-detail tier: unlike a
//     resume failure it wraps no stack trace, and unlike a name token it is a
//     sentence. A reject here loses only descriptive colour — the probe's
//     `status`, which carries the fail-closed admission decision, is unaffected.
//   • DRIVER_TOOL_CALL_ID_MAX_LEN (256) — `CallbackToolInvocation.toolCallId`;
//     an opaque provider correlation id, sized on the same opaque-handle tier as
//     `DRIVER_BINDING_ID_MAX_LEN` (a distinct constant because the two are
//     independently owned — the provider mints one, the store the other).
//   • DRIVER_MCP_SERVER_NAME_MAX_LEN (128) — `McpServerStatusEmission.serverName`;
//     a name/label-tier token, same tier as the tool `name` above.
export const DRIVER_TOOL_NAME_MAX_LEN = 128;
export const DRIVER_TOOL_DESCRIPTION_MAX_LEN = 16384;
export const DRIVER_FALLBACK_ACTION_MAX_LEN = 128;
export const DRIVER_BINDING_ID_MAX_LEN = 256;
export const DRIVER_FAILURE_DETAIL_MAX_LEN = 32768;
export const DRIVER_AUTH_DETAIL_MAX_LEN = 512;
export const DRIVER_TOOL_CALL_ID_MAX_LEN = 256;
export const DRIVER_MCP_SERVER_NAME_MAX_LEN = 128;

// Declared BEFORE `ProviderToolMetadataSchema` because `const` schemas do not
// hoist (unlike the `type` declarations above) and the tool-metadata schema
// references this one.
//
// Double-`T` `z.ZodType<IdempotencyClass, IdempotencyClass>` — NOT the single-
// param `SessionStateSchema` form (session.ts:141). Single-param leaves the
// INPUT slot defaulting to `unknown`; when this enum is composed via
// `.optional().default(...)` into the transforming `ProviderToolMetadataSchema`
// below, that `unknown` input propagates and fails to match the hand-written
// ingress `idempotency_class?: IdempotencyClass | undefined` under
// `exactOptionalPropertyTypes` (TS2375). Pinning the input slot to the enum
// union keeps the parent's Output/Input annotation sound — the same double-`T`
// discipline session.ts:289-294 documents, applied here because this is the
// only composed named sub-schema in the file.
export const IdempotencyClassSchema: z.ZodType<IdempotencyClass, IdempotencyClass> = z.enum([
  "idempotent",
  "compensable",
  "manual_reconcile_only",
]);

// INGRESS shape — what a provider driver DECLARES via `getCapabilities()`.
// `idempotency_class` is OPTIONAL: a driver MAY omit it and an undeclared class
// is NOT a contract violation. Were the field required at ingress, Zod would
// reject a conformant-but-silent driver BEFORE the default could apply,
// defeating `Spec-005 §idempotency_class`.
export interface ProviderToolMetadata {
  name: string;
  idempotency_class?: IdempotencyClass | undefined;
  description?: string | undefined;
}

// NORMALIZED shape — the daemon-side projection AFTER the normalization seam has
// applied the `manual_reconcile_only` default. `idempotency_class` is REQUIRED,
// so the type system forbids persisting an un-normalized value into the NOT NULL
// `driver_tools.idempotency_class` column or emitting it on a
// `runtime_node.capability_*` event. This is the only tool-metadata shape that
// crosses the persistence / event-payload boundary; ingress `ProviderToolMetadata`
// never does.
export interface NormalizedProviderToolMetadata {
  name: string;
  idempotency_class: IdempotencyClass;
  description?: string | undefined;
}

// This package's FIRST transforming schema (Input ≠ Output): the
// `.optional().default("manual_reconcile_only")` makes `idempotency_class`
// optional on the INPUT (a driver may omit it) but REQUIRED on the OUTPUT (the
// default fills it), which is exactly the I-005-3 ingress→normalized
// transition. The annotation is therefore Output-first / Input-second:
// `z.ZodType<NormalizedProviderToolMetadata, ProviderToolMetadata>`. Both
// interfaces are HAND-WRITTEN (above) rather than `z.input`/`z.output`-derived —
// derivation would be circular against this required annotation, and the
// package has zero such usage.
//
// Unknown keys are STRIPPED (dropped from the normalized output), NOT rejected:
// the `z.object()` default already strips, which is exactly `Spec-005 §Default Behavior`'s
// "Unknown capability fields are ignored (tolerant reader)" — the extensible
// tool-metadata DECLARATION surface
// must stay forward-compatible. This is a DELIBERATE contrast to the
// result-envelope schemas (`DriverInterventionResultSchema`,
// `DriverResumeResultSchema`) which KEEP `.strict()`: those are fixed-protocol
// response shapes where an unknown key signals a protocol violation. (No chained
// `.strip()` — the `z.object()` default already strips; Zod 4 still declares the
// method but marks an explicit `.strip()` redundant.) The two free-form strings
// are `wireFreeFormString`-bounded.
export const ProviderToolMetadataSchema: z.ZodType<
  NormalizedProviderToolMetadata,
  ProviderToolMetadata
> = z.object({
  name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "ProviderToolMetadata.name"),
  idempotency_class: IdempotencyClassSchema.optional().default("manual_reconcile_only"),
  description: wireFreeFormString(
    DRIVER_TOOL_DESCRIPTION_MAX_LEN,
    "ProviderToolMetadata.description",
  ).optional(),
});

// CLI-version report carried on the nominal `GetCapabilitiesResult` return
// (T1.8). NOMINAL, not Zod, for the same §1(b) reason as `contractVersion`: it is
// driver-normalized output, and `raw` takes its non-empty / length / NUL bounds
// at the Plan-005 Phase-2 write seam where it is persisted, not at this layer.
//
// `semver` is REQUIRED, which is the whole point of the pair: an UNPARSEABLE
// provider version is structurally unrepresentable in this shape, so the driver
// must fail the report fail-closed rather than hand the daemon a report it cannot
// compare against its configured per-driver floor. Attach then refuses as
// `driver.cli_version_unparseable`; a parseable version BELOW the floor refuses
// as `driver.cli_version_below_floor`. The floor VALUES are Spec-005's and are
// deliberately not restated here.
//
// Both values are read from the version the SPAWNED PROCESS reports in-band —
// never from a launcher symlink, which can name a different build than the one
// that will actually run.
export interface DriverCliVersionReport {
  raw: string;
  semver: string;
}

// Return type of `ProviderDriver.getCapabilities()` — nominal TS. `Spec-005 §Tool Metadata`
// semantically separates whole-driver capability flags from per-tool metadata;
// this wrapper keeps `DriverCapabilities` pure (flags + contractVersion only)
// while carrying both surfaces in a single round-trip. `tools` is the INGRESS
// `ProviderToolMetadata[]` (pre-normalization, as declared by the provider) —
// normalization to `NormalizedProviderToolMetadata` happens at the daemon's
// hydration seam (Plan-005 T2.4), not at this return shape.
//
// `cliVersion` (T1.8) is REQUIRED — a capability report without a parseable
// provider version never reaches the daemon at all (fail-closed by
// construction). It is a property of THIS READING rather than of a capability,
// which is why it rides the wrapper and `DriverCapabilities` stays pure (flags +
// contractVersion); it is deliberately NOT mirrored onto the event-boundary
// `CapabilityDetails`, because the version floor is an attach-time gate, not a
// per-snapshot capability property.
//
// The canonical doc additionally declares an additive-optional `detectionSource`
// member here; it is NOT authored by T1.8 — Plan-005 T3.24 owns it by name,
// together with the `CapabilityDetectionSource` type it carries.
export interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
  cliVersion: DriverCliVersionReport;
}

// --------------------------------------------------------------------------
// T1.4 — Intervention surface (`Spec-005 §Required Behavior`, ADR-011; verifies I-005-4)
// --------------------------------------------------------------------------
//
// `InterventionType` is DEFINED here (co-located per CP-005-6): Plan-005 is its
// lowest-tier author, and Plan-004 Tier 5 imports it from this contract. Mirrors
// `docs/architecture/contracts/api-payload-contracts.md §Shared Enums` verbatim.
//
// T1.8 widens this three-member union to FOUR. `rollback` is Spec-004 content
// (campaign B2) landing here because this file is the enum's co-located home;
// Plan-004's Tier-5 orchestration imports the widened union, and its Phase 1
// machine-gates on `{ plan: 005, phase: 1 }`, so no consumer precedes the
// widening.
export type InterventionType = "steer" | "interrupt" | "cancel" | "rollback";

// Nominal TS — daemon-constructed param. Discriminated union over `type`: each
// intervention type is structurally coupled to its payload, so `type: "steer"`
// REQUIRES a `SteerPayload` and a mismatched/empty payload is unrepresentable —
// not a silently-accepted no-op. `Spec-005 §Required Behavior` routes interventions by type, so the
// type→payload coupling is a contract invariant, not a convenience. Every arm
// repeats `expectedRunVersion`, the MANDATORY fail-closed comparand (Plan-004
// D-004-2): a non-optional `number`, so an absent value is a type error, never a
// silently-applied intervention.
//
// Every arm likewise repeats `clientIdempotencyKey`, the MANDATORY
// REQUESTER-GENERATED UUID (campaign B3). The daemon dedupes on it against the
// `interventions` UNIQUE guard (replay-or-conflict), which is what converts an
// AT-LEAST-ONCE delivery into EXACTLY-ONCE application — a retried steer
// re-applies nothing. The key is threaded to the wire UNCHANGED, never re-minted
// at the driver boundary (re-minting would hand a provider-remote invocation a
// fresh key per retry and defeat the dedupe outright), so a provider that honors
// dedupe keys receives the CALLER's key — the `compensable` propagation pattern.
// Non-optional for the same reason `expectedRunVersion` is: an absent key must
// be a type error, not a silently non-deduped intervention. The driver-side
// threading itself is Plan-005 P0-3's, landing in Phase 3; this arm set only
// makes the value impossible to omit on the way there.
//
// No paired Zod schema, deliberately: this is a daemon-CONSTRUCTED param (§1(a))
// like the rest of the `*Params` family, so there is nothing untrusted to parse
// — the requester-supplied key is validated at the client→daemon WIRE seam (§3),
// a different boundary, before it ever reaches this shape.
//
// THREE-ARMED ON PURPOSE against a FOUR-member `InterventionType` (T1.8): there
// is no `rollback` arm here, and its absence is the contract. A rollback's driver
// leg is the dedicated capability-gated `rollbackTo` parity operation above, not
// an `applyIntervention` dispatch — so the union's arm set is the dispatch
// surface, while `InterventionType` is the intervention VOCABULARY, and the two
// are deliberately not the same set. Adding a fourth arm here would create a
// second, ungated route to the same provider mechanism.
export type ApplyInterventionParams =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: SteerPayload;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: InterruptPayload;
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: CancelPayload;
    };

export interface SteerPayload {
  content: string;
  attachments?: unknown[] | undefined;
  expectedTurnId?: string | undefined;
}

export interface InterruptPayload {
  reason?: string | undefined;
}

export interface CancelPayload {
  reason?: string | undefined;
}

// Return shape of `ProviderDriver.applyIntervention()`. Zod-validated because it
// parses UNTRUSTED provider output (the trust boundary). `fallbackAction` is an
// optional hint carrying the suggested fallback for a `degraded` result (e.g.
// `queue_and_interrupt` for a degraded steer); on the `applied` path it is absent
// by convention. Intentionally a flat object, NOT a `status`-discriminated union
// like the sibling `DriverResumeResult`: that envelope's variants carry different
// REQUIRED fields, whereas these two differ only by one optional field — the flat
// shape mirrors the ratified `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)` envelope (Phase-4
// decision #3). Non-transforming object → double-`T` annotation per
// session.ts:289-294.
//
// `refusalCode` is additive-optional and closed to ONE literal, registered in
// `docs/architecture/contracts/error-contracts.md` §Driver. It is set when a
// driver-boundary text neutralization failure is already classified at the
// moment this result resolves, and it rides the result rather than a JSON-RPC
// error because an unsupported-or-refused intervention is DATA under ADR-011,
// not an exception. It is BEST-EFFORT BY CONSTRUCTION: the driver does not hold
// the intervention call open waiting for the provider turn to settle, so the
// member is absent whenever settlement lands after this result does. The run's
// own `run.failed` terminal is the guarantee on every path; this member is the
// second surface, never the only one. Deliberately NOT `.strict()`-exempt and
// NOT widened to a general refusal channel — a second code would need its own
// registration, and a union minted ahead of a second producer is a gate with no
// reader.
export interface DriverInterventionResult {
  status: "applied" | "degraded";
  fallbackAction?: string | undefined;
  refusalCode?: "driver.text_neutralization_failed" | undefined;
}
export const DriverInterventionResultSchema: z.ZodType<
  DriverInterventionResult,
  DriverInterventionResult
> = z
  .object({
    status: z.enum(["applied", "degraded"]),
    fallbackAction: wireFreeFormString(
      DRIVER_FALLBACK_ACTION_MAX_LEN,
      "DriverInterventionResult.fallbackAction",
    ).optional(),
    // A CLOSED LITERAL, not `wireFreeFormString`. Every other free-form member
    // of this envelope carries provider-authored prose and is length-bounded
    // and sanitized on that basis; this one carries a code the daemon itself
    // minted, so the schema that admits it should admit exactly that code and
    // nothing else. A `z.string()` here would let a driver report an arbitrary
    // refusal on a field whose consumers key on identity.
    refusalCode: z.literal("driver.text_neutralization_failed").optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// T1.6 — Resume result (`Spec-005 §Fallback Behavior` + `Spec-005 §Acceptance Criteria`; verifies I-005-5)
// --------------------------------------------------------------------------
//
// `RecoveryCondition` — named once here (T1.8's re-type of what T1.6 shipped as
// an inline `z.literal('recovery-needed')`), referenced at every carrying
// surface. `recovery-needed` is the generic condition: operator reconciliation
// required. `reauth-required` means the provider session or credential expired —
// detected mid-run via the provider's typed auth-failure signals, or at
// resume/probe time — and its remediation is re-authenticating the provider CLI
// on the runtime node, after which recovery MAY retry. Two conditions, two
// different operator actions, which is why one literal could not carry both.
//
// Widening at the SCHEMA rather than at the consumer is what makes this
// contract-first: T3.14's mid-run `reauth-required` route and T4.8's carrier
// consume become expressible here instead of dead-lettering at parse.
export type RecoveryCondition = "recovery-needed" | "reauth-required";

// `RecoverySpanClassification` — the SIBLING classification of the halted span's
// CONTENT. Orthogonal to `RecoveryCondition` above: that axis names WHY the run
// needs an operator, this one names WHAT the diverged/halted span contains, so
// policy can tier on blast radius. Deliberately NOT modelled as a widening of
// `RecoveryCondition` — the two answer different questions, and conflating them
// would overload operator-remediation routing.
//
// V1 consumes it as AUDIT METADATA ONLY: every divergence still halts for human
// action (`Spec-015 §Fallback Behavior`), and `unclassifiable` MUST be handled
// exactly as `irreversible` — the fail-closed default, which is what keeps the
// driver-side escape hatch below from being a free pass. Recording the axis now
// makes tiered auto-resolution (auto-resolve `read_only` / `idempotent_write`,
// always halt `irreversible`) a future POLICY flip rather than a schema change.
//
// A plain literal union, NOT a `const`-array-derived one like
// `DRIVER_CAPABILITY_FLAGS`: that array exists because a migration CHECK list, a
// write-seam cardinality guard, and test fixtures all read the values at
// RUNTIME. This union has no runtime consumer — the `z.enum` below restates it
// in lockstep, the same discipline `RecoveryCondition` already follows — so a
// const array here would be a runtime symbol nothing reads.
export type RecoverySpanClassification =
  | "read_only"
  | "idempotent_write"
  | "irreversible"
  | "unclassifiable";
//
// Return shape of `ProviderDriver.resumeSession()`. Zod-validated because it
// parses UNTRUSTED provider output. The discriminated union over `status` makes
// SILENT REPLACEMENT structurally inexpressible (I-005-5): the `failed` variant
// carries a `RecoveryCondition` + a `RecoverySpanClassification` +
// `providerFailureDetail` and has NO `bindingId`, so a failed resume cannot be
// conflated with a successful one — the type system forbids returning a binding
// while signalling failure.
// `Spec-005 §Fallback Behavior` requires resume failure to "surface `provider failure` detail and
// a visible `recovery-needed` condition; it must not silently create a
// replacement provider session under the same canonical run." Resumed-case
// timestamps live on `runtime_bindings.updated_at` (Plan-005 T2.1); this shape
// carries only the discriminated-union semantic payload.
//
// The `resumed` arm's REQUIRED `sessionPosition` is the driver's normalized
// monotonic position (a turn/event ordinal — the same number-cursor convention
// as `DriverRollbackResult`'s confirmed floor), which the daemon compares against
// its RECORDED position. That compare is load-bearing rather than decorative: it
// is what catches a provider silently answering a resume with a FRESH session
// (e.g. Claude on a working-directory mismatch), because a fresh session's
// position cannot match the recorded one. So a successful resume WITHOUT a
// comparable position is structurally inexpressible, the same guarantee the
// rollback envelope makes for its floor.
export type DriverResumeResult =
  | { status: "resumed"; bindingId: string; sessionPosition: number }
  | {
      status: "failed";
      recoveryCondition: RecoveryCondition;
      recoverySpanClassification: RecoverySpanClassification;
      providerFailureDetail: string;
    };
export const DriverResumeResultSchema: z.ZodType<DriverResumeResult, DriverResumeResult> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("resumed"),
        // `bindingId` is a machine-generated OPAQUE provider session-binding
        // handle (`Spec-005 §Required Behavior`) — the same category as the `invites.ts`
        // PASETO token (`z.string().min(1).max(INVITE_TOKEN_MAX_LEN)`), whose
        // comment (invites.ts:145-150) deliberately OMITS the `/\S/` + NUL guards
        // because those target HUMAN-entered fields. We make a different choice
        // here for a DIFFERENT reason — not "stronger is better": this handle is
        // PERSISTED into `runtime_bindings` and emitted on `runtime_node.*`
        // events, so `wireFreeFormString`'s `/\S/` + NUL guards are
        // defense-in-depth against storage / log-injection hazards on a stored
        // untrusted value, a separate rationale from invites' hot-path token
        // validation (not a claim invites under-hardened). The cap
        // (`DRIVER_BINDING_ID_MAX_LEN = 256`) is sized for a short session-binding
        // handle, distinct from invites' 4096-char token blob.
        bindingId: wireFreeFormString(DRIVER_BINDING_ID_MAX_LEN, "DriverResumeResult.bindingId"),
        // SHAPE only (integer >= 0) — the same bound, and the same split, as
        // `DriverRollbackResultSchema`'s `applied` floor. The DOMAIN checks (that
        // this position matches the daemon's RECORDED position, and the
        // divergence reconciliation a mismatch triggers — halt-for-human, with
        // rollback markers as the position floor) are Spec-015's, not this
        // layer's: they need session state this shape does not carry, so
        // asserting them here would be a check that cannot actually be performed.
        sessionPosition: z.number().int().min(0),
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        // T1.8 re-type: was `z.literal("recovery-needed")` at T1.6. Kept in
        // lockstep with the `RecoveryCondition` union above — a `z.enum` over the
        // same two values, so a driver reporting `reauth-required` parses here
        // instead of being rejected as a protocol violation.
        recoveryCondition: z.enum(["recovery-needed", "reauth-required"]),
        // REQUIRED on this LIVE driver return — unlike the OPTIONAL form the
        // replay-visible carriers take, whose optionality exists only to admit
        // pre-amendment history. A resume failure is produced FRESH at resume
        // time and is never replayed, so there is no such history here for
        // optionality to admit. A driver that cannot classify the span emits
        // `unclassifiable` (which the consumer must handle exactly as
        // `irreversible`), so OMISSION is a schema failure rather than a silent
        // "unknown". Restated in lockstep with the `RecoverySpanClassification`
        // union above, the same discipline as `recoveryCondition`.
        recoverySpanClassification: z.enum([
          "read_only",
          "idempotent_write",
          "irreversible",
          "unclassifiable",
        ]),
        // The cap is generous (`DRIVER_FAILURE_DETAIL_MAX_LEN = 32768`) so a
        // legitimate verbose detail (wrapped upstream stack trace / nested-cause
        // chain) is not suppressed — `Spec-005 §Fallback Behavior` MANDATES this detail surface. A
        // value still exceeding the cap is pathological; the daemon's resume
        // handler (Plan-005 Phase 3/4) must treat an unparseable provider result
        // as ITSELF a provider failure and surface `recovery-needed`, so the
        // system-level signal survives even a parse rejection here.
        providerFailureDetail: wireFreeFormString(
          DRIVER_FAILURE_DETAIL_MAX_LEN,
          "DriverResumeResult.providerFailureDetail",
        ),
      })
      .strict(),
  ]);

// --------------------------------------------------------------------------
// T1.8 — R8 parity operation shapes (`Spec-005 §Interfaces And Contracts`,
//        `Spec-005 §Required Behavior`; verifies I-005-2 + I-005-4)
// --------------------------------------------------------------------------
//
// Everything below is reachable ONLY from the four operations T1.8 added to
// `ProviderDriver` above, or from the spawn/turn carriers those operations share.
// The nominal-vs-Zod split follows the file header's rule mechanically, with no
// new judgement: daemon-CONSTRUCTED params and daemon-CONSTRUCTED config stay
// nominal; the three new result envelopes and the two driver-normalized seam
// shapes are Zod-parsed because they carry provider output across the trust
// boundary.

// --------------------------------------------------------------------------
// Conversation rollback — `rollbackTo` (gated on the `rollback` flag)
// --------------------------------------------------------------------------
//
// CONVERSATION STATE ONLY. File-state restore is the daemon's turn-snapshot git
// leg (Plan-010), never the driver's — the Codex protocol schema itself notes
// that its rollback does not revert local file changes, so a driver that
// "restored" files here would be inventing a guarantee the provider never made.
//
// `position` is the driver's normalized monotonic session position (a turn/event
// ordinal). The intervention-layer `targetPosition` maps ONTO this driver ordinal
// rather than being it.
//
// `bindingId` is the leg key, and it is load-bearing rather than decorative:
// run→bindings is 1:many in the shipped store (a capped or posture relaunch mints
// a new binding for the same run), so `sessionId` alone cannot name the target
// leg. The DAEMON resolves the run's live binding at dispatch — client rollback
// payloads never carry it, because clients address the run, not the leg.
export interface RollbackToParams {
  sessionId: SessionId;
  position: number;
  bindingId: string;
}

// Return shape of `ProviderDriver.rollbackTo()`. Zod-validated — untrusted
// provider output. Discriminated over `status` for the same structural reason as
// `DriverResumeResult` (I-005-5's shape, applied to a second operation): a
// SUCCESSFUL rollback WITHOUT A CONFIRMED FLOOR is inexpressible, because
// `sessionPosition` is REQUIRED on `applied` and absent from `degraded`.
//
// This schema bounds `sessionPosition`'s SHAPE only (integer >= 0). The DOMAIN
// checks — that it names a recorded boundary and sits strictly below the
// pre-rollback position, with the recovery-admitted convergence-no-op carve-out —
// belong to the daemon's rollback handler, not here: they need session state this
// shape does not carry, and asserting them here would be a check that cannot
// actually be performed.
//
// `bindingId` stays OPTIONAL even though BOTH V1 legs mint one (Claude
// `--resume-session-at` + `--fork-session`; Codex `thread/fork`, which mints a
// thread and repoints the run's live binding in one operation). The optionality
// is reserved for a future IN-PLACE mechanism — not for either shipped leg, so a
// V1 driver reporting `applied` without it is reporting an unrecorded binding.
// It is a store-minted binding surrogate, never itself a resume handle.
export type DriverRollbackResult =
  | { status: "applied"; sessionPosition: number; bindingId?: string | undefined }
  | { status: "degraded"; fallbackAction?: string | undefined };
export const DriverRollbackResultSchema: z.ZodType<DriverRollbackResult, DriverRollbackResult> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("applied"),
        sessionPosition: z.number().int().min(0),
        bindingId: wireFreeFormString(
          DRIVER_BINDING_ID_MAX_LEN,
          "DriverRollbackResult.bindingId",
        ).optional(),
      })
      .strict(),
    z
      .object({
        status: z.literal("degraded"),
        fallbackAction: wireFreeFormString(
          DRIVER_FALLBACK_ACTION_MAX_LEN,
          "DriverRollbackResult.fallbackAction",
        ).optional(),
      })
      .strict(),
  ]);

// --------------------------------------------------------------------------
// Session goals — `setSessionGoal` / `clearSessionGoal` (gated on `session_goals`)
// --------------------------------------------------------------------------
//
// `goalText` is the daemon-RENDERED textual form of the session's structured
// goal: the structured shape is owned by the Spec-016 goal contract, and the
// daemon renders structure → provider text at dispatch, so the driver never sees
// the structure and cannot diverge from it.
//
// Durable truth is the `session.goal_updated` / `session.goal_cleared` events
// (Spec-006), and the daemon re-pushes the goal on session resume — driver-held
// state is never the recovery source, which is why neither operation returns the
// goal it applied.
//
// `bindingId` is the leg key for the same 1:many reason as `RollbackToParams`:
// goal delivery fans out PER LIVE BINDING, matching the durable intent's per-leg
// map. `runId` rides along for run-scoped context and telemetry.
export interface SetSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
  goalText: string;
}

export interface ClearSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
}

// Return shape of both goal operations. Zod-validated — untrusted provider
// output. `applied` means the goal governs the session from now or from the next
// turn boundary (both V1 legs), and it carries NO `fallbackAction`: a fallback
// narrative on a successful application is structurally unrepresentable, which is
// a stronger statement than the sibling `DriverInterventionResult`'s flat shape
// makes and is why this one is a discriminated union rather than a flat object.
export type DriverGoalResult =
  | { status: "applied" }
  | { status: "degraded"; fallbackAction?: string | undefined };
export const DriverGoalResultSchema: z.ZodType<DriverGoalResult, DriverGoalResult> =
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("applied") }).strict(),
    z
      .object({
        status: z.literal("degraded"),
        fallbackAction: wireFreeFormString(
          DRIVER_FALLBACK_ACTION_MAX_LEN,
          "DriverGoalResult.fallbackAction",
        ).optional(),
      })
      .strict(),
  ]);

// --------------------------------------------------------------------------
// Zero-turn authentication probe — `probeAuth` (NOT capability-gated)
// --------------------------------------------------------------------------
//
// `indeterminate` (probe surface unavailable or unparseable) is treated as NOT
// authenticated for admission — FAIL CLOSED — while staying distinguishable from
// `unauthenticated`, so operators can separate probe health from credential
// state. Collapsing the two into a boolean would destroy exactly that
// distinction, which is why this is a three-value enum and not `authenticated:
// boolean`.
//
// Run admission against a driver not probing `authenticated` refuses as
// `driver.not_authenticated` BEFORE any turn is spent. Mid-run credential expiry
// is a different surface: the provider's typed auth-failure signals map onto
// `RecoveryCondition`'s `reauth-required`.
export interface DriverAuthProbeResult {
  status: "authenticated" | "unauthenticated" | "indeterminate";
  // Knowingly PII-BEARING: a provider-reported account/plan descriptor whose
  // observed shape is a plan name plus a seat EMAIL. Scope is therefore
  // transient, operator-facing diagnostics ONLY — it MUST NOT be persisted
  // durably, nor carried on any event, without a Spec-022 PII classification
  // and the erasure reciprocals that classification obliges. The consumer is
  // the probeAuth admission leg (`Spec-005 §Required Behavior` — run admission
  // against a driver not probing `authenticated` refuses `driver.not_authenticated`
  // before a turn is spent), which reads `status` for the decision and this
  // field only to tell an operator WHY; no single Plan-005 task owns that
  // refusal today, so the spec clause is the citation rather than a task id.
  // `status` alone carries the fail-closed decision, so dropping this field
  // loses diagnostics and never correctness.
  detail?: string | undefined;
}
export const DriverAuthProbeResultSchema: z.ZodType<DriverAuthProbeResult, DriverAuthProbeResult> =
  z
    .object({
      status: z.enum(["authenticated", "unauthenticated", "indeterminate"]),
      detail: wireFreeFormString(
        DRIVER_AUTH_DETAIL_MAX_LEN,
        "DriverAuthProbeResult.detail",
      ).optional(),
    })
    .strict();

// --------------------------------------------------------------------------
// Canonical transcript export + replay — `exportTranscript` / `replayTranscript`
// --------------------------------------------------------------------------
//
// The canonical transcript is a PROJECTION the daemon folds from the session
// event log and rebuilds per call (ADR-029). It is therefore passed IN to
// `exportTranscript` rather than fetched by the driver: a driver holding a
// transcript handle would be holding a second record of facts the log already
// orders, which is exactly the divergence the decision eliminates.
//
// The projection shapes below are DAEMON-CONSTRUCTED (§1(a)) and ship nominal —
// there is nothing untrusted to parse in a value the daemon just folded. The two
// RESULT envelopes are driver-constructed and ARE Zod-validated (§2), on the same
// rule as the other envelopes rather than a new one: `declaredLosses` is a closed
// vocabulary, and an unnamed loss class reaching a caller that reads an empty
// array as "nothing was dropped" is the one drift this boundary must not pass.
//
// The per-turn ELEMENT shape is owned here rather than mirrored from the canonical
// doc, which carries only the projection's identity: the fold's members are
// exactly what the ordered pipeline operates on, so they are authored beside the
// pipeline that consumes them. Their content is bounded by the Spec-006
// normalized taxonomy — anything a provider held that never became an event is
// absent by CONSTRUCTION, not by discipline, which is what the declared-loss
// rule exists to surface.

// The closed vocabulary of what a transcript operation could not carry. A new
// loss kind is an amendment, never a free string, so this is the one place the
// set is written down; an EMPTY list is a positive claim that nothing was
// dropped, which is why a driver that does not know what it lost may not emit
// one.
export const DECLARED_LOSS_KINDS = [
  // Non-portable by both vendors' stated rules; never translated. Stripped
  // UNCONDITIONALLY, including on a same-provider replay where the signatures
  // would still validate — carrying them would owe an exact reproduction of
  // block order and count, a second provider-specific correctness contract whose
  // failures surface as opaque signature rejections rather than declared losses.
  "provider_private_reasoning",
  // The memo budget evicted older exchanges — whole exchanges only, never halves.
  "context_truncated",
  // An unpaired call took a synthetic error result rather than being dropped.
  "tool_call_history_repaired",
  // The memo floor: verbatim exchanges replaced by a bounded prose rendering.
  "conversation_history_summarized",
  // A logged turn's body could not be read when the fold ran, so the turn is
  // carried with its structural position and an EMPTY body rather than being
  // dropped. Named because the alternative readings — a turn that never
  // happened, or one whose author said nothing — are both false.
  "turn_content_unavailable",
] as const;

export type DeclaredLossKind = (typeof DECLARED_LOSS_KINDS)[number];

export const DeclaredLossKindSchema: z.ZodType<DeclaredLossKind, DeclaredLossKind> =
  z.enum(DECLARED_LOSS_KINDS);

/** Who authored a turn. The transcript carries no third author in V1. */
export type CanonicalTranscriptRole = "participant" | "assistant";

// Whether a reasoning block was ever visible to the participant. The strip keys
// on THIS, not on `reasoningKind`: a filter matching one kind name silently
// leaves that kind's redacted sibling behind, and the multi-turn protocol then
// breaks on a block nobody classified. Summaries are participant-visible and
// therefore already canonical, so they carry forward as plain text.
export type CanonicalReasoningDisclosure = "private" | "summary";

// Whether a tool result came from the provider or was minted by the pipeline's
// pairing repair. Recorded because a repaired result is a DECLARED loss, and a
// consumer that cannot tell the two apart cannot honour the declaration.
export type CanonicalToolResultProvenance = "provider" | "repaired";

// One unit of turn content.
//
// Every arm carries `position`: the session-log sequence of the event that
// contributed THIS segment. It is derived provenance projected from the log,
// never a second record of the session's order, which is what ADR-029 requires.
// It is required on every arm rather than optional because it is what a bound
// filters on — an absent position would exempt its segment from every bound, and
// the call site that forgot it would look no different from one that had nothing
// to record. Steps that re-home a segment carry the value through unchanged, so
// positions within a turn are ascending as the fold builds them but need not stay
// so once the pairing repair has moved a result behind its call.
//
// A `tool_call` deliberately carries NO enclosing-block member while a
// `tool_result` does. That asymmetry is structural, not incidental: it makes
// "the strip never drops a call" unrepresentable-otherwise rather than a rule
// the strip has to remember, while leaving the strip able to orphan a RESULT —
// which is precisely the condition the pairing repair exists to answer, and
// precisely why the repair must run after the strip and not before.
export type CanonicalTranscriptSegment =
  | {
      kind: "text";
      position: number;
      text: string;
      // Set when the row's body was unavailable at fold time. `text` is then
      // empty because inventing content is the one thing the fold may not do,
      // and the segment is kept so the turn survives with its position — a
      // dropped turn is indistinguishable from one that never happened. Every
      // projection carrying one owes the matching declared loss.
      contentUnavailable?: boolean | undefined;
    }
  | {
      kind: "reasoning";
      position: number;
      blockId: string;
      // The provider's own block-kind label, carried verbatim for diagnostics.
      // It is NOT what the strip keys on — see `CanonicalReasoningDisclosure`.
      reasoningKind: string;
      disclosure: CanonicalReasoningDisclosure;
      text: string;
    }
  | {
      kind: "tool_call";
      position: number;
      // The CANONICAL id. Replay never re-mints one and never reuses one across
      // two distinct calls; the target-facing id is supplied by the identity map.
      toolCallId: string;
      toolName: string;
      // The call's arguments as the provider serialized them. Kept as the
      // serialized form because re-encoding a parsed object would change bytes
      // the target may hash or echo.
      argumentsJson: string;
      // As on the `text` arm. An unreadable body leaves `argumentsJson` empty
      // rather than dropping the call, whose id the pairing repair needs.
      contentUnavailable?: boolean | undefined;
    }
  | {
      kind: "tool_result";
      position: number;
      toolCallId: string;
      outcome: "succeeded" | "failed";
      provenance: CanonicalToolResultProvenance;
      text: string;
      // Present when the provider emitted this result INSIDE a reasoning block.
      // Stripping that block removes the result and orphans its call, which is
      // the only way an orphan arises from a well-formed transcript.
      enclosingReasoningBlockId?: string | undefined;
      // How the fold resolved that enclosure at turn close, and the ONLY carrier
      // of that resolution that survives a positional bound: the block id names a
      // sibling segment a bound may cut away, while this member rides the result
      // it governs.
      //
      // Recorded for the two dispositions that WITHHOLD and for no other. A
      // portable (`summary`) enclosure and a citation of a block from another
      // turn both leave it absent, because nothing branches on either and a
      // member minted ahead of its reader is one every later fold must keep true.
      //
      //   `private`  the enclosing block was read and is not portable;
      //   `unknown`  the enclosure could not be established portable — the turn's
      //              reasoning row was unreadable, so its block ids are not
      //              knowable at all, or the block carried a disclosure this fold
      //              does not classify. Fail-closed: content that MIGHT be
      //              private must travel with the block, not past it.
      enclosureDisclosure?: "private" | "unknown" | undefined;
      // As on the `text` arm.
      contentUnavailable?: boolean | undefined;
    };

/** One ordered turn of the canonical transcript. */
export interface CanonicalTranscriptTurn {
  // The session-log sequence of the event that OPENED this turn — the position
  // of its first segment. Turns are strictly ascending in it, which is what makes
  // the fold's order the log's. Consecutive same-role events coalesce INTO an open
  // turn and keep their own, higher, positions on their own segments, so this
  // member bounds nothing on its own: a filter written against it admits every
  // later event folded into a turn that opened early.
  position: number;
  role: CanonicalTranscriptRole;
  segments: readonly CanonicalTranscriptSegment[];
}

// The daemon-side fold of a run's normalized events into ordered turns. It never
// crosses a wire and is never persisted.
export interface CanonicalTranscriptProjection {
  sessionId: SessionId;
  runId: RunId;
  // The log position this fold was taken at. Two folds at the same position
  // render identically and one taken after an appended event does not — the
  // projection-not-a-store property, stated as a member rather than a comment so
  // a test can assert it.
  builtAtPosition: number;
  turns: readonly CanonicalTranscriptTurn[];
}

// The export input pairs the folded projection with the boundary it is exported
// against (`Spec-005 §Canonical Transcript Export And Replay` — the operation's
// input is the daemon-supplied canonical projection AND a target boundary).
//
// The projection also arrives already folded, so the two members could be read as
// two answers to "where does this transcript end?". They are not, because the
// driver is given the reconciliation rule rather than a choice: it retains
// exactly the SEGMENTS whose `position` is at or below `boundary`, dropping any
// turn that leaves empty. Stated per segment and not per turn because the fold
// coalesces consecutive same-role events into ONE turn positioned at the first of
// them — a turn-level filter would carry every later event's content across the
// boundary with it. That is a deterministic filter over data it already holds —
// it opens no log, consults nothing the daemon did not hand it, and mints no
// second record of the session's order, which is what ADR-029 requires of a
// driver. It is equal to the fold bounded at the same position, so a projection
// the fold already bounded filters to itself and the rule is a no-op on the
// common path and a stated bound on every path.
export interface ExportTranscriptParams {
  sessionId: SessionId;
  transcript: CanonicalTranscriptProjection;
  // Export up to and INCLUDING this normalized session position — the same
  // position vocabulary `RollbackToParams.position` uses, and the same one
  // `CanonicalTranscriptSegment.position` carries, which is what makes the filter
  // above expressible against the segments in hand rather than needing a lookup.
  boundary: number;
}

// Return shape of `ProviderDriver.exportTranscript()`. Zod-validated.
export interface DriverTranscriptExportResult {
  // Provider-shaped replay frames, deliberately UNTYPED at this boundary: the
  // pinned injection surface takes an untyped array and validates neither shape
  // nor tool-call pairing, so the DAEMON owns both and a type here would be a
  // false assurance about a check nobody performs.
  frames: unknown[];
  // What steps 3 and 4 of the ordered pipeline stripped or repaired, by class.
  declaredLosses: DeclaredLossKind[];
}

export const DriverTranscriptExportResultSchema: z.ZodType<
  DriverTranscriptExportResult,
  DriverTranscriptExportResult
> = z
  .object({
    frames: z.array(z.unknown()),
    declaredLosses: z.array(DeclaredLossKindSchema),
  })
  .strict();

export interface ReplayTranscriptParams {
  // A FRESH session handle. Replay never writes to the session the transcript
  // came from.
  target: ProviderSessionHandle;
  frames: unknown[];
}

// Return shape of `ProviderDriver.replayTranscript()`. Zod-validated.
//
// Flat rather than discriminated, unlike its `DriverGoalResult` neighbour,
// because `declaredLosses` is REQUIRED on BOTH arms: an `applied` replay that
// stripped provider-private reasoning still lost something, and a union that
// made the member arm-scoped would have let that loss go unnamed. What IS
// arm-scoped is the list's required CONTENT on the degraded arm, and it rides the
// schema below rather than this shape: expressing it in the type would take the
// discriminated union this member set exists to avoid.
export interface DriverTranscriptReplayResult {
  // `degraded` is the memo floor having stood in: the conversation moved and the
  // losses say what came along. It is NOT a failure result — a target that
  // cannot be reached at all throws.
  status: "applied" | "degraded";
  declaredLosses: DeclaredLossKind[];
}

export const DriverTranscriptReplayResultSchema: z.ZodType<
  DriverTranscriptReplayResult,
  DriverTranscriptReplayResult
> = z
  .object({
    status: z.enum(["applied", "degraded"]),
    declaredLosses: z.array(DeclaredLossKindSchema),
  })
  .strict()
  // `degraded` on THIS operation has exactly one cause — the memo floor stood in
  // — so `Spec-005 §Canonical Transcript Export And Replay` requires every such
  // settlement to carry a NON-EMPTY list naming `conversation_history_summarized`.
  // Enforced rather than narrated: the flat shape alone admits
  // `{status: 'degraded', declaredLosses: []}`, and an empty array is the
  // POSITIVE claim that nothing was dropped, so that value tells the caller a
  // bounded prose summary is the verbatim conversation.
  //
  // Naming the kind subsumes non-emptiness, which is why there is no separate
  // length rule and none is added: a `.min(1)` would admit a degraded result
  // declaring some OTHER loss while still hiding the summarization — the exact
  // reading this rule exists to forbid.
  //
  // Arm-SCOPED on purpose, and scoped in BOTH directions. `applied` keeps the
  // full latitude over every OTHER kind, empty list included: an applied replay
  // that dropped nothing is the case the empty array exists to state, and a
  // universal non-emptiness rule would delete it. What `applied` does NOT keep is
  // `conversation_history_summarized` — see the inverse rule below.
  // `.superRefine()` returns `this`, so the envelope stays a `ZodObject` and the
  // Output/Input annotation above still holds — the same Zod-4 property the
  // `audit_integrity_failed` arm in event.ts records.
  //
  // The two rules together make the kind an EXACT witness of the arm rather than
  // a one-way requirement. A one-way rule leaves `{status: 'applied',
  // declaredLosses: ['conversation_history_summarized']}` parseable, and that
  // value is self-contradictory: it claims the native replay landed the
  // conversation AND that a bounded prose summary stood in for it. A consumer
  // reading `status` publishes native-replay continuity for what is really a
  // memo-floor session; a consumer reading the kind publishes a summarized
  // session for what really replayed. Both readings are defensible against the
  // shape, which is precisely why neither is safe — so the value is refused.
  .superRefine((result, ctx) => {
    if (
      result.status === "degraded" &&
      !result.declaredLosses.includes("conversation_history_summarized")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["declaredLosses"],
        message:
          "a replay reported 'degraded' settled on the memo projection, so its declared-loss list must include 'conversation_history_summarized'; this result reports 'degraded' without it.",
      });
    }
    if (
      result.status === "applied" &&
      result.declaredLosses.includes("conversation_history_summarized")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["declaredLosses"],
        message:
          "'conversation_history_summarized' names the memo projection standing in for the conversation, which is the 'degraded' settlement; an 'applied' replay cannot declare it, and this result reports 'applied' with it.",
      });
    }
  });

// --------------------------------------------------------------------------
// Execution posture — the spawn/turn sandbox + permission surface
// --------------------------------------------------------------------------
//
// Nominal TS — daemon-CONSTRUCTED (§1(a)). Shape owned by Spec-005; policy
// semantics by Spec-012. Carried by `CreateSessionParams` / `StartRunParams`
// above and stamped on `run.running` for audit.
//
// Two cross-field invariants are encoded STRUCTURALLY rather than checked at
// runtime, so a violating posture cannot be constructed at all:
//   • `allowedDomains` exists ONLY under `networkAccess: "allowed-domains"`, and
//     is non-empty BY CONSTRUCTION there (`[string, ...string[]]`) — an
//     allow-list mode with an empty or absent list is unrepresentable, so the
//     fail-open reading never arises.
//   • `credentialPolicyRef` is REQUIRED on both sandboxed modes and ABSENT under
//     `mode: "trusted"` — a trusted run records no enforced credential
//     constraint, so a posture carrying both is unrepresentable.
//
// The `?: never` exclusion members below deliberately do NOT take this package's
// `?: T | undefined` idiom. `?: never` is what makes the member structurally
// absent; writing `?: never | undefined` would collapse to `?: undefined` and
// turn a structural exclusion into a merely-nullable field, which is the opposite
// of the intent.
//
// `credentialPolicyRef` is a content-addressed `"sha256:<hex>"` over the RFC 8785
// JCS-canonicalized credential-policy artifact — a REFERENCE, so auditors can
// reconstruct exactly which credentials were denied without the posture
// embedding an installation-revealing list.
export type ExecutionPostureNetwork =
  | { networkAccess: "none" | "full"; allowedDomains?: never }
  | { networkAccess: "allowed-domains"; allowedDomains: [string, ...string[]] };

export type ExecutionPosture = ExecutionPostureNetwork & {
  writableRoots: string[];
  profileName?: string | undefined;
} & (
    | { mode: "trusted"; credentialPolicyRef?: never }
    | {
        mode: "workspace-sandboxed" | "readonly-sandboxed";
        credentialPolicyRef: string;
      }
  );

// --------------------------------------------------------------------------
// Callback tools — the `onCallbackToolCall` spawn seam (gated on `callback_tools`)
// --------------------------------------------------------------------------
//
// `SessionCallbackTool` is daemon-CURATED and daemon-TRUSTED — never provider
// output — so it stays nominal. It mirrors the function-form provider tool shape
// (name + description + JSON-Schema input): the Codex leg maps it 1:1 onto
// function-form `dynamicTools`, and the Claude leg hosts the same registry as a
// daemon-hosted ephemeral MCP server. Every invocation flows through the daemon's
// approval pipeline and lands as an ordinary `tool_activity` row.
export interface SessionCallbackTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// The invocation the driver hands to the injected dispatcher. Zod-validated: the
// driver builds it from UNTRUSTED provider wire output, and this parse is the
// last point before the value reaches daemon-owned code.
//
// `toolName` is resolved against the session's registered `SessionCallbackTool`
// set, and an UNKNOWN name answers `failed` WITHOUT dispatch. `arguments` is
// validated against the registered tool's `inputSchema` BEFORE any Cedar
// round-trip, so schema-invalid arguments also answer `failed` without dispatch —
// malformed provider output never reaches the approval pipeline. Both of those
// are the dispatcher host's checks (T3.15), not this schema's: they need the
// session's registry, which this shape does not carry. What this schema
// guarantees is narrower and prior — that the strings are bounded and the ids are
// well-formed before any of that runs.
//
// `toolCallId` is copied VERBATIM onto the answered result: tool-event pairing is
// exact-string match, so normalizing it here would break the pairing.
export interface CallbackToolInvocation {
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId: string;
  sessionId: SessionId;
  runId: RunId;
}
export const CallbackToolInvocationSchema: z.ZodType<
  CallbackToolInvocation,
  CallbackToolInvocation
> = z
  .object({
    toolName: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "CallbackToolInvocation.toolName"),
    arguments: z.record(z.string(), z.unknown()),
    toolCallId: wireFreeFormString(
      DRIVER_TOOL_CALL_ID_MAX_LEN,
      "CallbackToolInvocation.toolCallId",
    ),
    sessionId: SessionIdSchema,
    // Inline `brandedUuidIdSchema` rather than a named `RunIdSchema` const: the
    // exported `RunIdSchema` symbol is deliberately deferred to T4.2, whose SDK
    // seam is its first consumer (see the `RunId` brand comment at the top of this
    // file). Using the helper inline validates the id here without minting the
    // symbol early and without leaving the field unchecked.
    runId: brandedUuidIdSchema<RunId>("RunId"),
  })
  .strict();

// The answer the daemon hands back to the driver, which the driver relays to the
// provider. Daemon-CONSTRUCTED and trusted, so nominal — the direction of trust
// is the reverse of the invocation above.
//
// The `?: never` exclusion members carry the same rationale as `ExecutionPosture`
// (structural absence, so no `| undefined`): only `completed` may carry `output`,
// and only the two failure arms may carry `error`, so "denied WITH output" and
// "completed WITH an error" are both unrepresentable.
export type CallbackToolResult =
  | { status: "completed"; output?: unknown; error?: never }
  | { status: "denied"; output?: never; error?: string | undefined }
  | { status: "failed"; output?: never; error?: string | undefined };

// --------------------------------------------------------------------------
// MCP server status — the `onMcpServerStatus` spawn seam (producer-only)
// --------------------------------------------------------------------------
//
// SERVERS ONLY, never a per-server tool-list assumption: support is not
// visibility. Producer-only at Plan-005 — the consumer is Plan-028's status
// normalizer, and consumer semantics live there.
export type McpServerStatus = "unknown" | "starting" | "connected" | "needs-auth" | "failed";

// What the DRIVER emits: `serverName` + `status`, and nothing else. The driver
// NEVER supplies leg identity — the daemon pre-binds the injected producer closure
// to the leg at spawn — so a driver cannot misattribute, or spoof, another leg's
// rows, and the init census emitted DURING `createSession` needs no id the driver
// does not yet have. `serverName` is untrusted provider/CLI output, so this shape
// is Zod-parsed at the driver normalization seam before it reaches the producer.
export interface McpServerStatusEmission {
  serverName: string;
  status: McpServerStatus;
}
export const McpServerStatusEmissionSchema: z.ZodType<
  McpServerStatusEmission,
  McpServerStatusEmission
> = z
  .object({
    serverName: wireFreeFormString(
      DRIVER_MCP_SERVER_NAME_MAX_LEN,
      "McpServerStatusEmission.serverName",
    ),
    status: z.enum(["unknown", "starting", "connected", "needs-auth", "failed"]),
  })
  .strict();

// What the CONSUMER reads: the pre-bound producer closure stamps the leg identity
// onto every emission. Nominal — daemon-constructed from the injection context.
// `bindingId` is daemon-stamped, never driver-supplied; because run→bindings is
// 1:many, statuses key per `(binding, server)`, so a relaunched leg's fresh census
// supersedes its OWN predecessor without clobbering a concurrent live leg's rows.
export interface McpServerStatusUpdate {
  sessionId: SessionId;
  bindingId: string;
  serverName: string;
  status: McpServerStatus;
}

// Returns `void`, NOT `Promise<void>` — deliberately asymmetric with the sibling
// `onCallbackToolCall`, which is awaited. This is a fire-and-forget TELEMETRY
// sink: the driver has no answer to wait for, and making it awaitable would let a
// slow consumer back-pressure the provider's status stream.
export type McpServerStatusProducer = (emission: McpServerStatusEmission) => void;

// --------------------------------------------------------------------------
// Provider-native subagents (gated on the `subagents` flag)
// --------------------------------------------------------------------------
//
// Nominal TS — daemon-CONSTRUCTED. SINGLE-SUPERVISOR invariant: the daemon is the
// only cross-session supervisor, so provider subagents run IN-SESSION only, their
// usage aggregates into the run's own budgets, and their tool calls flow through
// the same approval pipeline.
//
// Discriminated on `enabled`: a disabled policy carries no limits and no
// definitions, so "off but configured" is unrepresentable and the daemon sends the
// full arm on enable rather than mutating a partial one.
export type SubagentPolicy =
  | { enabled: false }
  | { enabled: true; maxDepth: number; maxConcurrent: number; definitions: SubagentDefinition[] };

// The unified per-subagent definition each driver maps onto its provider form
// (Claude `--agents` AgentDefinition; Codex `[agents]` config). Every field beyond
// `name` is optional because the mapping is TOLERANT: each leg maps what its
// provider supports and ignores the rest, which is graded on the capability matrix
// rather than enforced by this shape.
export interface SubagentDefinition {
  name: string;
  description?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  permissionMode?: string | undefined;
  effort?: string | undefined;
  maxTurns?: number | undefined;
}

// --------------------------------------------------------------------------
// Driver transport configuration
// --------------------------------------------------------------------------
//
// A daemon driver-REGISTRY config surface, not an RPC payload and not a
// `ProviderDriver` member — it configures how the daemon reaches a driver process.
// V1 realizes only the Codex leg (`app-server --listen unix://|ws://`,
// config-gated, off by default); the Claude CLI exposes no local listener, so
// remote Claude participation is Spec-024 cross-node dispatch instead.
//
// `bearerTokenRef` is a daemon-config REFERENCE to the ws bearer credential, never
// the secret value (the same ref-not-value pattern as `credentialPolicyRef`), and
// it is REQUIRED on the websocket arm: an UNAUTHENTICATED ws listener is
// unrepresentable, which is the point of discriminating the transports rather than
// carrying an optional endpoint on one shape.
export type DriverTransportConfig =
  | { transport: "stdio" }
  | { transport: "unix-socket"; endpoint: string }
  | { transport: "websocket"; endpoint: string; bearerTokenRef: string };
