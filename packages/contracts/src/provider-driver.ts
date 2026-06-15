// Internal provider-driver contract — the normalized surface every provider
// integration (Codex, Claude, …) implements so the session engine never sees
// provider-native types. Exact field set mirrors the canonical TypeScript
// shapes in docs/architecture/contracts/api-payload-contracts.md § Plan-005 —
// Provider Driver Contract (verbatim — adding/removing/renaming a field here is
// a contract break and requires the spec edit first).
//
// Trust-boundary asymmetry — why some surfaces are nominal TS and others are Zod:
//   1. NOMINAL TypeScript (no runtime validation): the `ProviderDriver` methods,
//      all param types (`CreateSessionParams` … `ApplyInterventionParams` + the
//      intervention payloads), and the capability flags (`DriverCapabilityFlag`,
//      `DriverCapabilities`, `GetCapabilitiesResult`). These are daemon-internal
//      and daemon-CONSTRUCTED — the caller is the trusted runtime, so there is
//      nothing untrusted to parse.
//   2. ZOD-VALIDATED HERE in Phase 1: the driver RESULT envelopes
//      (`DriverInterventionResultSchema`, `DriverResumeResultSchema`) and the
//      provider-DECLARED tool metadata (`ProviderToolMetadataSchema`). These
//      parse UNTRUSTED provider output — the trust boundary — so they need
//      runtime validation. `ProviderToolMetadataSchema` additionally carries the
//      parse-time `idempotency_class` → `manual_reconcile_only` normalization
//      that only a schema's `.default()` provides (I-005-3).
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
// Refs: Spec-005:41 (normalized contract), Spec-005:43 (10-op surface),
// Spec-005:44 (intervention surface), Spec-005:49 (tool-metadata ingress),
// Spec-005:60 (resume-failure surfacing), Spec-005:67 (Required driver
// operations anchor), Plan-005 Phase 1, ADR-011 (capability flags),
// CP-005-6 (RunId co-location).

import { z } from "zod";

import type { SessionId, ChannelId } from "./session.js";

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
// ProviderDriver — the 10-operation normalized contract (Spec-005:67)
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
// T1.2 — Capability flags (Spec-005:46, :48; verifies I-005-2)
// --------------------------------------------------------------------------
//
// Nominal TypeScript — NO Zod. The capability surface is daemon-internal and
// daemon-constructed (the driver returns it; the daemon trusts it within the
// process boundary), so there is no untrusted input to runtime-validate here.
//
// `pause` is intentionally EXCLUDED from the flag union per ADR-011: pause is
// modeled as an intervention (`InterventionType`), not a static capability, so
// a driver cannot advertise a `pause` capability flag at all — the type system
// makes the mis-modeling unrepresentable. This 7-flag set mirrors
// api-payload-contracts.md § Shared Enums `DriverCapabilityFlag` verbatim.
export type DriverCapabilityFlag =
  | "resume"
  | "steer"
  | "interactive_requests"
  | "mcp"
  | "tool_calls"
  | "reasoning_stream"
  | "model_mutation";

// `flags` is a `Record<DriverCapabilityFlag, boolean>` (not a partial / array),
// so every flag MUST be answered — a driver cannot silently omit a capability,
// which is the structural form of I-005-2 (capabilities are explicit, not
// inferred from absence).
export interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
}

// --------------------------------------------------------------------------
// T1.3 — Tool metadata + idempotency (Spec-005:49, :116-118, :128;
//         Spec-015:108, :120; verifies I-005-3)
// --------------------------------------------------------------------------
//
// Per-tool idempotency classification used by the daemon's two-phase
// command-receipt protocol during crash recovery (Spec-005 §Tool Metadata;
// Spec-015 §Idempotency Protocol).
export type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

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
// defeating Spec-005:128.
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
export const ProviderToolMetadataSchema: z.ZodType<
  NormalizedProviderToolMetadata,
  ProviderToolMetadata
> = z
  .object({
    name: z.string(),
    idempotency_class: IdempotencyClassSchema.optional().default("manual_reconcile_only"),
    description: z.string().optional(),
  })
  .strict();

// Return type of `ProviderDriver.getCapabilities()` — nominal TS. Spec-005:116-118
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
// T1.4 — Intervention surface (Spec-005:44, ADR-011; verifies I-005-4)
// --------------------------------------------------------------------------
//
// `InterventionType` is DEFINED here (co-located per CP-005-6): Plan-005 is its
// lowest-tier author, and Plan-004 Tier 5 imports it from this contract. Mirrors
// api-payload-contracts.md § Shared Enums line 149 verbatim.
export type InterventionType = "steer" | "interrupt" | "cancel";

// Nominal TS — daemon-constructed param. `expectedRunVersion` is the MANDATORY
// fail-closed comparand (Plan-004 D-004-2): a non-optional `number`, so an
// absent value is a type error, never a silently-applied intervention.
export interface ApplyInterventionParams {
  type: InterventionType;
  targetRunId: RunId;
  expectedRunVersion: number;
  payload: SteerPayload | InterruptPayload | CancelPayload;
}

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
// shape mirrors the ratified api-payload-contracts.md:639 envelope (Phase-4
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
    fallbackAction: z.string().optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// T1.6 — Resume result (Spec-005:60, :157; verifies I-005-5)
// --------------------------------------------------------------------------
//
// Return shape of `ProviderDriver.resumeSession()`. Zod-validated because it
// parses UNTRUSTED provider output. The discriminated union over `status` makes
// SILENT REPLACEMENT structurally inexpressible (I-005-5): the `failed` variant
// carries `recoveryCondition: "recovery-needed"` + `providerFailureDetail` and
// has NO `bindingId`, so a failed resume cannot be conflated with a successful
// one — the type system forbids returning a binding while signalling failure.
// Spec-005:60 requires resume failure to "surface `provider failure` detail and
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
    z.object({ status: z.literal("resumed"), bindingId: z.string() }).strict(),
    z
      .object({
        status: z.literal("failed"),
        recoveryCondition: z.literal("recovery-needed"),
        providerFailureDetail: z.string(),
      })
      .strict(),
  ]);
