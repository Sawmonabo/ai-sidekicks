// The provider-driver shapes a client or another contract reads: run and artifact ids, the
// interrupt and intervention params, models and modes, capability flags, tool metadata, execution
// posture, callback-tool declarations and MCP server status. The driver interface and the shapes
// only the daemon reads are in the daemon.
//
// A shape is a Zod schema only where it parses untrusted provider output (the intervention result
// and the tool metadata); the driver already normalized the capability, model and mode returns.

import { z } from "zod";
import { brandedUuidIdSchema } from "../../internal/branded.js";
import { wireFreeFormString } from "../../session/session.js";
import type { PermissionLevel } from "../../session/controls/methods.js";

// ---- Branded ID ----

/** Branded run identifier: a plain UUID string at runtime. */
export type RunId = string & { readonly __brand: "RunId" };

/**
 * Validates a caller-supplied run id; the only place a string becomes a `RunId`. A non-UUID is
 * refused, so a path or SQL fragment never reaches a store lookup.
 */
export const RunIdSchema: z.ZodType<RunId, RunId> = brandedUuidIdSchema<RunId>("RunId");

/**
 * Identifier of an artifact manifest and the element type of every attachment list. It names the
 * manifest, never its content, which carries a separate SHA-256 `digest`.
 */
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
/** Validates a caller-supplied artifact id. */
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
  // The model's output-speed vocabulary where its provider publishes one per model (Codex's
  // service-tier ids), carried verbatim. Absent means the model exposes no speed selection; a
  // provider that publishes no per-model set has its set on the capability report instead.
  outputSpeedLevels?: string[] | undefined;
  // Whether the model has a fast output mode, as its provider reports it (Claude Code's
  // `supportsFastMode`, the Codex tier its catalog names `Fast`). Required so a missing reading
  // never looks like "no fast mode".
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
 * Driver capability flags in canonical order; the database CHECK list and every total
 * `Record<DriverCapabilityFlag, boolean>` follow it, and the daemon stores one row per flag.
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
  // A faster-output mode the person can set and the provider declares a state for; `false` on a
  // provider that takes speed per turn and declares no state.
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

/**
 * A tool's declared idempotency: safe to repeat, undoable, or needing a person to reconcile.
 * Shown per tool on Settings › MCP servers; a daemon restart runs no call again, whatever its
 * class.
 */
export type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

// Length caps on provider output, applied through `wireFreeFormString`, which refuses an over-max
// value and never truncates; they keep unbounded provider output out of the daemon's tables.

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
 * Max entries in one provider-command list sent to a client. Truncation is never silent (the list
 * carries `complete: false`) and bounds only the wire: the driver's own list is uncapped, so a
 * command the provider publishes is never refused as absent.
 */
export const DRIVER_PROVIDER_COMMAND_ENTRIES_MAX = 512;

/**
 * Validates an {@link IdempotencyClass}. Typed double-`T` so its input stays the class, not
 * `unknown`, when `ProviderToolMetadataSchema` composes it with a default.
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
 * `manual_reconcile_only`, and unknown keys are stripped, not refused, because providers extend
 * the declaration.
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
 * A daemon-constructed intervention, one arm per type with its own payload. `expectedRunVersion`
 * is the fail-closed comparand; `clientIdempotencyKey` is the requester's key the daemon dedupes
 * on, passed through unchanged, because a key minted per retry would defeat the dedupe.
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
  // Order-preserving: an attachment the turn cannot resolve becomes an unresolved marker with its
  // cause in its own position, never dropped. No count of the app's own bounds the list.
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
 * Return of `ProviderDriver.applyIntervention()`. `fallbackAction` names the fallback for a
 * `degraded` result (e.g. `queue_and_interrupt` for a steer) and is absent when `applied`.
 */
export interface DriverInterventionResult {
  status: "applied" | "degraded";
  fallbackAction?: string | undefined;
  // Set when the driver refused the text before it reached the provider and knew so before
  // answering; otherwise the run's own `run.failed` carries the refusal.
  refusalCode?: "driver.text_neutralization_failed" | undefined;
}
/** Validates a {@link DriverInterventionResult} parsed from untrusted provider output. */
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
    refusalCode: z.literal("driver.text_neutralization_failed").optional(),
  })
  .strict()
  // The refusal code says the person's text never reached the provider, which `applied` denies.
  .superRefine((result, context) => {
    if (result.status === "applied" && result.refusalCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["refusalCode"],
        message:
          "refusalCode classifies the user text as swallowed, which status " +
          "'applied' denies; the code is expressible only on a degraded result.",
      });
    }
  });

// ---- Execution posture ----

/**
 * The sandbox and permissions a spawn or turn runs under, stamped on `run.running`. `mode` is the
 * session's permission level, which each driver resolves into its own provider's modes.
 * `credentialPolicyRef` names the credential deny list handed to the provider on every level; it
 * is a reference, so the list itself is never embedded.
 */
export type ExecutionPosture = {
  mode: PermissionLevel;
  writableRoots: string[];
  credentialPolicyRef: string;
};

// ---- Callback tools ----

/**
 * A tool the daemon offers the model: a name, a description and a JSON Schema input. Every call
 * goes through the daemon's approval pipeline and lands as an ordinary `tool_activity` row.
 */
export interface SessionCallbackTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---- MCP server status ----

/**
 * The five server statuses, most severe first: the daemon's order for folding a server's sessions
 * into one status, so lost observability (`unknown`) outranks a known-healthy state. A client draws
 * the folded status and never applies the order itself.
 */
export const MCP_SERVER_STATUS_SEVERITY_ORDER = [
  "failed",
  "needs-auth",
  "unknown",
  "starting",
  "connected",
] as const;
/** Connection state of one MCP server. Servers only: support is not visibility of its tools. */
export type McpServerStatus = (typeof MCP_SERVER_STATUS_SEVERITY_ORDER)[number];
