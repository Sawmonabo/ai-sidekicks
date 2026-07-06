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
//   2. ZOD-VALIDATED HERE in Phase 1: the driver RESULT envelopes
//      (`DriverInterventionResultSchema`, `DriverResumeResultSchema`) and the
//      provider-DECLARED tool metadata (`ProviderToolMetadataSchema`). These
//      parse UNTRUSTED provider output — the trust boundary — so they need
//      runtime validation. `ProviderToolMetadataSchema` additionally carries the
//      parse-time `idempotency_class` → `manual_reconcile_only` normalization
//      that only a schema's `.default()` provides (I-005-3).
//        Within these Zod-validated surfaces there is a further asymmetry: the
//      result envelopes are `.strict()` (fixed-protocol response shapes — an
//      unknown key signals a protocol violation, so reject), while
//      `ProviderToolMetadataSchema` STRIPS unknown keys (extensible declaration
//      surface — Spec-005:64 forward-compat: "Unknown capability fields are
//      ignored (tolerant reader)"). And
//      every untrusted free-form string parsed here is length / non-whitespace /
//      NUL-bounded via the package's `wireFreeFormString` helper (session.ts),
//      not a bare `z.string()` — these defense-in-depth bounds prevent
//      persistence / log-injection hazards on values that reach `driver_tools`,
//      `runtime_bindings`, and `runtime_node.capability_*` events.
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
// Refs: Spec-005:43 (normalized contract), Spec-005:45 (10-op surface),
// Spec-005:46 (intervention surface), Spec-005:57 (tool-metadata ingress),
// Spec-005:64 (forward-compat unknown-field strip), Spec-005:69 (resume-failure
// surfacing), Spec-005:77 (Required driver operations anchor), Plan-005 Phase 1,
// ADR-011 (capability flags), CP-005-6 (RunId co-location).

import { z } from "zod";

import { wireFreeFormString, type SessionId, type ChannelId } from "./session.js";

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
// ProviderDriver — the 10-operation normalized contract (Spec-005:77)
// --------------------------------------------------------------------------
//
// The type names referenced by the signatures below (`ApplyInterventionParams`,
// `DriverInterventionResult`, `DriverResumeResult`, `GetCapabilitiesResult`) and
// their transitive dependencies
// (`DriverCapabilities` / `DriverCapabilityFlag`, `IdempotencyClass` /
// `ProviderToolMetadata`) are defined further down in this same file.
export interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  closeSession(params: CloseSessionParams): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
}

// --------------------------------------------------------------------------
// Method parameter + return shapes
// --------------------------------------------------------------------------
//
// Leaf param/return types required by the 10 signatures above. Authored here
// (not in a companion task) because the interface cannot resolve without them
// and no later Phase-1 task owns them. Fields mirror api-payload-contracts.md
// § Plan-005 verbatim.

export interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
}

export interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
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
}

export interface InterruptRunParams {
  runId: RunId;
  // `?: T | undefined` per the package idiom under `exactOptionalPropertyTypes`
  // (session.ts:252-257). Load-bearing here: T4.2 pairs `InterruptRunParamsSchema`
  // (Plan-005 line 288), whose Zod `.optional()` infers `string | undefined` — the
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
// obligation), NOT re-parsed here — Spec-005:55 (drivers persist provider-owned
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
// T1.2 — Capability flags (Spec-005:54, :56; verifies I-005-2)
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
// source the type below, the migration-0003 `capability_flag` CHECK list (a
// frozen point-in-time copy — see note), the write-seam cardinality guard
// (`assertValidCapabilityFlags`), and the T2.4 test fixtures all derive from.
// Order mirrors api-payload-contracts.md §Shared Enums `DriverCapabilityFlag`
// verbatim. `pause` is intentionally EXCLUDED per ADR-011: pause is modeled as
// an `InterventionType`, not a static capability flag, so a driver cannot
// advertise a `pause` capability at all — the type system makes the
// mis-modeling unrepresentable.
//
// Adding an 8th flag is a coordinated change: this array + a NEW migration
// (0003's CHECK is immutable history) + any downstream consumer — until then,
// an undeclared flag is invalid for this contract version.
export const DRIVER_CAPABILITY_FLAGS = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
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
// T1.3 — Tool metadata + idempotency (Spec-005:57, :160-162, :172;
//         Spec-015:112,124; verifies I-005-3)
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
// five are consumed via `wireFreeFormString` (rejects empty / whitespace-only /
// NUL / over-max) — bare `z.string()` would let unbounded provider output reach
// `driver_tools`, `runtime_bindings`, and `runtime_node.capability_*` events.
//
//   • DRIVER_TOOL_NAME_MAX_LEN (128) — tool `name` (a name/label tier token).
//   • DRIVER_TOOL_DESCRIPTION_MAX_LEN (16384) — tool `description`; prose/message
//     tier. MCP-style descriptions can embed parameter-schema docs that exceed
//     8 KiB, and the helper REJECTS on overlength (no truncation), so this is
//     sized generously to avoid dropping a legitimate verbose description while
//     still bounding pathological sizes.
//   • DRIVER_FALLBACK_ACTION_MAX_LEN (128) — intervention `fallbackAction`; a
//     short hint token (e.g. `queue_and_interrupt`).
//   • DRIVER_BINDING_ID_MAX_LEN (256) — resume `bindingId`; an opaque provider
//     session-binding handle persisted into `runtime_bindings`.
//   • DRIVER_FAILURE_DETAIL_MAX_LEN (32768) — resume `providerFailureDetail`;
//     prose/message tier failure detail. Sized generously (32 KiB) because a
//     legitimate failure detail may wrap an upstream stack trace / nested-cause
//     chain, and a reject here would LOSE the signal Spec-005:69 mandates; a
//     value still exceeding this is pathological (see the field comment below).
export const DRIVER_TOOL_NAME_MAX_LEN = 128;
export const DRIVER_TOOL_DESCRIPTION_MAX_LEN = 16384;
export const DRIVER_FALLBACK_ACTION_MAX_LEN = 128;
export const DRIVER_BINDING_ID_MAX_LEN = 256;
export const DRIVER_FAILURE_DETAIL_MAX_LEN = 32768;

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
// defeating Spec-005:172.
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
// the `z.object()` default already strips, which is exactly Spec-005:64's
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

// Return type of `ProviderDriver.getCapabilities()` — nominal TS. Spec-005:160-162
// semantically separates whole-driver capability flags from per-tool metadata;
// this wrapper keeps `DriverCapabilities` pure (flags + contractVersion only)
// while carrying both surfaces in a single round-trip. `tools` is the INGRESS
// `ProviderToolMetadata[]` (pre-normalization, as declared by the provider) —
// normalization to `NormalizedProviderToolMetadata` happens at the daemon's
// hydration seam (Plan-005 T2.4), not at this return shape.
export interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
}

// --------------------------------------------------------------------------
// T1.4 — Intervention surface (Spec-005:46, ADR-011; verifies I-005-4)
// --------------------------------------------------------------------------
//
// `InterventionType` is DEFINED here (co-located per CP-005-6): Plan-005 is its
// lowest-tier author, and Plan-004 Tier 5 imports it from this contract. Mirrors
// api-payload-contracts.md § Shared Enums line 149 verbatim.
export type InterventionType = "steer" | "interrupt" | "cancel";

// Nominal TS — daemon-constructed param. Discriminated union over `type`: each
// intervention type is structurally coupled to its payload, so `type: "steer"`
// REQUIRES a `SteerPayload` and a mismatched/empty payload is unrepresentable —
// not a silently-accepted no-op. Spec-005:46 routes interventions by type, so the
// type→payload coupling is a contract invariant, not a convenience. Every arm
// repeats `expectedRunVersion`, the MANDATORY fail-closed comparand (Plan-004
// D-004-2): a non-optional `number`, so an absent value is a type error, never a
// silently-applied intervention.
export type ApplyInterventionParams =
  | { type: "steer"; targetRunId: RunId; expectedRunVersion: number; payload: SteerPayload }
  | { type: "interrupt"; targetRunId: RunId; expectedRunVersion: number; payload: InterruptPayload }
  | { type: "cancel"; targetRunId: RunId; expectedRunVersion: number; payload: CancelPayload };

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
// shape mirrors the ratified api-payload-contracts.md:706 envelope (Phase-4
// decision #3). Non-transforming object → double-`T` annotation per
// session.ts:289-294.
export interface DriverInterventionResult {
  status: "applied" | "degraded";
  fallbackAction?: string | undefined;
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
  })
  .strict();

// --------------------------------------------------------------------------
// T1.6 — Resume result (Spec-005:69, :204; verifies I-005-5)
// --------------------------------------------------------------------------
//
// Return shape of `ProviderDriver.resumeSession()`. Zod-validated because it
// parses UNTRUSTED provider output. The discriminated union over `status` makes
// SILENT REPLACEMENT structurally inexpressible (I-005-5): the `failed` variant
// carries `recoveryCondition: "recovery-needed"` + `providerFailureDetail` and
// has NO `bindingId`, so a failed resume cannot be conflated with a successful
// one — the type system forbids returning a binding while signalling failure.
// Spec-005:69 requires resume failure to "surface `provider failure` detail and
// a visible `recovery-needed` condition; it must not silently create a
// replacement provider session under the same canonical run." Resumed-case
// timestamps live on `runtime_bindings.updated_at` (Plan-005 T2.1); this shape
// carries only the discriminated-union semantic payload.
export type DriverResumeResult =
  | { status: "resumed"; bindingId: string }
  | {
      status: "failed";
      recoveryCondition: "recovery-needed";
      providerFailureDetail: string;
    };
export const DriverResumeResultSchema: z.ZodType<DriverResumeResult, DriverResumeResult> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("resumed"),
        // `bindingId` is a machine-generated OPAQUE provider session-binding
        // handle (Spec-005:55, :102) — the same category as the `invites.ts`
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
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        recoveryCondition: z.literal("recovery-needed"),
        // The cap is generous (`DRIVER_FAILURE_DETAIL_MAX_LEN = 32768`) so a
        // legitimate verbose detail (wrapped upstream stack trace / nested-cause
        // chain) is not suppressed — Spec-005:69 MANDATES this detail surface. A
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
