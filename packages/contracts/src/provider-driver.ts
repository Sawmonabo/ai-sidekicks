// The provider-driver shapes a client or another contract reads: run and artifact ids, the
// interrupt and intervention params, models and modes, capability flags, tool metadata, execution
// posture, callback-tool declarations and MCP server status. The driver interface and the shapes
// only the daemon reads are in the daemon.
//
// Trust boundaries decide which shapes are Zod schemas and which are plain TypeScript:
//   - The capability, model and mode returns are built by the driver, which normalizes provider
//     output at its own boundary; this layer does not re-parse them. The persisted
//     `contractVersion` is bounded where it is written.
//   - Schemas guard what parses untrusted provider output: the intervention result, the tool
//     metadata, and in `provider-driver-transcript.ts` the provider command entry and output-speed
//     state. All but the tool metadata are `.strict()` (an unknown key is a protocol or driver
//     bug); tool metadata strips unknown keys because providers extend it.
//   - The client-facing SDK-seam schemas (`RunIdSchema`, and in `provider-driver-wire.ts`
//     `InterruptRunParamsSchema` and the list replies) guard client-to-daemon input, a different
//     boundary with its own length caps.

import { z } from "zod";
import { brandedUuidIdSchema } from "./internal/branded.js";
import { wireFreeFormString } from "./session.js";

// ---- Branded ID ----

/** Branded run identifier: a plain UUID string at runtime. */
export type RunId = string & { readonly __brand: "RunId" };

/**
 * Validates a caller-supplied run id; the only place a string becomes a `RunId`. Declared here,
 * the lowest-level consumer, so higher-tier modules import it instead of declaring a second brand.
 * Rejecting non-UUID shapes keeps a path or SQL fragment out of a store lookup. The
 * `ZodType<RunId, RunId>` annotation lets it compose into request objects under
 * `exactOptionalPropertyTypes`.
 */
export const RunIdSchema: z.ZodType<RunId, RunId> = brandedUuidIdSchema<RunId>("RunId");

/**
 * Identifier of an artifact manifest and the element type of every turn-scoped attachment list.
 * A daemon-minted RFC 9562 UUID (any form is accepted, so a control-plane `gen_random_uuid()` v4
 * parses); it names the manifest, never its content, which carries a separate SHA-256 `digest`.
 */
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
/** Validates a caller-supplied artifact id; declared beside `RunIdSchema` for the same reason. */
export const ArtifactIdSchema: z.ZodType<ArtifactId, ArtifactId> =
  brandedUuidIdSchema<ArtifactId>("ArtifactId");

// ---- Method parameters and returns ----

/** Asks a driver to interrupt one run, with an optional reason. */
export interface InterruptRunParams {
  runId: RunId;
  // `| undefined` keeps this aligned with `InterruptRunParamsSchema`, whose `.optional()` infers
  // `string | undefined`.
  reason?: string | undefined;
}

/** One selectable model of one provider, normalized at the driver's boundary (`listModels`). */
export interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
  // The model's reasoning-effort vocabulary, carried per model because levels differ between
  // providers and between models of one provider. A `string[]`, not a closed union, so a level the
  // installed build offers is never refused. Absent means the model has no effort axis.
  effortLevels?: string[] | undefined;
  // Whether the model has a fast output mode, as its provider reports it (Claude Code's
  // `supportsFastMode`, Codex's non-empty service-tier list). Required so a missing reading never
  // looks like "no fast mode".
  fast: boolean;
  // The window in tokens as the provider reports it. Absent until a reading arrives; nothing fills
  // it from a table or a default.
  contextWindow?: number | undefined;
}

/** One selectable mode of one provider, normalized at the driver's boundary (`listModes`). */
export interface ProviderMode {
  id: string;
  name: string;
}

// ---- Capabilities ----

/**
 * Driver capability flags in canonical order: the CHECK list on
 * `driver_capabilities.capability_flag` and every total `Record<DriverCapabilityFlag, boolean>`
 * follow the same order, so a new flag changes all of them together. The daemon's writer enforces
 * exactly this many rows per driver. `pause` is deliberately absent: it is an orchestration
 * request (`RunPauseRequest` in `run-control.ts`), not a capability a driver can advertise.
 */
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
  // Forks the bound conversation into a new provider conversation through `forkConversation`,
  // leaving the source untouched; never an undo.
  "session_fork",
  "session_goals",
  "callback_tools",
  "subagents",
  // User-triggered compaction of the bound session's provider-side context via `compactContext`.
  // Native on Codex; emulated on Claude through the one tripwire-exempt `driver_command` frame.
  "context_compaction",
  // A live read of the provider's slash-command and skill enumeration via `listProviderCommands`,
  // held as driver-session state, so the flag adds no table or column.
  "provider_commands",
  // A user-settable provider-side accelerated-output mode. Single-provider by construction: only
  // one pinned CLI declares such a state. The other has no statically declarable level vocabulary
  // and no declared-state read, so its `false` is a complete declaration, not an unprobed gap; its
  // wire takes a per-turn service-tier parameter, which makes the axis undeclarable there.
  "output_speed",
] as const;

/** The name of one driver capability flag. */
export type DriverCapabilityFlag = (typeof DRIVER_CAPABILITY_FLAGS)[number];

/**
 * A driver's capability flag matrix and contract semver. Driver-normalized, so the contract layer
 * does not re-parse it; `contractVersion` is bounded (semver, length) where it is persisted to
 * `driver_contract_meta.contract_version`.
 */
export interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
}

// ---- Tool metadata and idempotency ----

/** How a tool call may be retried or undone: repeated, compensated, or reconciled by hand. */
export type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

// Length caps on provider output, applied through `wireFreeFormString`, which rejects empty,
// whitespace-only, NUL and over-max values and never truncates. The framework layer bounds body
// size; these are a second line of defense against unbounded provider output reaching
// `driver_tools` and `runtime_bindings`.

/**
 * Max length of a tool name, shared by `ProviderToolMetadata.name` and
 * `CallbackToolInvocation.toolName` so a name that resolves against a declaration always fits.
 */
export const DRIVER_TOOL_NAME_MAX_LEN = 128;
/**
 * Max length of a tool description; generous because MCP-style descriptions can embed
 * parameter-schema docs beyond 8 KiB and an overlong value is rejected, not truncated.
 */
export const DRIVER_TOOL_DESCRIPTION_MAX_LEN = 16384;
/** Max length of `fallbackAction` on `DriverInterventionResult` and `ForkConversationResult`. */
export const DRIVER_FALLBACK_ACTION_MAX_LEN = 128;
/** Max length of the store-minted `bindingId` on the resume and fork results. */
export const DRIVER_BINDING_ID_MAX_LEN = 256;
/**
 * Max length of a resume `providerFailureDetail`; generous because it may wrap an upstream stack
 * trace or nested-cause chain, and a rejection would lose that signal.
 */
export const DRIVER_FAILURE_DETAIL_MAX_LEN = 32768;
/** Max length of `McpServerStatusEmission.serverName`. */
export const DRIVER_MCP_SERVER_NAME_MAX_LEN = 128;
/** Max length of `ProviderCommandEntry.name`. */
export const DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN = 128;
/**
 * Max length of `ProviderCommandEntry.description`; generous because a skill's front matter
 * routinely carries usage prose, and an overlong value drops the whole entry.
 */
export const DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN = 16384;
/**
 * Max length of a short provider-declared vocabulary token carried verbatim
 * (`ProviderCommandEntry.scope`, `ProviderOutputSpeedState.declared`).
 */
export const DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN = 128;
/** Max length of `ProviderOutputSpeedState.reason`; a rejection loses only the explanation. */
export const DRIVER_OUTPUT_SPEED_REASON_MAX_LEN = 512;

/**
 * Max entries in one provider-command enumeration. The enumeration is provider- and skill-authored
 * and travels to a client, so an unbounded one means an arbitrarily large IPC response and render
 * load. Sized above the Claude 2.1.251 handshake (119 slash-commands, 58 skills, 2 terminal-only
 * commands). Truncation is never silent (the group carries `complete: false`) and bounds only the
 * wire and render: the driver's held enumeration is uncapped, so truncation never causes a
 * `command_absent` refusal for a command the provider publishes.
 */
export const DRIVER_PROVIDER_COMMAND_ENTRIES_MAX = 512;

/**
 * Validates an {@link IdempotencyClass}. Declared before `ProviderToolMetadataSchema` because
 * `const` does not hoist. The double-`T` annotation pins the input slot: the single-parameter form
 * defaults it to `unknown`, which fails to match the hand-written ingress type once composed
 * through `.optional().default(...)` under `exactOptionalPropertyTypes` (TS2375).
 */
export const IdempotencyClassSchema: z.ZodType<IdempotencyClass, IdempotencyClass> = z.enum([
  "idempotent",
  "compensable",
  "manual_reconcile_only",
]);

/**
 * Ingress shape of a tool a driver declares via `getCapabilities()`. `idempotency_class` is
 * optional: an undeclared class is not a contract violation.
 */
export interface ProviderToolMetadata {
  name: string;
  idempotency_class?: IdempotencyClass | undefined;
  description?: string | undefined;
}

/**
 * Daemon-side tool shape after the `manual_reconcile_only` default is applied. Its required
 * `idempotency_class` keeps an un-normalized value out of the NOT NULL
 * `driver_tools.idempotency_class` column; only this shape crosses the persistence boundary.
 */
export interface NormalizedProviderToolMetadata {
  name: string;
  idempotency_class: IdempotencyClass;
  description?: string | undefined;
}

/**
 * Validates and normalizes a declared tool: an omitted `idempotency_class` becomes
 * `manual_reconcile_only`, and unknown keys are stripped, not rejected, because the declaration
 * surface is extensible (tolerant reader). This contrasts with the `.strict()` result envelopes,
 * which are fixed-protocol shapes. The two interfaces are hand-written because deriving them from
 * the schema would be circular against the required annotation (Output first, Input second).
 */
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

// ---- Interventions ----

/**
 * How a caller acts on a live run: steer, interrupt, cancel, or retry on a faster model. A driver
 * applies the first three (`ApplyInterventionParams`); the daemon carries out `faster_model_retry`
 * by stopping the turn and sending its message again on the named model.
 */
export type InterventionType = "steer" | "interrupt" | "cancel" | "faster_model_retry";
/** Validates an {@link InterventionType}; the one runtime spelling of its values. */
export const InterventionTypeSchema: z.ZodType<InterventionType, InterventionType> = z.enum([
  "steer",
  "interrupt",
  "cancel",
  "faster_model_retry",
]);

/**
 * A daemon-constructed intervention, discriminated on `type` so each type is coupled to its payload
 * and a mismatched or empty payload is unrepresentable. Every arm repeats two mandatory members,
 * non-optional so an absence is a type error: `expectedRunVersion`, the fail-closed comparand, and
 * `clientIdempotencyKey`, the requester-generated UUID the daemon dedupes on (the `interventions`
 * UNIQUE guard), which turns at-least-once delivery into exactly-once application. The key reaches
 * the wire unchanged and is never re-minted at the driver boundary, since a fresh key per retry
 * would defeat the dedupe. No Zod schema: the key is validated at the client-to-daemon seam.
 */
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

/** Payload of a `steer` intervention: the message content, its attachments and a target turn. */
export interface SteerPayload {
  content: string;
  // Order-preserving: an attachment's position in equals its position out, and an element the turn
  // cannot resolve at delivery surfaces as a cause-bearing unresolved marker in its own position,
  // never dropped (a silently shortened list makes the recipient reason about a message that was
  // never sent).
  //
  // No count of the app's own bounds the list: how many files a message carries is what the
  // daemon and the provider accept.
  //
  // No daemon seam resolves an `ArtifactId` to bytes yet, so the IPC ingress
  // (`runtime-daemon/src/ipc/handlers/driver-handlers.ts`, `refuseAttachmentDeliveryUnsupported`)
  // refuses a non-empty list on a steer whole with `driver.capability_unsupported`, before any
  // driver method runs. The type stays wide: the carrier contract is correct and the refusal lifts
  // with a code change alone.
  attachments?: ArtifactId[] | undefined;
  expectedTurnId?: string | undefined;
}

/** Payload of an `interrupt` intervention. */
export interface InterruptPayload {
  reason?: string | undefined;
}

/** Payload of a `cancel` intervention. */
export interface CancelPayload {
  reason?: string | undefined;
}

/**
 * Return of `ProviderDriver.applyIntervention()`. `fallbackAction` hints the fallback for a
 * `degraded` result (e.g. `queue_and_interrupt` for a steer) and is absent when `applied`. A flat
 * object, not a `status`-discriminated union like `DriverResumeResult`, because its two statuses
 * differ by one optional field.
 */
export interface DriverInterventionResult {
  status: "applied" | "degraded";
  fallbackAction?: string | undefined;
  // Set when a driver-boundary text neutralization failure is already classified as this result
  // resolves. It rides the result rather than a JSON-RPC error because a refused intervention is
  // data. Best-effort: the driver does not hold the call open for the provider turn to settle, so
  // the member is absent when settlement lands later; the run's own `run.failed` terminal is the
  // guarantee. Closed to one literal on purpose: a second code needs its own registration.
  refusalCode?: "driver.text_neutralization_failed" | undefined;
}
/**
 * Validates a {@link DriverInterventionResult} parsed from untrusted provider output. Strict, and
 * non-transforming, so the double-`T` annotation applies.
 */
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
    // A closed literal, not `wireFreeFormString`: this carries a code the daemon minted, so the
    // schema admits exactly that code, and consumers key on its identity.
    refusalCode: z.literal("driver.text_neutralization_failed").optional(),
  })
  .strict()
  // Cross-field: the refusal code classifies the user's text as swallowed, which `applied` denies.
  // A version-skewed driver reporting the pair fails parse here rather than hand out a result
  // whose two readers disagree. (`.superRefine()` returns `this`, so the annotation above holds.)
  .superRefine((result, ctx) => {
    if (result.status === "applied" && result.refusalCode !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["refusalCode"],
        message:
          "refusalCode classifies the user text as swallowed, which status 'applied' denies; the code is expressible only on a degraded result.",
      });
    }
  });

// ---- Execution posture ----

/**
 * The network half of an {@link ExecutionPosture}. `allowedDomains` exists only under
 * `networkAccess: "allowed-domains"` and is non-empty by construction there, so an allow-list mode
 * with an empty or absent list, which would read as fail-open, is unrepresentable. The `?: never`
 * members do not take the package's `?: T | undefined` idiom: `?: never` makes a member
 * structurally absent, while `?: never | undefined` collapses to a merely nullable field.
 */
export type ExecutionPostureNetwork =
  | { networkAccess: "none" | "full"; allowedDomains?: never }
  | { networkAccess: "allowed-domains"; allowedDomains: [string, ...string[]] };

/**
 * The sandbox and permission surface of a spawn or turn, daemon-constructed, carried by
 * `CreateSessionParams` and `StartRunParams` and stamped on `run.running` for audit.
 * `credentialPolicyRef` is required on both sandboxed modes and absent under `mode: "trusted"`,
 * which records no enforced credential constraint. It is a plain reference to the credential deny
 * list the run kept, so the posture names which credentials were denied without embedding a list
 * that reveals the installation.
 */
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

// ---- Callback tools ----

/**
 * A daemon-curated, daemon-trusted tool offered to the model (never provider output), so it stays
 * plain TypeScript. It mirrors the function-form provider tool shape (name, description, JSON
 * Schema input); Claude hosts the registry as a daemon-hosted ephemeral MCP server. Every
 * invocation flows through the daemon's approval pipeline and lands as an ordinary `tool_activity`
 * row.
 */
export interface SessionCallbackTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---- MCP server status ----

/** Connection state of one MCP server. Servers only: support is not visibility of its tools. */
export type McpServerStatus = "unknown" | "starting" | "connected" | "needs-auth" | "failed";
