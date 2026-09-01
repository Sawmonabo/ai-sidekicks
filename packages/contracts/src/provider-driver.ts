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
//   2. ZOD-VALIDATED HERE: the EIGHT driver RESULT envelopes
//      (`DriverInterventionResultSchema`, `DriverResumeResultSchema`, the
//      three T1.8 adds — `DriverRollbackResultSchema`, `DriverGoalResultSchema`,
//      `DriverAuthProbeResultSchema`, one per RESULT TYPE rather than one per
//      operation: T1.8 added FOUR value-returning operations, but
//      `setSessionGoal` and `clearSessionGoal` SHARE `DriverGoalResult`, so the
//      four collapse to three envelopes — and the two T3.19 adds,
//      `DriverTranscriptExportResultSchema` /
//      `DriverTranscriptReplayResultSchema`, and the T3.26 add
//      `DriverCompactionResultSchema`), the provider-DECLARED tool metadata
//      (`ProviderToolMetadataSchema`), and the FOUR driver-NORMALIZED seam shapes
//      (`CallbackToolInvocationSchema`, `McpServerStatusEmissionSchema`, and the
//      T3.26 adds `ProviderCommandEntrySchema` / `ProviderOutputSpeedStateSchema`),
//      each built from provider wire output BEFORE the daemon-injected
//      `CreateSessionParams` callback sees it. The canonical doc's trust-boundary
//      header enumerates the first EIGHT; the two transcript envelopes join them
//      on that same rule rather than on a new one — a driver constructs each from
//      what its own provider accepted, and each carries the closed-vocabulary
//      `declaredLosses`, where an unnamed loss class is precisely the drift a
//      caller reading "nothing was dropped" off an empty array must not inherit.
//      `DriverCompactionResultSchema` joins them on that same rule and adds a
//      structural one of its own: the discriminated shape is what makes "no
//      `applied` without a `boundaryPosition`" and "no `capability_undeclared`
//      reason at all" refusals rather than conventions.
//      All THIRTEEN parse UNTRUSTED provider output — the trust boundary — so they
//      need runtime validation. `ProviderToolMetadataSchema` additionally carries
//      the parse-time `idempotency_class` → `manual_reconcile_only` normalization
//      that only a schema's `.default()` provides (I-005-3).
//        Within these Zod-validated surfaces there is a further asymmetry: the
//      result envelopes are `.strict()` (fixed-protocol response shapes — an
//      unknown key signals a protocol violation, so reject), while
//      `ProviderToolMetadataSchema` STRIPS unknown keys (extensible declaration
//      surface — `Spec-005 §Default Behavior` forward-compat: "Unknown capability fields are
//      ignored (tolerant reader)"). The four seam shapes side with the
//      ENVELOPES, not with the tool metadata: `CallbackToolInvocation`,
//      `McpServerStatusEmission`, `ProviderCommandEntry`, and
//      `ProviderOutputSpeedState` are fixed-field wire translations the DRIVER
//      constructs, so the tolerant-reader rationale (an extensible surface the
//      PROVIDER declares and later versions grow) does not reach them — an
//      unknown key there is a driver bug, so all four are `.strict()`. And
//      every untrusted free-form string parsed here is length / non-whitespace /
//      NUL-bounded via the package's `wireFreeFormString` helper (session.ts),
//      not a bare `z.string()` — these defense-in-depth bounds prevent
//      persistence / log-injection hazards on values that reach `driver_tools`,
//      `runtime_bindings`, and `runtime_node.capability_*` events. After T3.26
//      this file realizes ALL SEVENTEEN strings the canonical doc's
//      seventeen-string enumeration names, over the TWELVE PROVIDER-BOUNDARY
//      length caps declared below — T3.26 carrying that re-derivation from twelve
//      with the five strings its console-parity shapes introduced. Both counts are
//      scoped to THIS boundary: the seventeen-string enumeration censuses provider
//      OUTPUT, so the SDK-seam caps (3) declares are a SEPARATE set and move
//      neither number.
//   3. The CLIENT-FACING SDK-SEAM Zod schemas (`RunIdSchema`,
//      `InterruptRunParamsSchema`, `ApplyInterventionParamsSchema`, the three
//      `List*ResultSchema` replies, …) validate client→daemon WIRE input and the
//      daemon's own replies — a DIFFERENT boundary — and ship in Phase 4 (T4.2).
//      Do not conflate them with (2): (2) guards provider→daemon output; the SDK
//      seam guards client→daemon input. They carry their own length caps, declared
//      with their own section, for the same reason the boundaries are separate —
//      a cap sized against what a PROVIDER emits is not evidence about what a
//      CLIENT may send.
//
// I-005-1 (driver authority remains local even when the provider endpoint is
// remote): this contract IS the local surface. A driver MAY call a remote
// provider API behind these methods, but the control + execution authority
// stays attached to the local runtime node. The types deliberately carry no
// remote-authority handle, hosted-session reference, or control-plane dispatch
// shape — there is no way to express "execute via the control plane" in this
// contract, which is how the type system preserves the invariant.
//
// Refs: `Spec-005 §Required Behavior` (normalized contract), `Spec-005 §Required Behavior` (18-op surface),
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
// TYPE-ONLY at Phase 1 by design; the paired `RunIdSchema` co-locates HERE at
// T4.2, which is where its first consumer lands (`InterruptRunParamsSchema` at
// the client→daemon SDK seam). Authoring the schema at Phase 1 would have broken
// that phase's deliberate type-only ratification, so the brand shipped alone and
// the validator joins it now — same file, same section, per CP-005-6.
export type RunId = string & { readonly __brand: "RunId" };

// The runtime validator for the brand above, and the ONLY place a caller-supplied
// run id becomes a `RunId`.
//
// Homed here rather than in Plan-004's run-control contract for a STRUCTURAL
// reason, not a stylistic one: this file is the brand's lowest-tier consumer
// (Tier 4), and Plan-004's `runControl.ts` (Tier 5) / Plan-012's approval surface
// (Tier 6) import it UPWARD. Authoring it in either of those would make this
// file's own SDK seam import backwards across tiers — forbidden by the build
// order, not merely undesirable. Those higher-tier modules consume this symbol
// rather than declaring a sibling; a second `z.string().uuid().brand(...)`
// anywhere would be a second source of truth for what a run id is, and the two
// would drift the first time either grew a constraint.
//
// `brandedUuidIdSchema` (not a bare `z.string()`): a run id crossing the client
// boundary is an UNTRUSTED caller-supplied string, and UUID-shape rejection is
// what stops a path fragment, a SQL fragment, or an unbounded blob from reaching
// a store lookup keyed on this value. The double-`T` `ZodType<RunId, RunId>` the
// helper returns is what lets the schema compose into the request objects below
// under `exactOptionalPropertyTypes` (see the `IdempotencyClassSchema` note).
export const RunIdSchema: z.ZodType<RunId, RunId> = brandedUuidIdSchema<RunId>("RunId");

// --------------------------------------------------------------------------
// ProviderDriver — the 18-operation normalized contract (`Spec-005 §Interfaces And Contracts`)
// --------------------------------------------------------------------------
//
// T1.1 shipped ten operations; T1.8 added the four R8 parity operations
// (`rollbackTo`, `setSessionGoal`, `clearSessionGoal`, `probeAuth`), T3.19 the
// two transcript operations (`exportTranscript`, `replayTranscript`), and T3.26
// the two console-parity operations (`compactContext`,
// `listProviderCommands`), each at the position the canonical doc interleaves
// it, so this surface reads against api-payload-contracts.md § Plan-005
// line-for-line rather than appending a tail block that would have to be
// re-sorted later.
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
// `ReplayTranscriptParams`, `DriverTranscriptReplayResult`,
// `CompactContextParams`, `DriverCompactionResult`,
// `ListProviderCommandsParams`, `ProviderCommandListResult`) and
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
  // Capability-GATED on the `context_compaction` flag, under the same
  // static-refusal split as `rollbackTo` above. Compacts the bound session's own
  // provider-side context ON PARTICIPANT REQUEST — never on a threshold, timer,
  // or heuristic. It SETTLES on the provider's TYPED COMPACTION EVIDENCE (the
  // frame that already produces `usage.context_compacted`) and NEVER on the
  // request being accepted: the Codex method answers an empty ack and the Claude
  // leg is a `driver_command` frame that only settles, so acceptance is evidence
  // of delivery and of nothing else. There is deliberately NO prompt-injected
  // emulation arm — a driver that cannot compact declares the flag `false` and
  // the call refuses at the static gate. The wait for that evidence is BOUNDED
  // and TWICE-TERMINATED (the driver's own declared per-binding bound, and the
  // binding ceasing to be live), and bounding the OPERATION never bounds the
  // BOUNDARY'S RECORD: a compaction frame arriving after settlement still
  // normalizes exactly as an unsolicited provider-initiated compaction does.
  compactContext(params: CompactContextParams): Promise<DriverCompactionResult>;
  // Capability-GATED on the `provider_commands` flag. A LIVE read of the
  // provider's own native slash-command and skill enumeration for the bound
  // session, held as driver-session state and discarded with it: not persisted,
  // not cached across sessions, and folded into no projection — which is why this
  // capability adds no table and no column. Every entry carries the
  // `(driverName, providerAccountId)` it was read under, and that binding is a
  // ROUTING INVARIANT enforced here rather than trusted to a consumer.
  listProviderCommands(params: ListProviderCommandsParams): Promise<ProviderCommandListResult>;
}

// --------------------------------------------------------------------------
// Method parameter + return shapes
// --------------------------------------------------------------------------
//
// Leaf param/return types required by the 18 signatures above. Authored here
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
  // The REQUESTED accelerated-output mode (T3.26). Gated on the `output_speed`
  // flag and validated against that driver's declared `outputSpeedLevels` BEFORE
  // spawn, so an out-of-vocabulary value refuses rather than reaching the
  // provider. Spawn-bound for the same reason posture is: the axis is a settings
  // opt-in the provider reads at process start, so a fresh process is the only
  // place it can be realized — `ResumeSessionParams` re-realizes it below.
  // Requesting it is NOT the same as getting it: what the provider actually
  // declared is observed later as binding-held `ProviderOutputSpeedState`, and
  // no path rewrites either value into the other.
  outputSpeed?: string | undefined;
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
  // T3.17 — the provider account this leg is admitted against
  // (`Spec-005 §Interfaces And Contracts`, `Spec-029 §Node provider readiness and
  // the sign-in handoff`; consumed per CP-005-9). ADDITIVE-OPTIONAL: omitting it
  // is the unchanged pre-amendment path, in which the leg spawns against
  // whatever the node resolves as that provider's default.
  //
  // OPAQUE TO THE DRIVER, and that is the whole contract. A driver MUST NOT
  // parse it, derive a path from it, or use it to LOCATE credentials — it is a
  // daemon-minted identifier whose internal structure is Plan-029's and carries
  // no meaning here. What the driver receives instead is the ALREADY-CONSTRUCTED
  // spawn environment. Pinning that account's credential home into it, and
  // denying the ambient names a bound leg must not read, are OBLIGATIONS ON THE
  // SPAWN PATH — Plan-029's fail-closed binding, consumed here per CP-005-9 —
  // rather than properties this member carries or work any driver performs: the
  // daemon's environment builder strips exactly the names the request's resolved
  // credential policy denies, and no in-tree path pins a per-account home yet.
  // Stating that as an obligation rather than as a settled fact is the point.
  // What this member DOES settle is the driver side, and it settles it by
  // subtraction: two readers of the same identity — the daemon resolving a
  // credential home and a driver guessing at one — is precisely the second
  // source of truth that would let a run bill an account it was never admitted
  // against, so the driver is handed nothing it could guess FROM.
  //
  // SERVER-RESOLVED AND SERVER-STAMPED: a client-supplied value is an INPUT to
  // resolution, never the recorded outcome. What lands here, and what is durably
  // recorded, is the value the daemon resolved.
  //
  // The reason it is spawn-bound rather than per-turn: a run's paying account is
  // bound for the run's LIFETIME, so `ResumeSessionParams` re-realizes it below
  // from the durable record rather than re-resolving the current default.
  providerAccountId?: string | undefined;
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
  // The SIX DATA legs are reconstructed by the daemon from the durable
  // `runtime_bindings.spawn_config` record (written at every spawn; the column
  // ships with T1.7's currency migration) — never from the original client
  // request, which recovery does not have. Re-derived from five by counting when
  // T3.17 added `providerAccountId` below. The two FUNCTION legs are re-injected
  // fresh at every spawn; functions are never stored in `spawn_config`.
  executionPosture?: ExecutionPosture | undefined;
  // The FIFTH reconstructed data leg (T3.26), on exactly the ground the five
  // beside it stand on (re-derived from four by counting when T3.17 added
  // `providerAccountId`): a speed-less resume relaunches at the provider's default
  // while `agents.output_speed` still records the operator's accepted mode, which
  // is the silent-shedding failure this list exists to prevent. What the
  // relaunched process declares is observed as binding-held state, NOT returned
  // on `DriverResumeResult` — see `ProviderOutputSpeedState`.
  outputSpeed?: string | undefined;
  callbackTools?: SessionCallbackTool[] | undefined;
  subagentPolicy?: SubagentPolicy | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  // The SIXTH reconstructed data leg (T3.17), and the one whose silent shedding
  // is a BILLING fault rather than a capability one: a resume that re-resolved
  // "whichever account is default now" would move a live run's spend onto an
  // account it was never admitted against, mid-run, with the receipt's
  // per-paying-account key still claiming the original. So the value is read back
  // from the durable `runtime_bindings.spawn_config` record written at the
  // original spawn — never re-resolved, and never taken from a client request
  // recovery does not hold. Same opacity rule as on `CreateSessionParams` above.
  providerAccountId?: string | undefined;
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

// Driver-CONSTRUCTED return (§1(b)) of `listModels`. One selectable model of
// one provider, normalized at the driver's own boundary.
//
// `effortLevels` is the model's reasoning-effort vocabulary, and it is carried
// PER MODEL rather than per provider because that is what
// `Spec-005 §Provider Parameter Vocabularies` binds: the level list rides
// `ProviderModel.effortLevels`. It is deliberately `string[]` and not a closed
// union — the vocabularies differ between providers AND between models of one
// provider, and a union frozen here would refuse a level the installed build
// offers. ABSENT (not empty) is meaningful and is the registered reading: the
// model exposes no effort selection at all. An EMPTY array would instead assert
// that the model has an effort axis with nothing on it, which no provider
// surface expresses.
//
// `effortLevels?: string[] | undefined` carries the explicit `| undefined` this
// package uses for EVERY schema-backed optional (`ProviderToolMetadata`,
// `GetCapabilitiesResult.outputSpeedLevels`). It reads as a widening and is not
// one: under `exactOptionalPropertyTypes` a bare `?: string[]` forbids an
// explicit `undefined`, which is exactly what Zod's `.optional()` produces, so
// the bare form cannot be given a schema at all (TS2375). T4.2 is the first task
// to give this shape one — the vocabulary travels to the client that renders the
// effort selector — so the member takes the idiom the rest of the file already
// uses. Every existing constructor and reader is unaffected: absence still means
// "no effort axis", and no call site is newly required to supply anything.
export interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
  effortLevels?: string[] | undefined;
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
// T3.26 widens it to SEVENTEEN with the three console-parity flags
// (`context_compaction`, `provider_commands`, `output_speed`), APPENDED after
// `cost_cap` — which is where the canonical §Shared Enums order puts them, so
// the element-for-element rule above is satisfied by appending here for the same
// reason it was satisfied by inserting there. The union now matches the CHECK
// list `docs/architecture/schemas/local-sqlite-schema.md` already declares for
// `driver_capabilities.capability_flag`, and the row set catches up through the
// CHECK-widening migration this task ships (see the cardinality note below).
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
// T3.26's widening is the FIRST that cannot ride a whitelist head start: `0011`
// froze the CHECK at exactly fourteen values and pre-admits none of the three,
// so that migration rebuilds the already-shipped table in the documented
// `lang_altertable` shape AND backfills the three rows in one ordinal.
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
  // Participant-triggered compaction of the bound session's own provider-side
  // context via `compactContext` (T3.26). Native on Codex, emulated on Claude
  // through the one tripwire-exempt `driver_command` frame V1 produces.
  "context_compaction",
  // A LIVE read of the provider's own slash-command and skill enumeration via
  // `listProviderCommands` (T3.26). Held as driver-session state and discarded
  // with it, which is why this flag mints no table and no column.
  "provider_commands",
  // A participant-settable provider-side accelerated-output mode (T3.26). A
  // SINGLE-PROVIDER flag by construction: one pinned CLI declares such a state
  // and the other supplies neither conjunct this axis requires — no statically
  // declarable level vocabulary and no declared-state read — so the `false`
  // cell is a complete declaration rather than an unprobed gap. That sibling's
  // wire is NOT speed-silent (corrected 2026-08-31): it carries a per-turn
  // service-tier parameter. It is UNDECLARABLE on this axis, which is a
  // different claim and the only one this flag makes.
  "output_speed",
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
// TWELVE are consumed via `wireFreeFormString` (rejects empty / whitespace-only /
// NUL / over-max) — bare `z.string()` would let unbounded provider output reach
// `driver_tools`, `runtime_bindings`, and `runtime_node.capability_*` events.
// Twelve caps cover SEVENTEEN fields because four are reused across surfaces that
// carry the same category of value (see the per-cap notes) — the seventeen are
// exactly the canonical doc's seventeen-string enumeration, all of which this
// file now realizes. Both counts are PROVIDER-BOUNDARY counts. T4.2's
// client→daemon SDK seam declares its own caps in its own section at the foot of
// this file; those bound what a CLIENT may send and are censused by neither
// number. T3.26 carried that count from twelve to seventeen along
// with the five strings the console-parity shapes introduced, which is the
// re-derivation api-payload-contracts.md §Plan-005 names it the owner of.
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
//   • DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN (128) — `ProviderCommandEntry.name`
//     (T3.26); a name/label-tier token. A DISTINCT constant from the tool name
//     above on the same independently-owned grounds `DRIVER_MCP_SERVER_NAME_MAX_LEN`
//     stands on: a provider command name is minted by the provider's own command
//     registry and is resolved against nothing this contract declares.
//   • DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN (16384) —
//     `ProviderCommandEntry.description` (T3.26); prose/message tier, sized on
//     the tool-description grounds: a skill's front matter routinely carries
//     usage prose, and the helper REJECTS rather than truncates, so a tight cap
//     would drop the whole ENTRY (an entry is admitted or it is not) and make a
//     verbose skill look like one the provider does not publish.
//   • DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN (128) — `ProviderCommandEntry.scope`
//     and `ProviderOutputSpeedState.declared` (T3.26). One cap because it is one
//     category: a short provider-declared VOCABULARY token, carried verbatim and
//     narrowed to no closed set here (the Codex skill scope is one of four names;
//     the Claude speed state is one of three). Same-category reuse in the
//     `DRIVER_FALLBACK_ACTION_MAX_LEN` sense — a per-field cap would let two
//     values of one kind drift apart for no reason.
//   • DRIVER_OUTPUT_SPEED_REASON_MAX_LEN (512) — `ProviderOutputSpeedState.reason`
//     (T3.26); the provider's own explanation of why the declared state is not
//     the requested one. Short-prose tier, sized like `DRIVER_AUTH_DETAIL_MAX_LEN`
//     rather than the 32 KiB failure tier: it wraps no stack trace, and rejecting
//     it loses only the explanation while `declared` — the state itself — is a
//     separate field and survives.
export const DRIVER_TOOL_NAME_MAX_LEN = 128;
export const DRIVER_TOOL_DESCRIPTION_MAX_LEN = 16384;
export const DRIVER_FALLBACK_ACTION_MAX_LEN = 128;
export const DRIVER_BINDING_ID_MAX_LEN = 256;
export const DRIVER_FAILURE_DETAIL_MAX_LEN = 32768;
export const DRIVER_AUTH_DETAIL_MAX_LEN = 512;
export const DRIVER_TOOL_CALL_ID_MAX_LEN = 256;
export const DRIVER_MCP_SERVER_NAME_MAX_LEN = 128;
export const DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN = 128;
export const DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN = 16384;
export const DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN = 128;
export const DRIVER_OUTPUT_SPEED_REASON_MAX_LEN = 512;

// Per-GROUP entry cap on `ProviderCommandBindingGroup.entries` (T3.26). The
// enumeration is provider- and skill-authored and travels to a client, so an
// unbounded one is an arbitrarily large IPC response and renderer workload
// rather than a merely ugly read. Sized against the pinned surfaces rather than
// guessed: the Claude 2.1.251 session handshake publishes 119 interactive
// slash-commands, 58 skills, and 2 terminal-only commands (179 entries), so this
// cap does not truncate an honest provider while still bounding a pathological
// one. Truncation is never silent — the group carries `complete: false` — and it
// is a WIRE-AND-RENDER bound only: the driver's own held enumeration is NOT
// capped, so a truncated read can never manufacture a `command_absent` refusal
// for a command the provider actually publishes.
export const DRIVER_PROVIDER_COMMAND_ENTRIES_MAX = 512;

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
// `detectionSource` (T3.24) is ADDITIVE-OPTIONAL and LIVE-SCOPED, and the two
// halves are one decision rather than two: it is present and TOTAL over the flag
// set whenever this wrapper is a live driver read, and ABSENT exactly when the
// wrapper was reconstructed by `DriverCapabilitiesWriter.hydrate()` from the
// durable cache, which persists flag VALUES for change detection and NOT
// provenance. Absence therefore reads as "cache reconstruction" and never as
// "unknown provenance" — a consumer that needs provenance re-reads the driver.
// A REQUIRED member would be unsatisfiable on the hydrate path and would have
// forced a cache column whose only content is a fact about a reading that is
// over; no column is minted here for exactly that reason.
//
// Driver-side only: deliberately NOT mirrored into `CapabilityDetails` (the same
// carve-out `cliVersion` takes) and NOT carried on the client-facing
// `driver.listCapabilities` payload, which this member does not widen.
// `outputSpeedLevels` (T3.26) is the output-speed axis's VALUE VOCABULARY —
// present iff `capabilities.flags.output_speed` is `true`; absent or empty means
// the axis is unsettable and a caller carrying an `outputSpeed` refuses
// fail-closed rather than forwarding an unvalidated value.
//
// STATICALLY DECLARED from the same per-driver table the `output_speed` flag
// itself comes from, and never read from the provider: obtaining the provider's
// declared speed state costs a turn-bearing request, which is exactly the
// conjunct that makes that flag `static`, so a vocabulary sourced by reading
// would contradict its own detection source.
//
// It does NOT follow `detectionSource` into absence-on-hydrate, and that is a
// consequence of being static rather than a second rule: `detectionSource` is a
// fact about ONE READING and cannot be re-derived, while this is a constant of
// the DRIVER and always can. The durable capability cache therefore gains no
// column, and a client never receives `output_speed: true` without the values it
// must render — on either read path.
export interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
  cliVersion: DriverCliVersionReport;
  detectionSource?: Record<DriverCapabilityFlag, CapabilityDetectionSource>;
  outputSpeedLevels?: string[] | undefined;
}

// How one flag's declared value on THIS reading was arrived at (T3.24, mirroring
// `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)`).
//
//   * `probed` — read from the installed build by a zero-turn probe whose
//     negative control still refused. `Spec-005 §Capability discovery` admits a
//     probe only where it is all three of zero-turn, non-mutating, and decisive
//     at the granularity the capability is consumed at.
//   * `static` — declared from the driver's own per-driver table, which that
//     same rule admits only where no ADMISSIBLE probe exists, and only where the
//     driver's mechanism table names the conjunct that fails.
//
// A bare union rather than a `const` tuple plus a derived type: there is no
// runtime consumer here — no iteration, no membership test, no schema built from
// the values — and the sibling `RecoverySpanClassification` sets that precedent
// in this file. The runtime half lives with the mechanism table that produces
// the values (`runtime-daemon/src/provider/capability-probe.ts`), where the
// per-driver totality is a compile-time `Record` obligation.
export type CapabilityDetectionSource = "static" | "probed";

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
  .strict()
  // Cross-field, because the two members contradict each other on one arm: the
  // refusal code IS the classification that the participant's text was
  // swallowed, and a swallowed text is precisely what `applied` denies. A
  // version-skewed driver reporting the pair must fail parse at this trust
  // boundary rather than hand out a result whose two readers disagree — a
  // caller keying on `status` reporting success while one keying on
  // `refusalCode` reports failure. (`.superRefine()` returns `this` — the
  // Zod-4 property event.ts's audit-integrity pairing rule records — so the
  // flat-envelope annotation above still holds.)
  .superRefine((result, ctx) => {
    if (result.status === "applied" && result.refusalCode !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["refusalCode"],
        message:
          "refusalCode classifies the participant text as swallowed, which status 'applied' denies; the code is expressible only on a degraded result.",
      });
    }
  });

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
// T3.16 — Typed provider usage-limit signal (`Spec-005 §Fallback Behavior`;
//         consumed by `Spec-017 §Provider-limit pacing and durable resumption (SA-40)`
//         C-19 through CP-005-9 / CP-017-10; verifies I-005-6)
// --------------------------------------------------------------------------
//
// A SIBLING AXIS beside `RecoveryCondition`, minted on exactly the ground
// `RecoverySpanClassification` above was minted on: the two answer different
// questions. Every `RecoveryCondition` member means A HUMAN MUST ACT — reconcile
// the diverged span, or re-authenticate the provider CLI on the runtime node. A
// spent usage allowance means the opposite: no operator action shortens the
// wait, and the run resumes unattended once the provider's window turns over.
// Folding this into `RecoveryCondition` would route a self-clearing pause into
// the operator-remediation queue, which is the conflation that axis exists to
// prevent — and widening the union would silently re-type every existing
// consumer's exhaustive switch.
//
// RECOGNITION IS TYPED-ONLY (I-005-6). A driver emits a signal ONLY when a
// STRUCTURED provider event it can NAME states the allowance is spent. Prose in
// a message, a process exit code, and a bare HTTP status are all forbidden
// inputs: each is a surface the provider may reword or reuse freely, so matching
// on one converts an upstream copy edit into a silent misclassification here.
// An unrecognized shape therefore emits NOTHING, and that absence reads "not
// known to be limited" — never "known not to be limited".
//
// NO CAPABILITY FLAG IS ADDED, and `DRIVER_CAPABILITY_FLAGS` above is restated
// UNWIDENED. Recognition is a UNIFORM OBLIGATION of every driver, the footing
// `probeAuth` already stands on: a flag would let a driver declare the
// obligation away, and a run the provider refused for spend would then sit in
// the generic failure path with nothing telling anyone why.
//
// NOMINAL rather than Zod, by the file header's own rule rather than by
// exception. The Zod set in the header's (2) exists for surfaces that carry
// provider-VERBATIM values across the trust boundary — `ProviderOutputSpeedState`
// is schema'd because `declared` is the provider's own string, and
// `ProviderCommandEntry` because the command names are. NO member below is
// provider-verbatim: `cause` and `provenance` are closed literals the driver
// SELECTS, and `resetsAt` is a timestamp the driver COMPOSES. A schema over them
// would validate the driver against itself. Same disposition, and the same
// reason, as `RecoverySpanClassification`. No count in the header moves.

// The closed cause set. ONE member today, and the arity is a finding rather than
// a placeholder: across both pinned provider surfaces, exactly one condition
// satisfies this axis's own defining property — that it clears on its own.
//
// `plan-allowance-exhausted` — the subscription/plan allowance for a rolling
// window is spent. It clears when the window turns over, with no operator
// action, which is what makes it this axis's member.
//
// DELIBERATELY EXCLUDED, enumerated so that a typed provider arm reaching a
// driver and producing nothing is a RECORDED decision rather than a hole (an
// excluded arm and a dormant one are not the same thing, and collapsing them is
// how a normalizer quietly stops covering its wire):
//   * A DEPLETED CREDIT BALANCE (Codex `workspace_owner_credits_depleted` /
//     `workspace_member_credits_depleted`). No window turnover restores a
//     balance — a purchase does. It is operator-remediable, so it fails this
//     axis's defining property, and admitting it here would park a run against a
//     boundary at which nothing changes.
//   * A PAYMENT FAULT (Claude `billing_error`). Same reason: a human must act.
//   * A SPEND-CONTROL CEILING (Codex `spendControlReached`). That is an
//     administrative budget state carried on a snapshot, not a statement that a
//     turn was refused, and reading a state flag as a refusal would park runs
//     that the provider is still willing to serve.
// WHERE THE EXCLUDED ARMS GO TODAY: nowhere in particular, and that is stated
// rather than implied. Neither `RecoveryCondition` member names them — that
// union is `recovery-needed | reauth-required` — so a turn refused for any of
// the three settles on the driver's ordinary turn-failure path, unchanged by
// this task. Excluding them from THIS axis is the decision recorded here; giving
// them a typed home of their own is a separate one nothing above claims to make.
// Widening this union is an ordinary amendment; inventing a free string is not.
export type ProviderUsageLimitCause = "plan-allowance-exhausted";

// Where the reset instant CAME FROM, carried on the boundary itself rather than
// inferred by the consumer from which driver produced it.
//
// `provider-stated` — the provider named this instant, for the window it also
// named as the spent one. `runtime-derived` — the provider named no reset
// instant, and the daemon computed one from a delay the provider did give. The
// two are not interchangeable evidence: a consumer may arm a schedule on either,
// but only the first is safe to SHOW as the provider's own answer, and only the
// second should widen when a retry lands early.
export type ProviderUsageLimitResetProvenance = "provider-stated" | "runtime-derived";

// The boundary, as ONE object rather than two sibling optionals on the signal.
// That is the structural point: "an instant with no provenance" and "a
// provenance stamp with no instant" are both inexpressible, so a consumer that
// has an instant always knows what it is worth.
export interface ProviderUsageLimitResetBoundary {
  // RFC 3339 UTC, the encoding `PhaseState.autoResumeAt` already consumes, so
  // the pacing surface carries this value through without re-encoding it.
  resetsAt: string;
  provenance: ProviderUsageLimitResetProvenance;
}

// The signal itself. The BOUNDARY IS OPTIONAL AND THE CAUSE IS NOT, because the
// two absences mean different things and only one of them is routine: a
// recognized refusal parks the run whether or not a window was reported, and a
// missing boundary changes only whether a resume is SCHEDULED. An absent
// boundary means no reset instant is known from what has been observed — never
// that the provider publishes none.
export interface ProviderUsageLimitSignal {
  cause: ProviderUsageLimitCause;
  resetBoundary?: ProviderUsageLimitResetBoundary | undefined;
}

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
  // A logged turn's body exceeded the append-time plaintext ceiling and is
  // stored as a codepoint-boundary PREFIX, so the fold carries the prefix and
  // names the loss rather than replaying a silently shortened turn. Deliberately
  // NOT folded into `context_truncated`, whose scope is the memo budget evicting
  // whole exchanges and never halves, and not reported as
  // `turn_content_unavailable`, which would overstate a turn that is available
  // as a prefix.
  //
  // RECOGNIZED here and produced nowhere in this workspace, which is the
  // ordering the canonical contract prescribes rather than a field minted ahead
  // of its reader: a loss kind is an amendment, never a code-first free string,
  // so the vocabulary entry precedes its producer. The signal it reports is a
  // durable per-event flag that does not exist yet (Plan-006 Phase 3B's
  // `session_events.content_payload` and its `contentTruncated` marker), and the
  // leg that would read that flag into a loss list is a fold-emission leg
  // `Plan-005 §Cross-Plan Obligations` names as an unowned residual — no task
  // in that plan yet reads it.
  //
  // It has two readers the day it lands, and both get strictly better for
  // knowing it. The memo continuity-marker parser refuses a record carrying any
  // token it cannot place, so a marker written by a daemon that DOES know this
  // kind would otherwise degrade that whole record to unreadable; and the
  // unreadable-record upper bound reports this very list, which is a bound only
  // while the list is the whole vocabulary.
  "turn_content_truncated",
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
      // Present on the stand-in the settle emits for an ID-LESS legacy tool
      // result whose enclosing reasoning block resolved `private` at turn close.
      // The body was read and withheld, so `text` is empty and
      // `contentUnavailable` stays absent — setting it would claim a read
      // failure that never happened, the exact lie the deferred settlement was
      // built to avoid.
      //
      // A `text` arm rather than the `tool_result` + `enclosureDisclosure`
      // carrier because that arm REQUIRES `toolCallId` and a legacy id-less
      // result has none: minting a synthetic id would hand the pairing repair a
      // call to chase that no provider ever made. Like `enclosureDisclosure`,
      // this member rides the segment it governs and survives any positional
      // bound the segment survives — which is the point: a bound between the
      // result and its later-logged private reasoning row cuts away the only
      // sibling that could classify it, and without this marker that bounded
      // export would declare nothing.
      //
      // Never rendered and never exported: the strip drops the segment and
      // declares `provider_private_reasoning`. Closed at one literal because
      // only the `private` disposition withholds a read body — an `unknown`
      // enclosure keeps its placeholder on the `contentUnavailable` path.
      withheldEnclosure?: "private" | undefined;
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
// T3.26 — Console-parity shapes (`Spec-005 §Desktop Console Parity Surfaces`)
// --------------------------------------------------------------------------

// Daemon-CONSTRUCTED params (§1(a)), so nominal. They stay BINDING-addressed
// because run -> bindings is 1:many and each operation acts on exactly one leg;
// they cross no wire, and no client constructs one. The client-facing verbs take
// a run (compaction) and an agent (enumeration) and the daemon resolves the
// binding at dispatch — that resolution is the SDK seam's, not this layer's.
export interface CompactContextParams {
  sessionId: SessionId;
  bindingId: string;
}

// The result of a compaction ATTEMPT, not of the request — a DISCRIMINATED UNION
// on `status`, so no arm can carry a member another arm's state makes
// meaningless and no consumer has to guess which optional members its arm
// implies.
//
//   * `applied` is reachable ONLY after the provider's typed compaction frame is
//     observed, and `boundaryPosition` is REQUIRED there, typed `number | null`
//     so a frame carrying no position is representable without being
//     synthesized (the `RollbackDegradedResult` shape).
//   * `refused` means NOTHING WAS SENT.
//   * `failed` means something WAS sent and no boundary was witnessed.
//
// There is deliberately no `capability_undeclared` reason: an undeclared flag
// refuses at the static capability gate with `driver.capability_unsupported`
// BEFORE the driver is called, so an arm for it would be a second, contradictory
// encoding of one refusal.
export type DriverCompactionResult =
  | { status: "applied"; boundaryPosition: number | null }
  // `command_absent`: the pre-dispatch presence check on the emulated leg did not
  // find the command in the provider's own enumeration for this binding.
  // `not_permitted`: the run-control adjudication denied the caller — produced by
  // the daemon-side gate, never by a driver, which runs no authorization of its
  // own; the arm lives here because the refusal settles on the operation's own
  // result rather than as a JSON-RPC error.
  | { status: "refused"; reason: "command_absent" | "not_permitted" }
  // `wait_expired`: the driver's declared per-binding compaction bound elapsed
  // with no typed compaction frame. `binding_lost`: the binding stopped being
  // live before one arrived. `provider_error`: the mechanism itself errored.
  // Every arm records a diagnostic; none is silent, and none can settle
  // `applied`.
  | { status: "failed"; reason: "wait_expired" | "binding_lost" | "provider_error" };

// A STRUCTURAL ASSERTION SCHEMA, and deliberately NOT one of the untrusted-result
// envelopes beside it — the distinction matters enough to state, because reaching
// for the wrong one here would put a `.strict()` wire guard on the wrong trust
// class. This result is DAEMON-CONSTRUCTED: the driver composes it from a
// settlement the daemon's own wait computed, so there is no untrusted envelope to
// parse. Two consumers read it. The conformance suite asserts against it so the
// two structural rules the canonical doc states stay MECHANICALLY CHECKABLE
// rather than narrated — `applied` without a `boundaryPosition` key does not
// parse, and `capability_undeclared` is not a reason any arm admits. And since
// T4.9 it is also `driver.compactContext`'s registered RESULT schema, which the
// registry's I-007-7 result validation runs every reply through — guarding the
// same daemon-composed trust class the roster reply schemas below guard (a
// composition-bug catcher on the way out, never a provider trust boundary).
//
// The one genuinely untrusted number involved, the provider's own boundary
// position, is read at the frame-normalize boundary where every other provider
// number is read, and reaches this result already narrowed.
export const DriverCompactionResultSchema: z.ZodType<
  DriverCompactionResult,
  DriverCompactionResult
> = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      // `.nullable()` and NOT `.optional()`: null is the positive statement that
      // the provider's frame carried no position, while an absent key would be
      // indistinguishable from a driver that forgot to report one.
      boundaryPosition: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["command_absent", "not_permitted"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum(["wait_expired", "binding_lost", "provider_error"]),
    })
    .strict(),
]);

export interface ListProviderCommandsParams {
  sessionId: SessionId;
  bindingId: string;
}

// One enumerated provider command or skill. `binding` is not decoration: it is
// the routing key the invariant is enforced on, carried WITH the data so a
// consumer cannot lose it by filtering a held list instead of re-reading. Its
// `providerAccountId` is NULLABLE because a session need not have bound an
// account at all; see the schema below for why absence is stated rather than
// synthesized.
//
//   * `kind` distinguishes the two things providers publish under one syntax.
//   * `description` is OMITTED, never carried as an empty string, when the
//     provider publishes none. That is a real case rather than a hypothetical:
//     the Codex skills surface types its description as REQUIRED, so a skill
//     whose front matter declares none arrives as `""` — and the schema below
//     bounds this member with `wireFreeFormString`, which rejects empty and
//     whitespace-only. A driver that forwarded the empty string verbatim would
//     therefore fail its own enumeration on an honest provider reading. Omission
//     is also the truthful encoding: the member's absence already means "the
//     provider published no description", and an empty string would say the
//     provider published one and it was blank.
//   * `scope` is present only where the provider declares one (the Codex skills
//     surface does; the Claude handshake enumeration does not), so its absence
//     means the provider stated no scope — never that the scope is unknown.
//   * `enabled` follows that same present-iff-the-provider-declares-one rule: the
//     Codex `skills/list` entry carries an `enabled` Boolean and the Claude
//     handshake enumeration publishes no enabled/disabled distinction at all, so
//     ABSENT means the provider draws no such distinction on this surface —
//     never that the entry's state is unknown, and NEVER a driver-synthesized
//     `true`, which would be exactly the fabricated reading the verbatim rules
//     here forbid.
//
// The driver DOES NOT FILTER: a disabled entry is RETURNED, because dropping it
// would make the result stop being the provider's enumeration as observed and
// would leave a consumer unable to tell a disabled command from one that does not
// exist. What the flag governs is OFFERABILITY, not presence.
//
// V1 IS ENUMERATION AND DISCOVERY, NOT A DISPATCH CHANNEL. No member here is a
// dispatch handle and no route takes one: the ONLY entry V1 sends is the
// compaction command, composed by the driver's own emulated leg and reached
// through `compactContext`, which checks presence against this same enumeration.
export interface ProviderCommandEntry {
  name: string;
  kind: "command" | "skill";
  description?: string | undefined;
  scope?: string | undefined;
  enabled?: boolean | undefined;
  binding: { driverName: string; providerAccountId: string | null };
}

// A driver-NORMALIZED seam shape (§2) — the THIRD, joining
// `CallbackToolInvocation` and `McpServerStatusEmission`. It sides with the
// ENVELOPES rather than with the tolerant `ProviderToolMetadata`: the driver
// constructs this from what its own provider published, so an unknown key is a
// driver bug and the shape is `.strict()`. Both provider-authored strings are
// `wireFreeFormString`-bounded because a local skill file's front matter is
// operator-writable and the assembled list travels to a client.
export const ProviderCommandEntrySchema: z.ZodType<ProviderCommandEntry, ProviderCommandEntry> = z
  .object({
    name: wireFreeFormString(DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN, "ProviderCommandEntry.name"),
    kind: z.enum(["command", "skill"]),
    description: wireFreeFormString(
      DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
      "ProviderCommandEntry.description",
    ).optional(),
    scope: wireFreeFormString(
      DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
      "ProviderCommandEntry.scope",
    ).optional(),
    enabled: z.boolean().optional(),
    binding: z
      .object({
        driverName: z.string().min(1),
        // NULLABLE, and not `.optional()`. A session can genuinely hold no bound
        // provider account — the account registry is a spawn-time binding that
        // not every leg carries — and `null` is the POSITIVE statement that none
        // was bound. The alternatives are both worse: an absent key is
        // indistinguishable from a driver that forgot to report one, and a
        // synthesized placeholder (`""`, `"unknown"`, the driver name) would make
        // the routing invariant UNENFORCEABLE while looking enforced, because two
        // accountless bindings on different providers would compare equal on the
        // half of the pair that is supposed to separate them.
        //
        // `null` therefore MATCHES NOTHING, never a wildcard — an accountless
        // enumeration can be read but never used to route a dispatch onto some
        // other binding. That is an OBLIGATION ON THE CONSUMER rather than a
        // property this schema enforces: no pair-comparison predicate exists
        // yet, and where it lands is recorded on `ProviderCommandListResult`
        // below. It is stated here because the encoding is what makes the
        // obligation satisfiable at all — under a synthesized placeholder the
        // consumer would have nothing left to separate two accountless bindings
        // by, whatever predicate it eventually ran.
        //
        // TWO PRODUCER-SIDE FACTS COINCIDE ON THIS ONE ARM, DELIBERATELY. A
        // driver reports `null` both when no account is bound and when it has no
        // reader for the account registry at all — the registry is the daemon's,
        // and neither establishment params object carries an account id, so a
        // driver built without that injected reader cannot ask. Separating the
        // two would mint a third state whose only consumer treats it identically
        // to the second: the obligation above reads identically on both, so
        // neither fact may authorize a dispatch onto another binding, and the
        // safe direction is the same one. A reader is therefore owed to any consumer
        // that must distinguish them — none exists in V1 — and this arm is
        // documented as the union of the two rather than silently the first.
        providerAccountId: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

// One live binding's enumeration. `runId` and `binding` TOGETHER say where these
// entries came from: neither alone is a key (run -> bindings is 1:many, and one
// agent can hold bindings on the same provider and account across two runs), and
// no claim is made that either is unique — the pair is PROVENANCE a client can
// read and construct, not an addressing handle.
//
// `complete: false` means the provider published more entries than the cap admits
// and this group's tail was dropped. The cap and the flag are PER GROUP, so one
// truncated binding never marks another complete or incomplete.
export interface ProviderCommandBindingGroup {
  // NULLABLE for the same reason `providerAccountId` is, and never omitted:
  // absence is STATED, never synthesized. An enumeration is a property of the
  // BINDING, and a binding outlives any one of its runs, so there are two
  // distinct reads where no single run attributes the entries:
  //
  //   1. ZERO RUNS ARE LIVE — the ordinary pre-first-turn palette read. A client
  //      opening the command surface before the session's first turn is asking a
  //      perfectly answerable question, so this read SUCCEEDS with `null` rather
  //      than refusing; there is nothing wrong with a binding that has not run
  //      anything yet.
  //   2. TWO OR MORE RUNS ARE LIVE on the one binding — no single run is the
  //      attributable one, and picking either would be a coin flip presented as
  //      provenance.
  //
  // Exactly one live run answers with THAT run. A last-bound fallback was
  // considered and REJECTED: a never-cleared id naming a run that has already
  // retired is false provenance, which is strictly worse than the honest `null`
  // this member carries — the whole point of the pair is that a client can trust
  // what it reads.
  runId: RunId | null;
  binding: { driverName: string; providerAccountId: string | null };
  entries: ProviderCommandEntry[];
  complete: boolean;
}

// The reply is the GROUP LIST, never a bare entry array: an agent can hold
// several live bindings at once, so a flat array would hand a consumer an
// arbitrary leg's commands with the provenance stripped. A single-binding agent
// yields one group, so the common case costs one level of nesting and the
// concurrent case stays representable instead of silently collapsing.
//
// THE DRIVER OPERATION RETURNS EXACTLY ONE GROUP, in this shared envelope: its
// params name ONE binding, and one binding has one enumeration. The envelope is
// shared with the client-facing verb rather than split in two because the fan-out
// across an agent's live bindings — and the merge back into one reply — belongs
// to the daemon-side resolution that knows which bindings an agent holds, and a
// second single-group type would make that merge a shape conversion instead of a
// concatenation.
//
// THE PAIR-COMPARISON PREDICATE IS THE FAN-OUT'S, NOT THIS OPERATION'S. The
// routing invariant is that an entry is offerable and dispatchable only through
// agents of the binding it was read under, and it is enforced at the daemon
// rather than trusted to the renderer. A driver cannot enforce it here: this
// operation's params name one binding and it answers for that binding alone, and
// a driver comparing the pair against itself would refuse every ACCOUNTLESS read
// — the ordinary case — because `null` matches nothing by design. The comparison
// therefore belongs to the client-facing handler that fans out across an agent's
// live bindings and merges the groups back (Plan-005 T4.9), which is the only
// layer holding two bindings at once. What each driver does enforce is the
// stronger local guard: a dispatch goes into the very process whose enumeration
// it read, matched by that process's own identity rather than by the pair.
export interface ProviderCommandListResult {
  bindings: ProviderCommandBindingGroup[];
}

// The provider's own report of its accelerated-output state — never a probe of
// its own and never synthesized from the request.
//
// IT IS BINDING-HELD DRIVER-SESSION STATE, NOT A SPAWN RETURN. The declaring
// handshake is emitted only as part of a turn-bearing exchange, so neither
// `createSession` nor `resumeSession` can carry it: both resolve before the first
// such exchange, and neither may spend a synthetic turn or block waiting for one.
// The driver records this against the binding WHEN THE HANDSHAKE ACTUALLY
// ARRIVES, on the first turn-bearing exchange the participant's own work
// produces, and holds it for the binding's life. Until then the binding HAS NO
// OBSERVATION, and every reader is absent-until-observed rather than defaulted.
//
// READ AND DISCARDED WITH THE SESSION: deliberately NOT written to
// `runtime_bindings.spawn_config`, which records what was REQUESTED so a resume
// can re-realize it, and not to `agents.output_speed`, which records the
// operator's accepted choice. Persisting an observation into either would create
// a second, staler record of a fact the live session already holds — and would
// make a mode that stopped being available look accepted after a restart.
//
// `declared` is carried VERBATIM and is deliberately NOT narrowed to
// `outputSpeedLevels`: that vocabulary bounds what a caller may REQUEST, while
// this is what the provider REPORTED, and a provider reporting a level the
// driver's table does not list is reporting a real state under version skew —
// coercing it would fabricate exactly the false reading this shape exists to
// prevent. `reason` is the provider's own explanation, present only where the
// provider supplied one; its absence means the provider gave no reason, never
// that there was none.
export interface ProviderOutputSpeedState {
  declared: string;
  reason?: string | undefined;
}

// The FOURTH driver-normalized seam shape (§2), `.strict()` on the same grounds
// as the third.
export const ProviderOutputSpeedStateSchema: z.ZodType<
  ProviderOutputSpeedState,
  ProviderOutputSpeedState
> = z
  .object({
    declared: wireFreeFormString(
      DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
      "ProviderOutputSpeedState.declared",
    ),
    reason: wireFreeFormString(
      DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
      "ProviderOutputSpeedState.reason",
    ).optional(),
  })
  .strict();

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
    // The named `RunIdSchema` const, which T4.2 shipped beside the brand at the
    // top of this file. This site previously inlined `brandedUuidIdSchema<RunId>`
    // because the exported symbol did not exist yet; now that it does, a second
    // inline construction of the same validator would be a second source of truth
    // for run-id shape — the precise drift CP-005-6 co-locates the pair to avoid.
    runId: RunIdSchema,
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

// --------------------------------------------------------------------------
// T4.2 — Client-facing SDK-seam wire schemas
//        (`Spec-005 §Capability discovery`; Plan-005 §Phase 4 decisions
//         #2 / #3 / #4; verifies I-005-4)
// --------------------------------------------------------------------------
//
// THE THIRD BOUNDARY, and the reason this section does not reuse a single
// constant from the block above. Everything before this line guards one of two
// directions: §1 nominal TypeScript for shapes the DAEMON constructs and hands
// to a driver (and the shapes a driver hands back inside the daemon's own
// process), and §2 Zod validation of PROVIDER output crossing into the daemon.
// This section is neither. It guards CLIENT input crossing into the daemon over
// JSON-RPC, plus the daemon's own replies going back out. A caller here is an
// SDK consumer on the far side of a socket — untrusted in exactly the way a
// provider process is, but untrusted about DIFFERENT values. A cap sized against
// what a provider EMITS is not evidence about what a client may SEND, so the
// caps below are a disjoint set and the provider-boundary census (twelve caps
// over seventeen strings) does not move.
//
// WHAT IS REGISTERED, AND WHAT DELIBERATELY IS NOT. Plan-005 §Phase 4 decision
// #2 fixes the client-facing surface at the `driver.*` names that operate on an
// ALREADY-EXISTING session or run. The four lifecycle operations —
// `createSession`, `resumeSession`, `startRun`, `closeSession` — establish,
// restore, start, or tear one down, so they are orchestration-owned and get NO
// client-facing schema here. Their absence IS the contract: a shape that does
// not exist cannot be reached by a client guessing a method name, and one minted
// "for symmetry" would be a wire surface with no registered method and no
// reader — the same mistake `Spec-005 §Capability discovery` forbids when it
// requires a capability flag to be minted together with its consumer.
//
// The nine pairs below are exactly the nine names the daemon registers — T4.1's
// six request/response verbs, T4.4's subscription leg, and T4.9's two
// console-parity verbs:
//   `driver.listCapabilities`  DriverReadParams        -> ListCapabilitiesResult
//   `driver.listModels`        DriverReadParams        -> ListModelsResult
//   `driver.listModes`         DriverReadParams        -> ListModesResult
//   `driver.interruptRun`      InterruptRunParams      -> DriverAckResult
//   `driver.applyIntervention` ApplyInterventionParams -> DriverInterventionResult
//   `driver.respondToRequest`  RespondToRequestParams  -> DriverAckResult
//   `driver.subscribeEvents`   DriverSubscribeEventsParams -> SubscribeAckResponse
//   `driver.compactContext`    CompactContextRequest   -> DriverCompactionResult
//   `driver.listProviderCommands` ListProviderCommandsRequest -> ProviderCommandListResult
// The two T4.9 request schemas live at the end of this section. Their result
// schemas are shared rather than minted twice: `DriverCompactionResultSchema`
// ships beside its §1 union (where its comment records this second duty), and
// `ProviderCommandListResultSchema` (below) parses its entries through §2's
// `ProviderCommandEntrySchema`, because the entries ARE driver-normalized
// provider output and a second entry schema here would drift from the first.
//
// WHY THE THREE READS TAKE NO PARAMETERS. Plan-005 §Phase 4 T4.3 ratifies the
// consuming `DriverClient` interface with `listCapabilities()`, `listModels()`,
// and `listModes()` written no-arg while `interruptRun(p)`,
// `applyIntervention(p)`, and `respondToRequest(p)` take one. That asymmetry is
// deliberate and it is a signature, so a `{ driverName }` request here would
// contradict a ratified line rather than merely differ from it. The refusal arm
// a per-driver request would have carried is not lost: the reads are served from
// the daemon's capability cache with no provider round-trip per call, so there
// is no unavailable driver to refuse ON; the run-addressed verbs below keep
// `driver.unavailable` reachable where a live binding actually is required.
//
// WHY THE THREE READS REPLY PER DRIVER. Each reply is a GROUP LIST keyed by
// `driverName`, never a flat merged array — the same rule
// `ProviderCommandListResult` states for provider commands. A flat array would
// hand a caller one arbitrary driver's models with the provenance stripped, and
// a caller cannot re-derive which driver published an entry from the entry
// itself: model ids collide across providers and mode ids carry no vendor
// marker. Grouping is what keeps a Claude-published value from being offered to
// or sent through a Codex-bound agent.
//
// WHAT THE CAPABILITY REPLY CARRIES, AND WHAT STOPS AT THE DRIVER. `Spec-005
// §Capability discovery` scopes this reply precisely: "the registered
// client-facing payload carries the flags". `GetCapabilitiesResult` additionally
// carries `detectionSource`, `cliVersion`, and `tools`, and `Spec-005 §Required
// Behavior` rules that the mechanism grades and `cliVersion` alike "stop there"
// — they do not reach this payload, and a consumer needing provenance or a
// version reads it through the daemon rather than off this reply. `tools` is a
// daemon-side ingress concern (it reaches `driver_tools` and the
// `runtime_node.capability_*` events, which is where its readers are), and no
// clause routes it to a client, so it is omitted on the stated bias that adding
// a member later is additive while removing one is a break. `outputSpeedLevels`
// is the one member that DOES cross, and it must: `Spec-005 §Provider Parameter
// Vocabularies` makes its reader a participant-facing control, so a client would
// otherwise receive `output_speed: true` without the values it has to render.

// Per-field length caps for the SDK seam. Same defense-in-depth posture as the
// provider-boundary block (the framework layer is authoritative on body size;
// these are the second line), and consumed through the same
// `wireFreeFormString` helper so empty, whitespace-only, NUL-bearing, and
// over-length values all refuse rather than reaching a store lookup or a driver
// dispatch.
//
//   • DRIVER_WIRE_TOKEN_MAX_LEN (128) — the short identifier/label tier on this
//     seam: model and mode `id` + `name`, and the provider-declared vocabulary
//     tokens inside `capabilities`, `effortLevels`, and `outputSpeedLevels`. One
//     cap because it is one category — a per-field cap would let five values of
//     one kind drift apart for no reason. Sized with 5x headroom over the pinned
//     surfaces (the longest published model id at this spec's pins is 25
//     characters).
//   • DRIVER_WIRE_HANDLE_MAX_LEN (256) — the opaque provider correlation handles
//     a client echoes BACK to the daemon: `RespondToRequestParams.requestId` and
//     `SteerPayload.expectedTurnId`. Opaque-handle tier, deliberately roomier
//     than the token tier because neither value is a label a human reads and
//     neither is minted here — refusing a legitimate provider-minted handle
//     would make an answerable request unanswerable.
//   • DRIVER_WIRE_REASON_MAX_LEN (512) — the human-authored `reason` on
//     `InterruptRunParams`, `InterruptPayload`, and `CancelPayload`. Short-prose
//     tier, matching the `DRIVER_AUTH_DETAIL_MAX_LEN` sizing rather than the
//     32 KiB failure tier: a reason wraps no stack trace, and the helper rejects
//     rather than truncating, so an over-long one refuses the whole
//     intervention. That is the right trade for a field whose loss costs only
//     descriptive colour while the intervention itself is expressible without
//     it.
//   • DRIVER_WIRE_STEER_CONTENT_MAX_LEN (16384) — `SteerPayload.content`, the
//     participant's actual directive text. Prose/message tier, sized like the
//     tool-description cap: a steer routinely carries a paragraph of correction
//     and occasionally a pasted fragment, and because the helper REJECTS the
//     whole payload rather than truncating it, a tight cap would silently make
//     long-but-honest corrections impossible to send. This is the one cap on
//     this seam whose value a participant typed, so it is sized to accept what a
//     participant plausibly types.
//   • DRIVER_WIRE_CATALOG_ENTRIES_MAX (256) — per-driver entry cap on the model
//     and mode lists, and on the token arrays inside a model. Unlike
//     `DRIVER_PROVIDER_COMMAND_ENTRIES_MAX` this cap REJECTS rather than
//     truncating with a completeness marker, because these replies carry no
//     `complete` flag and a silently short catalog would look to a renderer
//     exactly like a provider that publishes fewer models. Sized far above the
//     pinned surfaces (eight models on the Codex leg, four on the Claude leg),
//     so tripping it means a daemon-side composition bug rather than an honest
//     catalog.
//   • DRIVER_WIRE_STEER_ATTACHMENTS_MAX (64) — count cap on
//     `SteerPayload.attachments`. The element type is `unknown` by contract, so
//     this bound is on COUNT alone and the framework layer's body-size limit is
//     what bounds the bytes; without it a single steer could carry an unbounded
//     array of arbitrary JSON through the daemon and into a driver dispatch.
//   • DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN (64) — `DriverCapabilities.contract\
//     Version` on the capability reply. This is the ONE cap on this seam that
//     duplicates a value rather than choosing one: it deliberately matches
//     `CAPABILITY_CONTRACT_VERSION_MAX_LEN` (event-core.ts), which bounds the
//     same field on the `runtime_node.capability_*` event payloads, so a version
//     string that survives this reply also survives the event and the two
//     surfaces cannot disagree about one value. The constant is redeclared here
//     rather than imported because event-core.ts already imports
//     `DRIVER_CAPABILITY_FLAGS` from this file — the import back would close a
//     value cycle whose provider-driver-first evaluation order leaves that array
//     in its temporal dead zone, crashing module init rather than merely
//     warning. Redeclaring is the cost of not restructuring two modules for one
//     integer; the coupling is stated here so a future change to either lands on
//     both.
export const DRIVER_WIRE_TOKEN_MAX_LEN = 128;
export const DRIVER_WIRE_HANDLE_MAX_LEN = 256;
export const DRIVER_WIRE_REASON_MAX_LEN = 512;
export const DRIVER_WIRE_STEER_CONTENT_MAX_LEN = 16384;
export const DRIVER_WIRE_CATALOG_ENTRIES_MAX = 256;
export const DRIVER_WIRE_STEER_ATTACHMENTS_MAX = 64;
export const DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN = 64;

// The request shape shared by the three no-arg reads, and the reply shape shared
// by the two verbs whose driver-side operation returns `Promise<void>`.
//
// TWO NAMES FOR ONE STRUCTURE, DELIBERATELY. Both are the empty object, and
// collapsing them into one alias would be the cheaper spelling. They sit on
// OPPOSITE sides of the wire — one is what a client may send, the other is what
// the daemon replies — and the first of them to grow a member must grow without
// dragging the other with it. A shared alias would make that growth a breaking
// edit at an unrelated call site.
//
// `.strict()` on both: an unknown key on a fixed-protocol envelope is a caller
// that believes it is talking to a different method, and answering it as though
// the extra key were absent hides the mismatch until something downstream reads
// the field that never arrived.
export type DriverReadParams = Record<string, never>;
export const DriverReadParamsSchema: z.ZodType<DriverReadParams, DriverReadParams> = z
  .object({})
  .strict();

export type DriverAckResult = Record<string, never>;
export const DriverAckResultSchema: z.ZodType<DriverAckResult, DriverAckResult> = z
  .object({})
  .strict();

// The per-flag boolean shape, DERIVED from `DRIVER_CAPABILITY_FLAGS` rather than
// hand-listed. Module-local: its only consumer is the capability schema below,
// so it fails the export hoist bar (2+ surfaces).
//
// Derivation is the point, not brevity. `DriverCapabilities.flags` is
// `Record<DriverCapabilityFlag, boolean>` precisely so a flag cannot be silently
// omitted (the structural half of I-005-2), and a hand-written literal here
// would reintroduce exactly the omission the type forbids: an eighteenth flag
// appended to the array above would typecheck everywhere and then be stripped
// off this reply at runtime, so a client would read "undeclared" for a
// capability the driver declared `true`. Building the shape from the array makes
// that drift impossible by construction.
//
// The `as` cast is load-bearing and narrow: `Object.fromEntries` is typed to
// return an index signature, and the array's `as const` is what makes the
// narrowing sound.
const DRIVER_CAPABILITY_FLAG_SHAPE: Record<DriverCapabilityFlag, z.ZodBoolean> = Object.fromEntries(
  DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, z.boolean()]),
) as Record<DriverCapabilityFlag, z.ZodBoolean>;

// `DriverCapabilities` (flags + contractVersion) as a wire schema. The type has
// shipped since T1.2 as a §1 nominal shape; this is its first schema, and it
// exists because the capability reply below crosses a wire that nominal types do
// not guard.
//
// `contractVersion` is bounded at the same 64 the event boundary uses, via this
// seam's own constant — see `DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN` above for why
// the value is duplicated rather than imported.
export const DriverCapabilitiesSchema: z.ZodType<DriverCapabilities, DriverCapabilities> = z
  .object({
    flags: z.object(DRIVER_CAPABILITY_FLAG_SHAPE).strict(),
    contractVersion: wireFreeFormString(
      DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN,
      "DriverCapabilities.contractVersion",
    ),
  })
  .strict();

// One driver's entry in the `driver.listCapabilities` reply. See the section
// header for why this is `GetCapabilitiesResult` minus `detectionSource`,
// `cliVersion`, and `tools`, and plus `driverName`.
export interface DriverCapabilityReport {
  driverName: string;
  capabilities: DriverCapabilities;
  outputSpeedLevels?: string[] | undefined;
}

export interface ListCapabilitiesResult {
  drivers: DriverCapabilityReport[];
}

// `driverName: z.string().min(1)` rather than a `wireFreeFormString` cap, on the
// in-file precedent already set for this exact field by
// `ProviderCommandBindingGroup.binding`. The value is a daemon-side registry key
// (`"claude"`, `"codex"`), not untrusted text, and it appears here on a REPLY —
// the daemon is quoting its own map key back. `.min(1)` is the honest assertion:
// an empty driver name is a composition bug, and there is nothing else about the
// value this layer knows.
//
// `outputSpeedLevels` is present iff `capabilities.flags.output_speed` is true —
// a cross-field rule the daemon's cache enforces at composition time rather than
// a schema conjunct here, because absence is also the legitimate shape for every
// driver whose flag is false, and a schema-level implication would have to be
// re-stated identically at every producer. What the schema DOES enforce is that
// when the member is present it is a bounded array of bounded tokens, so a
// renderer offered a choice set is never offered an unbounded one.
export const DriverCapabilityReportSchema: z.ZodType<
  DriverCapabilityReport,
  DriverCapabilityReport
> = z
  .object({
    driverName: z.string().min(1),
    capabilities: DriverCapabilitiesSchema,
    outputSpeedLevels: z
      .array(
        wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "DriverCapabilityReport.outputSpeedLevels"),
      )
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX)
      .optional(),
  })
  .strict();

export const ListCapabilitiesResultSchema: z.ZodType<
  ListCapabilitiesResult,
  ListCapabilitiesResult
> = z.object({ drivers: z.array(DriverCapabilityReportSchema) }).strict();

// `ProviderModel` / `ProviderMode` as wire schemas. Both types have shipped as
// §1 nominal shapes since Phase 1; T4.2 gives them their first schemas because
// T4.1's `listModels` / `listModes` replies are the first surfaces on which they
// leave the daemon.
//
// These validate a DAEMON-COMPOSED reply, so their job is to catch a
// composition bug before it reaches a renderer — an empty model id, an
// unbounded token a driver read straight off a provider catalog — and not to
// re-validate anything the provider boundary already normalized, because for
// these two shapes there is no such prior normalization: neither type appears in
// the §2 seventeen-string enumeration, so this is the FIRST bound either has
// ever carried.
export const ProviderModelSchema: z.ZodType<ProviderModel, ProviderModel> = z
  .object({
    id: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.id"),
    name: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.name"),
    capabilities: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.capabilities"))
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
    // ABSENT and EMPTY are different readings here and the schema must keep them
    // distinguishable: absence means the model exposes no effort selection at
    // all, which is the registered reading, while an empty array would assert an
    // effort axis with nothing on it — a claim no provider surface makes. So
    // `.optional()` with no `.default([])`; a default would erase the
    // distinction at the parse that is supposed to preserve it.
    effortLevels: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.effortLevels"))
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX)
      .optional(),
  })
  .strict();

export const ProviderModeSchema: z.ZodType<ProviderMode, ProviderMode> = z
  .object({
    id: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderMode.id"),
    name: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderMode.name"),
  })
  .strict();

export interface DriverModelReport {
  driverName: string;
  models: ProviderModel[];
}

export interface ListModelsResult {
  drivers: DriverModelReport[];
}

export const DriverModelReportSchema: z.ZodType<DriverModelReport, DriverModelReport> = z
  .object({
    driverName: z.string().min(1),
    models: z.array(ProviderModelSchema).max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
  })
  .strict();

export const ListModelsResultSchema: z.ZodType<ListModelsResult, ListModelsResult> = z
  .object({ drivers: z.array(DriverModelReportSchema) })
  .strict();

export interface DriverModeReport {
  driverName: string;
  modes: ProviderMode[];
}

export interface ListModesResult {
  drivers: DriverModeReport[];
}

export const DriverModeReportSchema: z.ZodType<DriverModeReport, DriverModeReport> = z
  .object({
    driverName: z.string().min(1),
    modes: z.array(ProviderModeSchema).max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
  })
  .strict();

export const ListModesResultSchema: z.ZodType<ListModesResult, ListModesResult> = z
  .object({ drivers: z.array(DriverModeReportSchema) })
  .strict();

// `driver.interruptRun` — the first consumer of `RunIdSchema`, which is why that
// validator homes in this file (see the brand at the top).
//
// The wire shape is the DRIVER PARAM shape, not a session-addressed envelope. A
// run id is globally unique, so a `sessionId` beside it would be a second
// addressing key the daemon would have to reconcile against the first — and
// disagreement between them has no honest answer. T4.9's two console-parity
// verbs are the deliberate contrast: those ARE session-addressed, because their
// targets (a binding, an agent) are only identified within a session.
export const InterruptRunParamsSchema: z.ZodType<InterruptRunParams, InterruptRunParams> = z
  .object({
    runId: RunIdSchema,
    reason: wireFreeFormString(DRIVER_WIRE_REASON_MAX_LEN, "InterruptRunParams.reason").optional(),
  })
  .strict();

// `driver.applyIntervention` — a DISCRIMINATED union on `type`, mirroring
// `ApplyInterventionParams` arm for arm.
//
// THREE ARMS, NOT FOUR, AND THE MISSING ONE IS THE POINT. `InterventionType`
// enumerates four values; `rollback` is Spec-004 content whose driver-side
// operation is the separate `rollbackTo`, with its own params and its own result
// envelope. Because this union IS the dispatch surface, a `type: "rollback"`
// request must fail PARSE here rather than reach a handler that would have to
// invent a refusal — which is what makes `z.discriminatedUnion` the right
// primitive and not merely a faster one: it refuses an unknown discriminant at
// the discriminator, before any arm's fields are considered.
//
// `clientIdempotencyKey` is a REQUESTER-generated UUID and this is the seam that
// validates it. The §1 comment on `ApplyInterventionParams` states exactly that
// division: the param shape carries no paired schema because the key "is
// validated at the client→daemon WIRE seam, a different boundary, before it ever
// reaches this shape". `z.string().uuid()` is that validation — a non-UUID key
// would land in a durable receipt as an unbounded caller-chosen string and make
// replay keying depend on client discipline.
//
// `expectedRunVersion` is optimistic-concurrency state, so `.int()` and
// `.nonnegative()` are both load-bearing rather than decorative: a float or a
// negative would compare unequal to every stored version and turn a
// concurrency check into an unconditional refusal that looks like a conflict.
export const ApplyInterventionParamsSchema: z.ZodType<
  ApplyInterventionParams,
  ApplyInterventionParams
> = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("steer"),
      targetRunId: RunIdSchema,
      expectedRunVersion: z.number().int().nonnegative(),
      clientIdempotencyKey: z.string().uuid(),
      payload: z
        .object({
          content: wireFreeFormString(DRIVER_WIRE_STEER_CONTENT_MAX_LEN, "SteerPayload.content"),
          // `unknown` elements by contract, so the bound is on COUNT alone; the
          // framework layer's body-size limit is what bounds the bytes.
          attachments: z.array(z.unknown()).max(DRIVER_WIRE_STEER_ATTACHMENTS_MAX).optional(),
          expectedTurnId: wireFreeFormString(
            DRIVER_WIRE_HANDLE_MAX_LEN,
            "SteerPayload.expectedTurnId",
          ).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("interrupt"),
      targetRunId: RunIdSchema,
      expectedRunVersion: z.number().int().nonnegative(),
      clientIdempotencyKey: z.string().uuid(),
      payload: z
        .object({
          reason: wireFreeFormString(
            DRIVER_WIRE_REASON_MAX_LEN,
            "InterruptPayload.reason",
          ).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel"),
      targetRunId: RunIdSchema,
      expectedRunVersion: z.number().int().nonnegative(),
      clientIdempotencyKey: z.string().uuid(),
      payload: z
        .object({
          reason: wireFreeFormString(DRIVER_WIRE_REASON_MAX_LEN, "CancelPayload.reason").optional(),
        })
        .strict(),
    })
    .strict(),
]);

// `driver.respondToRequest` — the client's answer to a provider-raised ask.
//
// `response` is `unknown` BY CONTRACT: the answer's shape is the provider's
// question's shape, and this layer neither knows nor may narrow it. What it must
// still enforce is PRESENCE, and `z.unknown()` cannot — `unknown` accepts
// `undefined`, so a request that simply omits the key parses clean and the
// daemon forwards "no answer" to a provider blocked on one. `z.custom` with an
// explicit presence predicate is what makes a missing key a refusal while
// leaving every legitimate JSON value — `null` and `false` included, both real
// answers — untouched.
export const RespondToRequestParamsSchema: z.ZodType<
  RespondToRequestParams,
  RespondToRequestParams
> = z
  .object({
    runId: RunIdSchema,
    requestId: wireFreeFormString(DRIVER_WIRE_HANDLE_MAX_LEN, "RespondToRequestParams.requestId"),
    response: z.custom<unknown>((value) => value !== undefined, {
      message: "response is required (a missing answer is not an answer)",
    }),
  })
  .strict();

// `driver.subscribeEvents` — Plan-005 §Phase 4 decision #4.
//
// Run-scoped: a subscription is opened against one run's driver event stream,
// so the request carries the run id and nothing else.
//
// THE RESPONSE IS THE SHARED ACK, NOT A DRIVER-SPECIFIC TWIN. Every registered
// `*.subscribe` method answers with `SubscribeAckResponse` (jsonrpc-streaming.ts)
// — the opaque `subscriptionId` and nothing more, with the events themselves
// arriving as later `$/subscription/notify` frames. Declaring a
// `DriverSubscribeEventsResult` here would fork a fixed-protocol envelope that
// the SDK's inbound dispatcher keys on uniformly, so this pair deliberately has
// no response type of its own.
export interface DriverSubscribeEventsParams {
  runId: RunId;
}

export const DriverSubscribeEventsParamsSchema: z.ZodType<
  DriverSubscribeEventsParams,
  DriverSubscribeEventsParams
> = z.object({ runId: RunIdSchema }).strict();

// --------------------------------------------------------------------------
// T4.9 — the two console-parity wire requests (session-addressed)
// --------------------------------------------------------------------------
//
// BOTH REQUESTS ARE SESSION-ADDRESSED AND NEITHER CARRIES A BINDING. The
// canonical wire contract publishes no `bindingId` anywhere on the client
// surface: a binding is daemon-internal state, and a request that could name
// one would hand a caller the routing key the pair-comparison doctrine exists
// to keep daemon-enforced. The `sessionId` is not redundant beside the second
// key — it is the AUTHORIZATION SCOPE both verbs mask against first (a
// non-member and an unknown session refuse byte-identically), and the run or
// agent is only resolved within it. This is the deliberate contrast the
// `InterruptRunParamsSchema` comment records against the globally-unique run
// id's single-key shape.

// The agent identifier member. `AgentId`'s canonical brand + schema home is
// Plan-016's `packages/contracts/src/orchestration.ts` (api-payload-contracts.md
// §Branded ID Types), which is UNSHIPPED at this task's landing — and minting
// the brand here instead would be exactly the second
// `z.string().uuid().brand(...)` source of truth the `RunIdSchema` doctrine at
// the top of this file forbids, plus a barrel collision on the day Plan-016
// exports the canonical symbol. So the member is typed `string` and
// UUID-shape-validated at the seam (the `clientIdempotencyKey` precedent: an
// unbranded caller-supplied UUID, validated where it crosses). `string` is
// assignable FROM the future branded `AgentId` at every call site, so the
// one-line narrowing of this member and its validator is owed to — and lands
// compatibly with — the swap that ships orchestration.ts.

// `driver.compactContext` — the participant-triggered compaction request.
//
// Run-addressed WITHIN the session: compaction drives one run's live binding,
// and the daemon resolves that binding itself (refusing `run.not_found` /
// `driver.unavailable` in the canonical fixed order). The reply is the §1
// `DriverCompactionResult` union, never a bare acknowledgment — `refused` and
// `failed` are DATA a caller branches on, because the daemon-side adjudication
// (`not_permitted`) settles on the operation's own result rather than as a
// JSON-RPC error.
export interface CompactContextRequest {
  sessionId: SessionId;
  runId: RunId;
}

export const CompactContextRequestSchema: z.ZodType<CompactContextRequest, CompactContextRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
    })
    .strict();

// `driver.listProviderCommands` — the command-surface enumeration request.
//
// Agent-addressed WITHIN the session: an agent can hold several live bindings
// at once, and the daemon-side fan-out across them is what the reply's group
// list exists to carry. `.strict()` is what makes "the wire admits NO binding
// member" a refusal rather than a convention.
export interface ListProviderCommandsRequest {
  sessionId: SessionId;
  agentId: string;
}

export const ListProviderCommandsRequestSchema: z.ZodType<
  ListProviderCommandsRequest,
  ListProviderCommandsRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    agentId: z.string().uuid(),
  })
  .strict();

// The reply-side schemas for the group list. The §1 types ship above with the
// full provenance doctrine; these give them their first schemas because T4.9's
// reply is the first surface on which they leave the daemon, and the registry's
// I-007-7 result validation is the reader. Like the roster reply schemas, they
// guard a DAEMON-COMPOSED reply — the job is catching a composition bug (a
// dropped `runId` key, an unbounded merge) before it reaches a renderer.
//
// The binding pair is INLINED here as it is on `ProviderCommandEntrySchema`
// rather than hoisted into a shared schema: the §1 types already inline the
// pair twice by design (the entry carries its own routing key so a consumer
// cannot lose it by filtering a held list), and the account arm's full
// `null`-doctrine lives on that schema's own comment — one home, cross-referenced
// rather than restated.
export const ProviderCommandBindingGroupSchema: z.ZodType<
  ProviderCommandBindingGroup,
  ProviderCommandBindingGroup
> = z
  .object({
    // `.nullable()` and NOT `.optional()`: the zero-live-runs and two-plus-
    // live-runs arms both answer `null`, and an ABSENT key would be
    // indistinguishable from a producer that forgot to attribute the group —
    // the exact ambiguity the §1 comment's provenance rule removes.
    runId: RunIdSchema.nullable(),
    binding: z
      .object({
        driverName: z.string().min(1),
        providerAccountId: z.string().min(1).nullable(),
      })
      .strict(),
    // Bounded at the SAME 512 the provider boundary admits per group
    // (`DRIVER_PROVIDER_COMMAND_ENTRIES_MAX`), deliberately NOT at this seam's
    // 256 catalog cap: the entries were already admitted at 512 through §2's
    // entry schema, and a smaller reply-side cap would turn a legitimate
    // 300-command enumeration into a result-validation `-32603` after the
    // provider boundary accepted it. Truncation-with-a-marker is the §1
    // contract (`complete: false`), so the cap here only backstops a merge bug.
    entries: z.array(ProviderCommandEntrySchema).max(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX),
    complete: z.boolean(),
  })
  .strict();

// `.min(1)`: a success reply is NEVER the empty group list. The handler refuses
// an agent holding no live binding as `driver.unavailable` before any dispatch,
// so zero groups on a resolved reply is a composition bug and parses as one.
// The group COUNT is deliberately uncapped, mirroring the uncapped `drivers`
// arrays on the three roster replies: it is the daemon's own fan-out over the
// agent's live bindings — bounded by run admission, not by anything a caller
// sends — and a cap here would refuse an honest reply while defending against
// nothing a caller controls.
export const ProviderCommandListResultSchema: z.ZodType<
  ProviderCommandListResult,
  ProviderCommandListResult
> = z
  .object({
    bindings: z.array(ProviderCommandBindingGroupSchema).min(1),
  })
  .strict();
