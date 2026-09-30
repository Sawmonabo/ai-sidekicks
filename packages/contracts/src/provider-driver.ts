// The normalized surface every provider driver (Codex, Claude) implements, so the session engine
// never sees provider-native types.
//
// Trust boundaries decide which shapes are Zod schemas and which are plain TypeScript:
//   - The `ProviderDriver` params are built by the daemon in-process, so they are plain types.
//   - The capability, handle, model and mode returns are built by the driver, which normalizes
//     provider output at its own boundary; this layer does not re-parse them. The persisted
//     `contractVersion` and `resumeHandle` are bounded where they are written.
//   - Schemas guard what parses untrusted provider output: the result envelopes, the tool metadata
//     and the driver-normalized seam shapes (callback-tool invocation, MCP server status, provider
//     command entry, output-speed state). Envelopes and seam shapes are `.strict()` (an unknown key
//     is a protocol or driver bug); tool metadata strips unknown keys because providers extend it.
//   - The client-facing SDK-seam schemas (`RunIdSchema`, `InterruptRunParamsSchema`, the list
//     replies) guard client-to-daemon input, a different boundary with its own length caps.
//
// The contract carries no remote-authority handle or control-plane dispatch shape, so a driver may
// call a remote provider API behind these methods while execution authority stays with the local
// runtime.

import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import type { MethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { wireFreeFormString, SessionIdSchema, type SessionId } from "./session.js";

// ---- Branded ID ----

/** Branded run identifier: a plain UUID string at runtime. */
export type RunId = string & { readonly __brand: "RunId" };

/**
 * Validates a caller-supplied run id; the only place a string becomes a `RunId`. Declared here,
 * the lowest-level consumer, so higher-tier modules import it instead of declaring a second brand.
 * Rejecting non-UUID shapes keeps a path or SQL fragment out of a store lookup. The
 * `ZodType<RunId, RunId>` annotation lets it compose into the request objects below under
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

// ---- ProviderDriver ----

/**
 * The normalized operations every provider driver implements for the daemon. The daemon-injected
 * callbacks (`onCallbackToolCall`, `onMcpServerStatus`) are `CreateSessionParams` members, not
 * operations.
 */
export interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;
  // Gated on `rollback`: an undeclared flag refuses with `driver.capability_unsupported` before
  // dispatch. `degraded` is the outcome of a driver that was invoked and reported its fallback.
  forkConversation(params: ForkConversationParams): Promise<ForkConversationResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  // Both goal operations are gated on `session_goals`, like `forkConversation`. A provider that
  // refuses the goal throws; success returns nothing.
  setSessionGoal(params: SetSessionGoalParams): Promise<void>;
  clearSessionGoal(params: ClearSessionGoalParams): Promise<void>;
  closeSession(params: CloseSessionParams): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
  // Not capability-gated and required of every driver: a zero-turn authentication probe. No flag
  // exists for it, so a driver cannot opt out by silence.
  probeAuth(): Promise<DriverAuthProbeResult>;
  // Not capability-gated and required of every driver: rendering the canonical transcript is how
  // a driver declares what it can carry and report losing. Pure: it mutates nothing and starts no
  // turn. The transcript is passed in because the daemon rebuilds it per call; a driver holding it
  // would keep a second record of the log.
  exportTranscript(params: ExportTranscriptParams): Promise<DriverTranscriptExportResult>;
  // Gated on `transcript_replay`. Reconstitutes a conversation into a fresh provider session and
  // never writes to the source session. Returns only after the post-replay assertion passes: the
  // injection surface is untyped on the wire, so a returned success alone proves nothing.
  replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult>;
  // Gated on `context_compaction`. Compacts the bound session's provider-side context on user
  // request only, settling on the provider's typed compaction evidence and never on the request
  // being accepted (Codex answers an empty ack; Claude's `driver_command` frame only settles).
  // There is no prompt-injected emulation: a driver that cannot compact declares the flag `false`.
  // The wait ends at the driver's declared per-binding bound or when the binding stops being
  // live; a compaction frame that arrives after settlement still normalizes as an unsolicited one.
  compactContext(params: CompactContextParams): Promise<DriverCompactionResult>;
  // Gated on `provider_commands`. A live read of the provider's own slash-command and skill
  // enumeration for the bound session, held as driver-session state and discarded with it (not
  // persisted or cached). Every entry carries the `(driverName, providerAccountId)` it was read
  // under; the daemon enforces the routing invariant on that pair.
  listProviderCommands(params: ListProviderCommandsParams): Promise<ProviderCommandListResult>;
}

// ---- Method parameters and returns ----

/** What the daemon hands a driver to open a session: config, spawn-bound legs and callbacks. */
export interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
  // Realizes the native-cap-escape admitted cap at spawn for providers that bind budget caps then
  // (Claude `--max-budget-usd`), so a cap-admitted leg is never launched capless.
  admittedCostCapUsdMicros?: number | undefined;
  // The legs below are spawn-bound: a leg that binds at process spawn and receives nothing here
  // launches without it. Per-run carriers are `StartRunParams`; `ResumeSessionParams` repeats
  // these because resume is a fresh spawn.
  executionPosture?: ExecutionPosture | undefined;
  // The requested accelerated-output mode. Gated on `output_speed` and validated against the
  // driver's declared `outputSpeedLevels` before spawn, so an out-of-vocabulary value refuses
  // before reaching the provider. Spawn-bound because the provider reads it at process start.
  // Requested is not granted: the provider's declared state is observed later as binding-held
  // `ProviderOutputSpeedState`, and neither value is rewritten into the other.
  outputSpeed?: string | undefined;
  // Gated on `callback_tools`. Claude hosts the registry as a daemon-hosted ephemeral MCP server
  // (`--mcp-config`), where the tools surface as `mcp__<server>__<tool>`.
  callbackTools?: SessionCallbackTool[] | undefined;
  // Gated on the `subagents` flag.
  subagentPolicy?: SubagentPolicy | undefined;
  // Gated on `structured_output`. A normalized JSON Schema constraining the final output. Claude
  // binds it per session here (`--json-schema`); Codex per turn via `StartRunParams.outputSchema`.
  outputSchema?: Record<string, unknown> | undefined;
  // The provider account this leg is admitted against; omitted, the leg spawns against the node's
  // default for that provider. Opaque to the driver, which receives an already-constructed spawn
  // environment: pinning the account's credential home into it and denying ambient credential
  // names are obligations of the spawn path, not something this member carries or a driver does.
  //
  // Server-resolved and server-stamped: a client-supplied value is an input to resolution, never
  // the recorded outcome. Spawn-bound because a run's paying account is fixed for its lifetime;
  // resume re-realizes it from the durable record instead of re-resolving the current default.
  providerAccountId?: string | undefined;
  // Daemon-injected dispatcher, gated on `callback_tools`. The driver calls it for each provider
  // callback-tool request and answers the provider with the result, so no invocation goes
  // unanswered. The daemon's host routes every call through the Cedar approval pipeline.
  onCallbackToolCall?:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  // Daemon-injected MCP server-status sink, pre-bound to this leg's identity (session id and the
  // store-minted binding id) at spawn, so a driver cannot misattribute or spoof another leg's rows
  // and needs no id it does not yet have for the init census it emits during `createSession`.
  onMcpServerStatus?: McpServerStatusProducer | undefined;
}

/**
 * What the daemon hands a driver to resume a session in a fresh process; it repeats the
 * spawn-bound legs of `CreateSessionParams`.
 */
export interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
  // Re-threads the run.queued server-stamped admitted cap so the provider-side hard stop survives
  // a daemon restart and session relaunch.
  admittedCostCapUsdMicros?: number | undefined;
  // Resume is a fresh process spawn, so every spawn-bound member of `CreateSessionParams` must be
  // re-realized here or the resumed leg silently sheds it: a posture-less resume relaunches
  // unsandboxed, a schema-less one unconstrained. The data legs are rebuilt by the daemon from the
  // durable `runtime_bindings.spawn_config` written at every spawn, never from the original client
  // request; the two function legs are re-injected at every spawn, as functions are never stored.
  executionPosture?: ExecutionPosture | undefined;
  // A speed-less resume relaunches at the provider's default while `agents.output_speed` still
  // records the operator's accepted mode. The state the relaunched process declares is observed as
  // binding-held state, not returned on `DriverResumeResult` (see `ProviderOutputSpeedState`).
  outputSpeed?: string | undefined;
  callbackTools?: SessionCallbackTool[] | undefined;
  subagentPolicy?: SubagentPolicy | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  // Read back from the durable `spawn_config` record, never re-resolved: resolving "whichever
  // account is default now" would move a live run's spend onto an account it was not admitted
  // against. Same opacity rule as on `CreateSessionParams`.
  providerAccountId?: string | undefined;
  // An omitted rebind would strand provider callback-tool requests unanswered on
  // the resumed leg.
  onCallbackToolCall?:
    | ((invocation: CallbackToolInvocation) => Promise<CallbackToolResult>)
    | undefined;
  // Re-injected census sink, pre-bound to the resumed leg's identity; the leg re-emits its init
  // census through it.
  onMcpServerStatus?: McpServerStatusProducer | undefined;
}

/** What the daemon hands a driver to start one run: its id, agent config, and per-run options. */
export interface StartRunParams {
  runId: RunId;
  agentConfig: Record<string, unknown>;
  // The run.queued server-stamped admitted family cap in whole micro-dollars, realized as the
  // provider's native hard cap on cap-capable legs (Claude `--max-budget-usd`).
  admittedCostCapUsdMicros?: number | undefined;
  // Optionals are `?: T | undefined`, not bare `?: T`, under `exactOptionalPropertyTypes`: the
  // package idiom, which keeps an interface aligned with a schema's inferred type.
  conversationHistory?: unknown[] | undefined;
  // The per-run effective posture, the same object the daemon stamps on `run.running`. Codex
  // realizes it per turn (`turn/start` sandbox params); a provider that binds posture at spawn
  // realizes it at session boundaries, and a mid-session change there resolves by session
  // relaunch, never a silent partial application.
  executionPosture?: ExecutionPosture | undefined;
  // Per-turn schema-constrained final output (Codex `turn/start.outputSchema`); Claude binds the
  // same schema at spawn via `CreateSessionParams.outputSchema`. Gated on `structured_output`.
  outputSchema?: Record<string, unknown> | undefined;
}

/** Asks a driver to interrupt one run, with an optional reason. */
export interface InterruptRunParams {
  runId: RunId;
  // `| undefined` keeps this aligned with `InterruptRunParamsSchema`, whose `.optional()` infers
  // `string | undefined`.
  reason?: string | undefined;
}

/** Answers one interactive request a driver raised on a run; `response` is provider-shaped. */
export interface RespondToRequestParams {
  runId: RunId;
  requestId: string;
  response: unknown;
}

/** Asks a driver to close one session. */
export interface CloseSessionParams {
  sessionId: SessionId;
}

/**
 * Driver-constructed return of `createSession` and `resumeSession`; both fields are opaque
 * provider-owned blobs. `resumeHandle` is bounded (non-empty, length, NUL-reject) where it is
 * persisted to `runtime_bindings.resume_handle`, not re-parsed here.
 */
export interface ProviderSessionHandle {
  providerSessionId: string;
  resumeHandle: string;
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
  "session_goals",
  "callback_tools",
  "subagents",
  "transcript_replay",
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
/**
 * Max length of `DriverAuthProbeResult.detail`, a short account or plan descriptor; a rejection
 * loses only descriptive text, never the probe `status` that carries the admission decision.
 */
export const DRIVER_AUTH_DETAIL_MAX_LEN = 512;
/** Max length of `CallbackToolInvocation.toolCallId`, an opaque provider correlation id. */
export const DRIVER_TOOL_CALL_ID_MAX_LEN = 256;
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

/**
 * The provider CLI version as the spawned process reports it in-band, never from a launcher
 * symlink that may name a different build. `semver` is required so an unparseable version is
 * unrepresentable: the driver fails the report closed and attach refuses as
 * `driver.cli_version_unparseable`; a version below the configured floor refuses as
 * `driver.cli_version_below_floor`. `raw` is bounded where it is persisted, not here.
 */
export interface DriverCliVersionReport {
  raw: string;
  semver: string;
}

/**
 * Return of `ProviderDriver.getCapabilities()`: the flag matrix, the tool declarations as the
 * provider made them (normalized at the daemon's hydration seam) and the CLI version.
 */
export interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
  // Required: a capability report without a parseable provider version never reaches the daemon.
  // It describes this reading rather than a capability, so it rides this wrapper and is not
  // mirrored onto the event-boundary `CapabilityDetails` (the version floor gates attach only).
  cliVersion: DriverCliVersionReport;
  // Present and total over the flag set on a live driver read; absent when the result was rebuilt
  // by `DriverCapabilitiesWriter.hydrate()` from the durable cache, which stores flag values and
  // not provenance. Absence means "cache reconstruction", never "unknown provenance": a consumer
  // that needs provenance re-reads the driver. Not mirrored into `CapabilityDetails` or the
  // client-facing `driver.listCapabilities` payload.
  detectionSource?: Record<DriverCapabilityFlag, CapabilityDetectionSource>;
  // The output-speed value vocabulary: present iff `capabilities.flags.output_speed` is `true`;
  // absent or empty means the axis is unsettable and a caller carrying `outputSpeed` refuses
  // rather than forwarding an unvalidated value. Declared statically from the per-driver table,
  // because reading it from the provider costs a turn-bearing request. Unlike `detectionSource`
  // it survives `hydrate()`, so the durable cache needs no column for it.
  outputSpeedLevels?: string[] | undefined;
}

/**
 * How one flag's value was arrived at on a reading: `probed` by a zero-turn probe whose negative
 * control still refused, or `static` from the driver's own table, used only where no admissible
 * probe exists. A bare union because nothing iterates it at runtime; per-driver totality is a
 * compile-time `Record` in `runtime-daemon/src/provider/capability-probe.ts`.
 */
export type CapabilityDetectionSource = "static" | "probed";

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
  // Two bounds: `DRIVER_WIRE_STEER_ATTACHMENTS_MAX` below is this seam's coarse frame-abuse
  // ceiling; the policy bound `max_attachments_per_carrier` (default 10, operator-tunable 1-50) is
  // enforced by the daemon at carrier acceptance, which refuses the whole carrier as
  // `artifact.too_many_attachments` (413) rather than truncating. A schema constant cannot read
  // operator configuration.
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

// ---- Recovery conditions ----

/**
 * Why a run needs attention: `recovery-needed` means an operator must reconcile it;
 * `reauth-required` means the provider session or credential expired (detected mid-run from the
 * provider's typed auth-failure signals, or at resume or probe time) and recovery may retry once
 * the provider CLI is re-authenticated on the runtime node. Two conditions, two operator actions.
 * One list, from which the type and schema derive: `z.ZodType` is covariant in its output, so an
 * enum narrower than the union still satisfies a `z.ZodType<RecoveryCondition>` annotation
 * (measured: widening left `tsc -b --force` clean while narrowing raised TS2375), and a second
 * hand-written list would let a new condition dead-letter at parse at a carrier not updated.
 */
export const RECOVERY_CONDITIONS = ["recovery-needed", "reauth-required"] as const;

/** One member of {@link RECOVERY_CONDITIONS}. */
export type RecoveryCondition = (typeof RECOVERY_CONDITIONS)[number];

/**
 * Validates a {@link RecoveryCondition}. Every carrier references this parser instead of restating
 * the values: the `DriverResumeResult` `failed` arm (required) and the run-state change projection
 * in `run-control.ts` (optional). Annotated `z.ZodType`, not `z.ZodEnum`, because no consumer
 * derives from the enum surface; the value set is `RECOVERY_CONDITIONS`.
 */
export const RecoveryConditionSchema: z.ZodType<RecoveryCondition, RecoveryCondition> =
  z.enum(RECOVERY_CONDITIONS);

/**
 * What the halted or diverged span contains, so policy can tier on blast radius. Orthogonal to
 * `RecoveryCondition`, which says why the run needs an operator, so it is not a widening of that
 * union. Audit metadata only: every divergence still halts for human action, and `unclassifiable`
 * must be handled exactly as `irreversible`, the fail-closed default that keeps a driver from using
 * it as a free pass. Const-array-derived because the exported parser and its carriers read it.
 */
export const RECOVERY_SPAN_CLASSIFICATIONS = [
  "read_only",
  "idempotent_write",
  "irreversible",
  "unclassifiable",
] as const;

/** One member of {@link RECOVERY_SPAN_CLASSIFICATIONS}. */
export type RecoverySpanClassification = (typeof RECOVERY_SPAN_CLASSIFICATIONS)[number];

/**
 * Validates a {@link RecoverySpanClassification}; carried by the same surfaces as
 * `RecoveryConditionSchema`. `unclassifiable` is a member rather than an absence, so a driver that
 * cannot classify the span still parses; treating it as `irreversible` is the consumer's duty,
 * which a value set cannot enforce.
 */
export const RecoverySpanClassificationSchema: z.ZodType<
  RecoverySpanClassification,
  RecoverySpanClassification
> = z.enum(RECOVERY_SPAN_CLASSIFICATIONS);

/**
 * Return of `ProviderDriver.resumeSession()`, parsed from untrusted provider output. Discriminated
 * on `status` so a failed resume cannot pose as a successful one: `failed` carries a
 * `RecoveryCondition`, a `RecoverySpanClassification` and `providerFailureDetail` and has no
 * `bindingId`, and a failed resume must never silently create a replacement provider session under
 * the same run. The `resumed` arm's required `sessionPosition` is the driver's normalized monotonic
 * position (a turn or event ordinal, as in `ForkConversationResult`); the daemon compares it with
 * its recorded position, which catches a provider answering a resume with a fresh session (e.g.
 * Claude on a working-directory mismatch). Timestamps live on `runtime_bindings.updated_at`.
 */
export type DriverResumeResult =
  | { status: "resumed"; bindingId: string; sessionPosition: number }
  | {
      status: "failed";
      recoveryCondition: RecoveryCondition;
      recoverySpanClassification: RecoverySpanClassification;
      providerFailureDetail: string;
    };
/** Validates a {@link DriverResumeResult}; both arms are `.strict()`. */
export const DriverResumeResultSchema: z.ZodType<DriverResumeResult, DriverResumeResult> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("resumed"),
        // Opaque and machine-generated, but persisted into `runtime_bindings`, so the
        // `wireFreeFormString` guards (non-blank, no NUL) defend a stored untrusted value against
        // storage and log-injection hazards. The cap is sized for a short session-binding handle.
        bindingId: wireFreeFormString(DRIVER_BINDING_ID_MAX_LEN, "DriverResumeResult.bindingId"),
        // Shape only (integer >= 0), as in `ForkConversationResultSchema`. Comparing the position
        // with the daemon's recorded one, and reconciling a mismatch, need session state this shape
        // does not carry, so they belong to the daemon.
        sessionPosition: z.number().int().min(0),
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        // References the shared parser so a new condition reaches this carrier by construction.
        recoveryCondition: RecoveryConditionSchema,
        // Required on this live return: a resume failure is produced fresh and never replayed, so
        // no older record needs it optional. A driver that cannot classify the span emits
        // `unclassifiable`, so omission is a schema failure.
        recoverySpanClassification: RecoverySpanClassificationSchema,
        // The cap is generous so a verbose detail (wrapped upstream stack trace or nested-cause
        // chain) is not suppressed. A value past it is pathological; a driver treats a result that
        // fails this schema as a provider failure and surfaces `recovery-needed`, so the signal
        // survives a parse rejection here.
        providerFailureDetail: wireFreeFormString(
          DRIVER_FAILURE_DETAIL_MAX_LEN,
          "DriverResumeResult.providerFailureDetail",
        ),
      })
      .strict(),
  ]);

// ---- Provider usage-limit signal ----

// A driver emits a usage-limit signal only when a structured provider event it can name says the
// allowance is spent. Prose, an exit code or a bare HTTP status are never inputs, since the
// provider may reword or reuse them; an unrecognized shape emits nothing, which reads "not known
// to be limited". There is no capability flag: recognition is required of every driver, like
// `probeAuth`. These types are plain TypeScript because no member is provider-verbatim: `cause`
// and `provenance` are closed literals the driver selects, and `resetsAt` is a timestamp it
// composes.

/**
 * Why a provider refused for spend, on an axis separate from `RecoveryCondition`: every recovery
 * condition needs a human, while a spent usage allowance clears when the provider's window turns
 * over. One member on purpose: only `plan-allowance-exhausted`, the subscription allowance for a
 * rolling window, clears on its own. Excluded because a human must act or the state is not a
 * refused turn: a depleted credit balance (Codex `workspace_owner_credits_depleted` and
 * `workspace_member_credits_depleted`, restored by a purchase), a payment fault (Claude
 * `billing_error`), and a spend-control ceiling (Codex `spendControlReached`, an administrative
 * budget state on a snapshot). A turn refused for any of them settles on the driver's ordinary
 * turn-failure path. Widen the union deliberately; never with a free string.
 */
export type ProviderUsageLimitCause = "plan-allowance-exhausted";

/**
 * Where a reset instant came from: `provider-stated` (the provider named it, for the window it also
 * named as spent) or `runtime-derived` (the daemon computed it from a delay the provider gave). A
 * consumer may schedule on either, but only the first is safe to show as the provider's own answer,
 * and only the second should widen when a retry lands early.
 */
export type ProviderUsageLimitResetProvenance = "provider-stated" | "runtime-derived";

/**
 * A reset instant and its provenance as one object, so an instant without provenance and a
 * provenance without an instant are both unrepresentable.
 */
export interface ProviderUsageLimitResetBoundary {
  // RFC 3339 UTC.
  resetsAt: string;
  provenance: ProviderUsageLimitResetProvenance;
}

/**
 * A recognized provider usage-limit refusal. The cause is required and the boundary optional: a
 * recognized refusal parks the run whether or not a window was reported, and a missing boundary
 * only means no resume is scheduled. Absent means no reset instant is known from what was
 * observed, not that the provider publishes none.
 */
export interface ProviderUsageLimitSignal {
  cause: ProviderUsageLimitCause;
  resetBoundary?: ProviderUsageLimitResetBoundary | undefined;
}

// ---- Conversation fork ----

/**
 * Params of `forkConversation` (gated on `rollback`): fork the provider conversation at a recorded
 * `position` (the driver's normalized monotonic session position, a turn or event ordinal) into a
 * new provider session; touches no files. `bindingId` is the leg key: a run has many bindings (a
 * capped or posture relaunch mints a new one), so `sessionId` cannot name the target leg. The
 * daemon resolves the run's live binding at dispatch; clients address the run, not the leg.
 */
export interface ForkConversationParams {
  sessionId: SessionId;
  position: number;
  bindingId: string;
}

/**
 * Return of `ProviderDriver.forkConversation()`, parsed from untrusted provider output.
 * Discriminated on `status` like `DriverResumeResult`: `sessionPosition` is required on `applied`
 * and absent from `degraded`, so a fork without a confirmed position is unrepresentable. The schema
 * bounds shape only (integer >= 0); domain checks need session state and belong to the daemon.
 * `bindingId` is the binding the fork minted (Claude `--resume-session-at` with `--fork-session`;
 * Codex `thread/fork`), a store-minted surrogate and never a resume handle.
 */
export type ForkConversationResult =
  | { status: "applied"; sessionPosition: number; bindingId?: string | undefined }
  | { status: "degraded"; fallbackAction?: string | undefined };
/** Validates a {@link ForkConversationResult}; both arms are `.strict()`. */
export const ForkConversationResultSchema: z.ZodType<
  ForkConversationResult,
  ForkConversationResult
> = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      sessionPosition: z.number().int().min(0),
      bindingId: wireFreeFormString(
        DRIVER_BINDING_ID_MAX_LEN,
        "ForkConversationResult.bindingId",
      ).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("degraded"),
      fallbackAction: wireFreeFormString(
        DRIVER_FALLBACK_ACTION_MAX_LEN,
        "ForkConversationResult.fallbackAction",
      ).optional(),
    })
    .strict(),
]);

// ---- Session goals ----

/**
 * Params of `setSessionGoal` (gated on `session_goals`). `goalText` is the daemon-rendered text of
 * the session's structured goal, so the driver never sees the structure and cannot diverge from it.
 * Durable truth is the `session.goal_updated` and `session.goal_cleared` events and the daemon
 * re-pushes the goal on resume, so driver-held state is never the recovery source and neither
 * operation returns the goal it applied. `bindingId` is the leg key, as on
 * `ForkConversationParams`: goal delivery fans out per live binding. `runId` rides along for
 * context and telemetry.
 */
export interface SetSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
  goalText: string;
}

/** Params of `clearSessionGoal` (gated on `session_goals`); addresses one live binding. */
export interface ClearSessionGoalParams {
  sessionId: SessionId;
  bindingId: string;
  runId: RunId;
}

// ---- Authentication probe ----

/**
 * Return of the zero-turn `probeAuth` (not capability-gated), parsed from untrusted provider
 * output. `indeterminate` (probe surface unavailable or unparseable) counts as not authenticated
 * for admission (fail closed) yet stays distinguishable from `unauthenticated`, so operators can
 * tell probe health from credential state; a boolean would lose that. Run admission against a
 * driver not probing `authenticated` refuses as `driver.not_authenticated` before any turn is
 * spent. Mid-run credential expiry is a different surface: typed auth-failure signals map to the
 * `reauth-required` recovery condition.
 */
export interface DriverAuthProbeResult {
  status: "authenticated" | "unauthenticated" | "indeterminate";
  // Knowingly PII-bearing: a provider-reported account or plan descriptor whose observed shape is
  // a plan name plus a seat email. Transient operator-facing diagnostics only: never persist it or
  // carry it on an event without a PII classification and the erasure that obliges. Admission
  // reads `status` for the decision and this field only to tell an operator why, so dropping it
  // loses diagnostics, never correctness.
  detail?: string | undefined;
}
/** Validates a {@link DriverAuthProbeResult}; strict. */
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

// ---- Canonical transcript export and replay ----

// The canonical transcript is a projection the daemon folds from the session event log, so its
// shapes are daemon-constructed and plain TypeScript. Content is bounded, normalized taxonomy:
// anything a provider held that never became an event is absent by construction, which is what
// the declared-loss rule surfaces.

/**
 * The closed vocabulary of what a transcript operation could not carry. A new kind is a deliberate
 * addition, never a free string. An empty list claims nothing was dropped, so a driver that does
 * not know what it lost may not emit one.
 */
export const DECLARED_LOSS_KINDS = [
  // Non-portable by both vendors' stated rules and never translated. Stripped unconditionally,
  // even on a same-provider replay where signatures would still validate: carrying them would owe
  // an exact reproduction of block order and count, whose failures surface as opaque signature
  // rejections rather than declared losses.
  "provider_private_reasoning",
  // The memo budget evicted older exchanges — whole exchanges only, never halves.
  "context_truncated",
  // An unpaired call took a synthetic error result rather than being dropped.
  "tool_call_history_repaired",
  // The memo floor: verbatim exchanges replaced by a bounded prose rendering.
  "conversation_history_summarized",
  // A logged turn's body could not be read when the fold ran, so the turn is carried with its
  // position and an empty body rather than dropped. Named because the alternatives, a turn that
  // never happened or one whose author said nothing, are both false.
  "turn_content_unavailable",
  // A logged turn's body exceeded the append-time plaintext ceiling and is stored as a
  // codepoint-boundary prefix; the fold carries the prefix and names the loss. Not
  // `context_truncated` (the memo budget evicting whole exchanges) and not
  // `turn_content_unavailable` (which would overstate a turn available as a prefix). Kept in the
  // vocabulary because the memo continuity-marker parser refuses a record carrying a token it
  // cannot place, and the unreadable-record upper bound reports this whole list.
  "turn_content_truncated",
] as const;

/** One member of {@link DECLARED_LOSS_KINDS}. */
export type DeclaredLossKind = (typeof DECLARED_LOSS_KINDS)[number];

/** Validates a {@link DeclaredLossKind}. */
export const DeclaredLossKindSchema: z.ZodType<DeclaredLossKind, DeclaredLossKind> =
  z.enum(DECLARED_LOSS_KINDS);

/** Who authored a turn. The transcript carries no third author in V1. */
export type CanonicalTranscriptRole = "user" | "assistant";

/**
 * Whether a reasoning block was ever visible to the user. The strip keys on this, not on
 * `reasoningKind`, because a filter matching one kind name would leave that kind's redacted
 * sibling behind and break the multi-turn protocol. Summaries are user-visible, hence canonical.
 */
export type CanonicalReasoningDisclosure = "private" | "summary";

/**
 * Whether a tool result came from the provider or was minted by the pairing repair. A repaired
 * result is a declared loss, and a consumer that cannot tell the two apart cannot honor that.
 */
export type CanonicalToolResultProvenance = "provider" | "repaired";

/**
 * One unit of turn content. Every arm carries `position`, the session-log sequence of the event
 * that contributed it: derived provenance projected from the log, never a second record of the
 * session's order. It is required on every arm because a bound filters on it, and an absent
 * position would exempt its segment from every bound. Steps that re-home a segment keep the value,
 * so positions within a turn ascend as the fold builds them but need not once the pairing repair
 * moves a result behind its call. A `tool_call` carries no enclosing-block member while a
 * `tool_result` does, so the strip can never drop a call yet can orphan a result, which is what the
 * pairing repair answers; hence the repair must run after the strip.
 */
export type CanonicalTranscriptSegment =
  | {
      kind: "text";
      position: number;
      text: string;
      // Set when the row's body was unavailable at fold time. `text` is then empty, because the
      // fold never invents content, and the segment is kept so the turn survives with its
      // position. Every projection carrying one owes the matching declared loss.
      contentUnavailable?: boolean | undefined;
      // Set on the stand-in emitted for an id-less tool result whose enclosing reasoning block
      // resolved `private` at turn close. The body was read and withheld, so `text` is empty and
      // `contentUnavailable` stays absent (setting it would claim a read failure that never
      // happened). It is a `text` arm rather than a `tool_result` because that arm requires
      // `toolCallId`, and a synthetic id would give the pairing repair a call no provider made. It
      // rides the segment it governs and survives any positional bound the segment survives;
      // without it, a bound between the result and its later-logged private reasoning row would
      // leave the export declaring nothing. Never rendered or exported: the strip drops the segment
      // and declares `provider_private_reasoning`. One literal because only `private` withholds a
      // read body; an `unknown` enclosure keeps its placeholder on the `contentUnavailable` path.
      withheldEnclosure?: "private" | undefined;
    }
  | {
      kind: "reasoning";
      position: number;
      blockId: string;
      // The provider's own block-kind label, carried verbatim for diagnostics; the strip keys on
      // `disclosure`, not on this.
      reasoningKind: string;
      disclosure: CanonicalReasoningDisclosure;
      text: string;
    }
  | {
      kind: "tool_call";
      position: number;
      // The canonical id: replay never re-mints one or reuses one across two calls; the
      // target-facing id comes from the identity map.
      toolCallId: string;
      toolName: string;
      // The arguments as the provider serialized them; re-encoding a parsed object would change
      // bytes the target may hash or echo.
      argumentsJson: string;
      // As on the `text` arm. An unreadable body leaves `argumentsJson` empty rather than dropping
      // the call, whose id the pairing repair needs.
      contentUnavailable?: boolean | undefined;
    }
  | {
      kind: "tool_result";
      position: number;
      toolCallId: string;
      outcome: "succeeded" | "failed";
      provenance: CanonicalToolResultProvenance;
      text: string;
      // Present when the provider emitted this result inside a reasoning block; stripping that
      // block removes the result and orphans its call, the only way an orphan arises from a
      // well-formed transcript.
      enclosingReasoningBlockId?: string | undefined;
      // How the fold resolved that enclosure at turn close, and the only carrier of that
      // resolution that survives a positional bound: the block id names a sibling segment a bound
      // may cut away, while this member rides the result. Recorded only for the two dispositions
      // that withhold; a portable (`summary`) enclosure and a citation of a block from another turn
      // leave it absent, since nothing branches on either.
      //   `private`  the enclosing block was read and is not portable;
      //   `unknown`  the enclosure could not be established portable (the turn's reasoning row was
      //              unreadable, or the block carried a disclosure this fold does not classify).
      //              Fail-closed: content that might be private travels with the block.
      enclosureDisclosure?: "private" | "unknown" | undefined;
      // As on the `text` arm.
      contentUnavailable?: boolean | undefined;
    };

/** One ordered turn of the canonical transcript. */
export interface CanonicalTranscriptTurn {
  // The session-log sequence of the event that opened this turn (its first segment). Turns ascend
  // strictly in it. Consecutive same-role events coalesce into an open turn and keep their own,
  // higher, positions on their segments, so this member bounds nothing: a filter on it would admit
  // every later event folded into a turn that opened early.
  position: number;
  role: CanonicalTranscriptRole;
  segments: readonly CanonicalTranscriptSegment[];
}

/**
 * The daemon-side fold of a run's normalized events into ordered turns; it never crosses a wire and
 * is never persisted.
 */
export interface CanonicalTranscriptProjection {
  sessionId: SessionId;
  runId: RunId;
  // The log position this fold was taken at: two folds at one position render identically, and one
  // taken after an appended event does not.
  builtAtPosition: number;
  turns: readonly CanonicalTranscriptTurn[];
}

/**
 * Input of `exportTranscript`: the folded projection and the boundary it is exported against. The
 * driver retains exactly the segments whose `position` is at or below `boundary` and drops any turn
 * left empty. The filter is per segment, not per turn, because the fold coalesces consecutive
 * same-role events into one turn positioned at the first, so a turn-level filter would carry later
 * events' content across the boundary. It is a deterministic filter over data the driver already
 * holds and equals the fold bounded at the same position, so it is a no-op on an already-bounded
 * projection.
 */
export interface ExportTranscriptParams {
  sessionId: SessionId;
  transcript: CanonicalTranscriptProjection;
  // Export up to and including this normalized session position, the vocabulary of
  // `ForkConversationParams.position` and `CanonicalTranscriptSegment.position`.
  boundary: number;
}

/** Return of `ProviderDriver.exportTranscript()`. */
export interface DriverTranscriptExportResult {
  // Provider-shaped replay frames, untyped on purpose: the pinned injection surface takes an
  // untyped array and validates neither shape nor tool-call pairing, so the daemon owns both and a
  // type here would assure a check nobody performs.
  frames: unknown[];
  // What the strip and repair steps of the ordered pipeline removed or repaired, by class.
  declaredLosses: DeclaredLossKind[];
}

/** Validates a {@link DriverTranscriptExportResult}; strict. */
export const DriverTranscriptExportResultSchema: z.ZodType<
  DriverTranscriptExportResult,
  DriverTranscriptExportResult
> = z
  .object({
    frames: z.array(z.unknown()),
    declaredLosses: z.array(DeclaredLossKindSchema),
  })
  .strict();

/** Params of `replayTranscript`: a fresh target session and the frames to inject into it. */
export interface ReplayTranscriptParams {
  // A fresh session handle. Replay never writes to the session the transcript came from.
  target: ProviderSessionHandle;
  frames: unknown[];
}

/**
 * Return of `ProviderDriver.replayTranscript()`. Flat rather than discriminated, unlike
 * `ForkConversationResult`, because `declaredLosses` is required on both arms: an `applied` replay
 * that stripped provider-private reasoning still lost something. The arm-scoped content rule rides
 * the schema below, since expressing it in the type would need the union this shape avoids.
 */
export interface DriverTranscriptReplayResult {
  // `degraded` means the memo floor stood in: the conversation moved and the losses say what came
  // along. It is not a failure; a target that cannot be reached at all throws.
  status: "applied" | "degraded";
  declaredLosses: DeclaredLossKind[];
}

/** Validates a {@link DriverTranscriptReplayResult}; strict, with arm-scoped loss rules. */
export const DriverTranscriptReplayResultSchema: z.ZodType<
  DriverTranscriptReplayResult,
  DriverTranscriptReplayResult
> = z
  .object({
    status: z.enum(["applied", "degraded"]),
    declaredLosses: z.array(DeclaredLossKindSchema),
  })
  .strict()
  // `degraded` here has one cause, the memo floor standing in, so it must name
  // `conversation_history_summarized`. Enforced rather than narrated: the flat shape admits
  // `{status: 'degraded', declaredLosses: []}`, and an empty array claims nothing was dropped, so
  // that value would tell the caller a summary is the verbatim conversation. Naming the kind
  // subsumes non-emptiness; a bare `.min(1)` would admit a degraded result declaring some other
  // loss while hiding the summarization. `applied` keeps full latitude over every other kind,
  // empty list included. (`.superRefine()` returns `this`, so the envelope stays a `ZodObject` and
  // the annotation above holds.)
  //
  // The inverse rule makes the kind an exact witness of the arm: `applied` with
  // `conversation_history_summarized` claims both that native replay landed and that a summary
  // stood in, so a consumer reading `status` and one reading the kind would publish opposite
  // continuity for the same value.
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

// ---- Compaction and provider commands ----

// Their params are daemon-constructed and binding-addressed: a run has many bindings and each
// operation acts on exactly one leg. The client-facing verbs take a run (compaction) or an agent
// (enumeration), and the SDK seam resolves the binding at dispatch.

/** Params of `compactContext` (gated on `context_compaction`); addresses one binding. */
export interface CompactContextParams {
  sessionId: SessionId;
  bindingId: string;
}

/**
 * The result of a compaction attempt, not of the request, discriminated on `status` so no arm
 * carries a member another arm makes meaningless. `applied` is reachable only after the provider's
 * typed compaction frame is observed; `boundaryPosition` is required there, `number | null` so a
 * frame carrying no position is representable without being synthesized. `refused` means nothing
 * was sent; `failed` means something was sent and no boundary was witnessed. There is no
 * `capability_undeclared` reason: an undeclared flag refuses at the static capability gate with
 * `driver.capability_unsupported` before the driver is called, so an arm would encode one refusal
 * twice.
 */
export type DriverCompactionResult =
  | { status: "applied"; boundaryPosition: number | null }
  // `command_absent`: the pre-dispatch presence check on the emulated leg did not find the command
  // in the provider's own enumeration for this binding. `not_permitted`: the run-control
  // adjudication denied the caller; produced by the daemon-side gate, never by a driver (which
  // runs no authorization), and it lives here because the refusal settles on the operation's own
  // result rather than as a JSON-RPC error.
  | { status: "refused"; reason: "command_absent" | "not_permitted" }
  // `wait_expired`: the driver's declared per-binding compaction bound elapsed with no typed
  // compaction frame. `binding_lost`: the binding stopped being live before one arrived.
  // `provider_error`: the mechanism itself errored. Every arm records a diagnostic; none can
  // settle `applied`.
  | { status: "failed"; reason: "wait_expired" | "binding_lost" | "provider_error" };

/**
 * Validates a {@link DriverCompactionResult} as a structural assertion, not an untrusted-result
 * envelope: the result is daemon-constructed from a settlement the daemon's own wait computed, and
 * the client SDK parses the reply with it. It keeps two structural rules mechanical: `applied`
 * without a `boundaryPosition` key does not parse, and no arm admits `capability_undeclared`. The
 * provider's own boundary position, the one untrusted number, is narrowed at the frame-normalize
 * boundary before it reaches this result.
 */
export const DriverCompactionResultSchema: z.ZodType<
  DriverCompactionResult,
  DriverCompactionResult
> = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      // `.nullable()`, not `.optional()`: null states that the provider's frame carried no
      // position, while an absent key would look like a driver that forgot to report one.
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

/** Params of `listProviderCommands` (gated on `provider_commands`); addresses one binding. */
export interface ListProviderCommandsParams {
  sessionId: SessionId;
  bindingId: string;
}

/**
 * One enumerated provider command or skill. `binding` is the routing key, carried with the data so
 * a consumer cannot lose it by filtering a held list instead of re-reading; its
 * `providerAccountId` is nullable because a session need not have bound an account. The driver does
 * not filter: a disabled entry is returned, since dropping it would stop the result being the
 * provider's enumeration as observed and hide the difference between a disabled command and one
 * that does not exist. `enabled` governs offerability, not presence. This is enumeration and
 * discovery, not a dispatch channel: the only entry the driver sends is the compaction command,
 * reached through `compactContext`, which checks presence against this enumeration.
 */
export interface ProviderCommandEntry {
  name: string;
  // Distinguishes the two things providers publish under one syntax.
  kind: "command" | "skill";
  // Omitted, never an empty string, when the provider publishes none. Codex types a skill's
  // description as required, so a skill with none arrives as "", which the schema's
  // `wireFreeFormString` rejects; forwarding it verbatim would fail the enumeration on an honest
  // reading. Omission also says the truth: no description was published, not a blank one.
  description?: string | undefined;
  // Present only where the provider declares one (Codex skills do; the Claude handshake
  // enumeration does not), so absence means no scope was stated, never that it is unknown.
  scope?: string | undefined;
  // Present iff the provider declares one (Codex `skills/list` carries an `enabled` Boolean; the
  // Claude handshake enumeration draws no such distinction). Absent means no distinction on this
  // surface, never an unknown state, and never a driver-synthesized `true`.
  enabled?: boolean | undefined;
  binding: { driverName: string; providerAccountId: string | null };
}

/**
 * Validates a {@link ProviderCommandEntry}. Strict, siding with the result envelopes: the driver
 * builds it from what its provider published, so an unknown key is a driver bug. Both
 * provider-authored strings are `wireFreeFormString`-bounded because a local skill file's front
 * matter is operator-writable and the assembled list travels to a client.
 */
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
        // Nullable, not `.optional()`: an account-less session is real (the account registry is a
        // spawn-time binding not every leg carries) and `null` states that none was bound. An
        // absent key would look like a driver that forgot to report one, and a placeholder (`""`,
        // "unknown", the driver name) would make the routing invariant unenforceable while looking
        // enforced, since two account-less bindings on different providers would compare equal on
        // the half of the pair meant to separate them.
        //
        // `null` matches nothing, never a wildcard: an account-less enumeration can be read but
        // never used to route a dispatch onto another binding. That is the consumer's obligation,
        // not something this schema enforces. A driver also reports `null` when it has no reader
        // for the account registry (neither establishment params object carries an account id);
        // the obligation reads the same on both, so neither authorizes a dispatch onto another
        // binding.
        providerAccountId: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * One live binding's enumeration. `runId` and `binding` together are provenance a client can read
 * and construct, not an addressing handle: neither alone is a key (a run has many bindings, and one
 * agent can hold bindings on the same provider and account across two runs). `complete: false`
 * means the provider published more entries than the cap admits and this group's tail was dropped;
 * the cap and the flag are per group.
 */
export interface ProviderCommandBindingGroup {
  // Nullable, and never omitted, for the same reason as `providerAccountId`. An enumeration
  // belongs to the binding, which outlives any one run, so no single run attributes it in two
  // cases: zero runs are live (the ordinary pre-first-turn palette read, which succeeds with `null`
  // rather than refusing), and two or more runs are live on the binding (picking one would be a
  // coin flip presented as provenance). Exactly one live run answers with that run. A last-bound
  // fallback is rejected: a never-cleared id naming a retired run is false provenance, worse than
  // the honest `null`.
  runId: RunId | null;
  binding: { driverName: string; providerAccountId: string | null };
  entries: ProviderCommandEntry[];
  complete: boolean;
}

/**
 * The reply of `listProviderCommands`: a list of binding groups, never a bare entry array, because
 * an agent can hold several live bindings and a flat array would strip provenance from an arbitrary
 * leg's commands. The driver operation returns exactly one group (its params name one binding); the
 * envelope is shared with the client-facing verb so the daemon's fan-out and merge across an
 * agent's bindings is a concatenation. The routing invariant (an entry is offerable and
 * dispatchable only through agents of the binding it was read under) is enforced at the daemon, not
 * here: a driver comparing the pair against itself would refuse every account-less read, since
 * `null` matches nothing by design. What each driver does enforce is a dispatch into the very
 * process whose enumeration it read, matched by that process's own identity.
 */
export interface ProviderCommandListResult {
  bindings: ProviderCommandBindingGroup[];
}

/**
 * The provider's own report of its accelerated-output state, never a probe of its own and never
 * synthesized from the request. It is binding-held driver-session state, not a spawn return: the
 * declaring handshake arrives only within a turn-bearing exchange, so neither `createSession` nor
 * `resumeSession` can carry it (neither may spend a synthetic turn or block waiting for one). The
 * driver records it when the handshake arrives, on the first turn-bearing exchange the user's own
 * work produces, and holds it for the binding's life; until then every reader sees absent, never a
 * default. It is discarded with the session and deliberately not written to
 * `runtime_bindings.spawn_config` (what was requested, for resume) or `agents.output_speed` (the
 * operator's accepted choice): persisting an observation there would create a second, staler
 * record and make a mode that stopped being available look accepted after a restart. `declared`
 * is verbatim and not narrowed to `outputSpeedLevels`, which bounds what a caller may request; a
 * level the driver's table does not list is a real state under version skew, and coercing it would
 * fabricate a false reading. `reason` is the provider's own explanation, present only where it
 * gave one.
 */
export interface ProviderOutputSpeedState {
  declared: string;
  reason?: string | undefined;
}

/** Validates a {@link ProviderOutputSpeedState}; strict, like `ProviderCommandEntrySchema`. */
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
 * which records no enforced credential constraint. It is a content-addressed `"sha256:<hex>"` over
 * the RFC 8785 JCS-canonicalized credential-policy artifact: a reference, so auditors can
 * reconstruct which credentials were denied without the posture embedding an
 * installation-revealing list.
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

/**
 * The invocation a driver hands to the injected dispatcher, built from untrusted provider wire
 * output. This parse is the last point before the value reaches daemon-owned code and guarantees
 * only that strings are bounded and ids well-formed. The dispatcher host does the checks that need
 * the session's registry: an unknown `toolName` answers `failed` without dispatch, and `arguments`
 * are validated against the registered `inputSchema` before any Cedar round-trip, so malformed
 * provider output never reaches the approval pipeline. `toolCallId` is copied verbatim onto the
 * answered result because tool-event pairing is an exact-string match.
 */
export interface CallbackToolInvocation {
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId: string;
  sessionId: SessionId;
  runId: RunId;
}
/** Validates a {@link CallbackToolInvocation}; strict. */
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
    // References the shared `RunIdSchema` rather than building a second run-id validator.
    runId: RunIdSchema,
  })
  .strict();

/**
 * The answer the daemon returns to the driver, which relays it to the provider. Daemon-constructed
 * and trusted, so plain TypeScript: trust runs the reverse way from the invocation. Only
 * `completed` may carry `output` and only the failure arms may carry `error`, so "denied with
 * output" and "completed with an error" are unrepresentable. The `?: never` members are
 * structurally absent, so they take no `| undefined` (as in `ExecutionPosture`).
 */
export type CallbackToolResult =
  | { status: "completed"; output?: unknown; error?: never }
  | { status: "denied"; output?: never; error?: string | undefined }
  | { status: "failed"; output?: never; error?: string | undefined };

// ---- MCP server status ----

/** Connection state of one MCP server. Servers only: support is not visibility of its tools. */
export type McpServerStatus = "unknown" | "starting" | "connected" | "needs-auth" | "failed";

/**
 * What a driver emits for one MCP server: `serverName` and `status`, nothing else. The driver never
 * supplies leg identity, since the daemon pre-binds the injected producer to the leg at spawn, so a
 * driver cannot misattribute or spoof another leg's rows. `serverName` is untrusted provider or CLI
 * output, so the shape is Zod-parsed at the driver normalization seam.
 */
export interface McpServerStatusEmission {
  serverName: string;
  status: McpServerStatus;
}
/** Validates a {@link McpServerStatusEmission}; strict. */
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

/**
 * What the consumer reads: the pre-bound producer stamps the leg identity onto every emission.
 * `bindingId` is daemon-stamped, never driver-supplied. Because a run has many bindings, statuses
 * key per `(binding, server)`, so a relaunched leg's fresh census supersedes its own predecessor
 * without clobbering a concurrent live leg's rows.
 */
export interface McpServerStatusUpdate {
  sessionId: SessionId;
  bindingId: string;
  serverName: string;
  status: McpServerStatus;
}

/**
 * The injected status sink. Returns `void`, not `Promise<void>`, unlike the awaited
 * `onCallbackToolCall`: it is fire-and-forget telemetry, and making it awaitable would let a slow
 * consumer back-pressure the provider's status stream.
 */
export type McpServerStatusProducer = (emission: McpServerStatusEmission) => void;

// ---- Provider-native subagents ----

/**
 * Provider-native subagent policy, daemon-constructed and gated on `subagents`. The daemon is the
 * only cross-session supervisor, so provider subagents run in-session only: their usage aggregates
 * into the run's own budgets and their tool calls flow through the same approval pipeline.
 * Discriminated on `enabled` so a disabled policy carries no limits or definitions ("off but
 * configured" is unrepresentable) and the daemon sends the full arm on enable.
 */
export type SubagentPolicy =
  | { enabled: false }
  | { enabled: true; maxDepth: number; maxConcurrent: number; definitions: SubagentDefinition[] };

/**
 * The unified per-subagent definition each driver maps onto its provider form (Claude `--agents`
 * AgentDefinition; Codex `[agents]` config). Every field beyond `name` is optional because each leg
 * maps what its provider supports and ignores the rest, which the capability matrix grades.
 */
export interface SubagentDefinition {
  name: string;
  description?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  permissionMode?: string | undefined;
  effort?: string | undefined;
  maxTurns?: number | undefined;
}

// ---- Driver transport configuration ----

/**
 * How the daemon reaches a driver process; a daemon driver-registry setting, not an RPC payload or
 * a `ProviderDriver` member. Only the Codex leg uses it (`app-server --listen unix://|ws://`,
 * config-gated, off by default); the Claude CLI exposes no local listener, so remote Claude
 * participation is cross-node dispatch. `bearerTokenRef` references the ws bearer credential in
 * daemon config, never the secret value, and is required on the websocket arm so an unauthenticated
 * ws listener is unrepresentable.
 */
export type DriverTransportConfig =
  | { transport: "stdio" }
  | { transport: "unix-socket"; endpoint: string }
  | { transport: "websocket"; endpoint: string; bearerTokenRef: string };

// ---- Client-facing SDK-seam wire schemas ----

// A third boundary, separate from the provider boundary above: these schemas guard client input
// crossing into the daemon over JSON-RPC, plus the daemon's own replies. A client is untrusted
// about different values than a provider, so the caps below are a disjoint set.
//
// Only `driver.*` methods that act on an already-existing session or run have schemas here. The
// four lifecycle operations (`createSession`, `resumeSession`, `startRun`, `closeSession`) are
// orchestration-owned and deliberately have no client-facing shape, so a client guessing a method
// name cannot reach them. The registered methods are in `DRIVER_METHOD_DESCRIPTORS` at the end of
// the file, plus `driver.subscribeEvents` in `driver-event.ts`. The compaction and command replies
// reuse `DriverCompactionResultSchema` and `ProviderCommandListResultSchema` rather than a second
// schema.
//
// `driver.listCapabilities` and `driver.listModes` take nothing: capabilities come from the
// daemon's capability cache with no provider round-trip per call. `driver.listModels` takes the
// session whose model control asks, because the catalog is the one that session can run. None
// takes a `{ driverName }`; every reply answers for every driver, as a group list keyed by
// `driverName` and never a flat merged array, like `ProviderCommandListResult`: model ids collide
// across providers and mode ids carry no vendor marker, so a caller cannot re-derive which driver
// published an entry, and grouping keeps a Claude-published value from being offered to or sent
// through a Codex-bound agent.
//
// The capability reply carries the flags plus `outputSpeedLevels` (without it a client would see
// `output_speed: true` with no values to render) and `builtInTools` (each provider's own fixed tool
// list, which the tool-allowlist picker offers; a different list from `tools`). It omits
// `detectionSource`, `cliVersion` and `tools`: provenance and version are read through the daemon,
// `tools` is a daemon-side ingress concern (it reaches `driver_tools`), and adding a member later
// is additive while removing one is a break.

// Per-field length caps for the SDK seam. The framework layer bounds body size; these are the
// second line, applied through `wireFreeFormString` so empty, whitespace-only, NUL-bearing and
// over-length values refuse before reaching a store lookup or a driver dispatch.

/**
 * Max length of a short identifier or label on this seam: model and mode `id` and `name`, and the
 * vocabulary tokens inside `capabilities`, `effortLevels` and `outputSpeedLevels`. Sized well above
 * the longest published model id.
 */
export const DRIVER_WIRE_TOKEN_MAX_LEN = 128;
/**
 * Max length of the opaque provider correlation handle a client echoes back
 * (`SteerPayload.expectedTurnId`); roomier than the token tier because refusing a legitimate
 * provider-minted handle would make a valid steer unsendable.
 */
export const DRIVER_WIRE_HANDLE_MAX_LEN = 256;
/**
 * Max length of the human-authored `reason` on `InterruptRunParams`, `InterruptPayload` and
 * `CancelPayload`; short prose, since an over-long reason refuses the whole intervention, which is
 * expressible without it.
 */
export const DRIVER_WIRE_REASON_MAX_LEN = 512;
/**
 * Max length of a message the person sends: a queued message (`run.queueCreate`, a child's
 * `run.childSteer`), the steer that delivers it (`SteerPayload.content`), an undo's resend and a
 * side question. Generous because an over-long payload is rejected whole, not truncated. Declared
 * here because `SteerPayload` applies it and this file cannot import a module that imports it.
 */
export const DRIVER_WIRE_STEER_CONTENT_MAX_LEN = 16384;
/**
 * Max entries in a per-driver model or mode list and in the token arrays inside a model. Unlike
 * `DRIVER_PROVIDER_COMMAND_ENTRIES_MAX` it rejects rather than truncates: these replies carry no
 * `complete` flag, and a silently short catalog would look like a provider publishing fewer
 * models. Sized far above the pinned surfaces, so tripping it means a daemon composition bug.
 */
export const DRIVER_WIRE_CATALOG_ENTRIES_MAX = 256;
/**
 * Max attachments on one message wherever the content cap applies: a coarse frame-abuse ceiling on
 * the count (each element is already bounded by the `ArtifactId` UUID shape). Not the policy bound:
 * `max_attachments_per_carrier` (default 10, range 1-50) is enforced by the daemon at carrier
 * acceptance, so this is sized above that range and a parse never pre-empts the operator's refusal.
 */
export const DRIVER_WIRE_STEER_ATTACHMENTS_MAX = 64;
/**
 * Max length of `DriverCapabilities.contractVersion` on the capability reply. Deliberately equal to
 * `CAPABILITY_CONTRACT_VERSION_MAX_LEN` (`event-core.ts`), which bounds the same field on the
 * `CapabilityDetails` snapshot, so a version that survives one survives the other. Redeclared, not
 * imported: `event-core.ts` imports `DRIVER_CAPABILITY_FLAGS` from this file, and importing back
 * would close a value cycle that leaves that array in its temporal dead zone at module init. A
 * change to either value lands on both.
 */
export const DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN = 64;

/**
 * Request of the two no-arg reads (`driver.listCapabilities`, `driver.listModes`). Strict: an
 * unknown key means a caller believes it is talking to a different method, and ignoring it would
 * hide that until something downstream reads the field that never arrived. Kept apart from
 * `DriverAckResult`, though both are the empty object, because they sit on opposite sides of the
 * wire and one must be free to grow without a breaking edit to the other.
 */
export type DriverReadParams = Record<string, never>;
/** Validates a {@link DriverReadParams}. */
export const DriverReadParamsSchema: z.ZodType<DriverReadParams, DriverReadParams> = z
  .object({})
  .strict();

/** Reply of the verbs whose driver-side operation returns `Promise<void>`. */
export type DriverAckResult = Record<string, never>;
/** Validates a {@link DriverAckResult}. */
export const DriverAckResultSchema: z.ZodType<DriverAckResult, DriverAckResult> = z
  .object({})
  .strict();

/** Request of `driver.listModels`: the session whose model control reads the catalog. Strict. */
export interface ListModelsRequest {
  sessionId: SessionId;
}
/** Validates a {@link ListModelsRequest}. */
export const ListModelsRequestSchema: z.ZodType<ListModelsRequest, ListModelsRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

// Module-local. Derived from `DRIVER_CAPABILITY_FLAGS` rather than hand-listed, so a new flag can
// never be silently stripped off the capability reply at runtime (a client would read "undeclared"
// for a capability the driver declared `true`). The `as` cast is narrow: `Object.fromEntries`
// returns an index signature, and the array's `as const` makes the narrowing sound.
const DRIVER_CAPABILITY_FLAG_SHAPE: Record<DriverCapabilityFlag, z.ZodBoolean> = Object.fromEntries(
  DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, z.boolean()]),
) as Record<DriverCapabilityFlag, z.ZodBoolean>;

/**
 * Validates `DriverCapabilities` on the wire, where nominal types do not guard.
 * `contractVersion` is bounded by this seam's own `DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN`.
 */
export const DriverCapabilitiesSchema: z.ZodType<DriverCapabilities, DriverCapabilities> = z
  .object({
    flags: z.object(DRIVER_CAPABILITY_FLAG_SHAPE).strict(),
    contractVersion: wireFreeFormString(
      DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN,
      "DriverCapabilities.contractVersion",
    ),
  })
  .strict();

/**
 * One driver's entry in the `driver.listCapabilities` reply: `GetCapabilitiesResult` minus
 * `detectionSource`, `cliVersion` and `tools`, plus `driverName` and `builtInTools` (the provider's
 * own tool names in its own words; every driver has them, so the member is required).
 */
export interface DriverCapabilityReport {
  driverName: string;
  capabilities: DriverCapabilities;
  outputSpeedLevels?: string[] | undefined;
  builtInTools: string[];
}

/** Reply of `driver.listCapabilities`: one report per driver. */
export interface ListCapabilitiesResult {
  drivers: DriverCapabilityReport[];
}

/**
 * Validates a {@link DriverCapabilityReport}. `driverName` is only `.min(1)`: it is the daemon's
 * own registry key (`"claude"`, `"codex"`) quoted back on a reply, so an empty one is a
 * composition bug and nothing else about it is known here. That `outputSpeedLevels` is present iff
 * `output_speed` is true is enforced by the daemon's cache at composition time, not here (absence
 * is also the shape for every driver whose flag is false); the schema enforces that a present
 * member is a bounded array of bounded tokens.
 */
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
    builtInTools: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "DriverCapabilityReport.builtInTools"))
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
  })
  .strict();

/** Validates a {@link ListCapabilitiesResult}. */
export const ListCapabilitiesResultSchema: z.ZodType<
  ListCapabilitiesResult,
  ListCapabilitiesResult
> = z.object({ drivers: z.array(DriverCapabilityReportSchema) }).strict();

/**
 * Validates a {@link ProviderModel} on the `listModels` reply. It checks a daemon-composed reply,
 * catching a composition bug (an empty id, an unbounded token read straight off a provider catalog)
 * before it reaches a renderer; no earlier schema bounds these shapes.
 */
export const ProviderModelSchema: z.ZodType<ProviderModel, ProviderModel> = z
  .object({
    id: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.id"),
    name: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.name"),
    capabilities: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.capabilities"))
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
    // Absent and empty must stay distinguishable: absent means no effort selection, and an empty
    // array would assert an effort axis with nothing on it. So `.optional()` with no
    // `.default([])`, which would erase the distinction at the parse that should preserve it.
    effortLevels: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.effortLevels"))
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX)
      .optional(),
    fast: z.boolean(),
    contextWindow: z.number().int().positive().optional(),
  })
  .strict();

/** Validates a {@link ProviderMode} on the `listModes` reply. */
export const ProviderModeSchema: z.ZodType<ProviderMode, ProviderMode> = z
  .object({
    id: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderMode.id"),
    name: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderMode.name"),
  })
  .strict();

/** One driver's models in the `listModels` reply. */
export interface DriverModelReport {
  driverName: string;
  models: ProviderModel[];
}

/** Reply of `driver.listModels`: one group per driver. */
export interface ListModelsResult {
  drivers: DriverModelReport[];
}

/** Validates a {@link DriverModelReport}. */
export const DriverModelReportSchema: z.ZodType<DriverModelReport, DriverModelReport> = z
  .object({
    driverName: z.string().min(1),
    models: z.array(ProviderModelSchema).max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
  })
  .strict();

/** Validates a {@link ListModelsResult}. */
export const ListModelsResultSchema: z.ZodType<ListModelsResult, ListModelsResult> = z
  .object({ drivers: z.array(DriverModelReportSchema) })
  .strict();

/** One driver's modes in the `listModes` reply. */
export interface DriverModeReport {
  driverName: string;
  modes: ProviderMode[];
}

/** Reply of `driver.listModes`: one group per driver. */
export interface ListModesResult {
  drivers: DriverModeReport[];
}

/** Validates a {@link DriverModeReport}. */
export const DriverModeReportSchema: z.ZodType<DriverModeReport, DriverModeReport> = z
  .object({
    driverName: z.string().min(1),
    modes: z.array(ProviderModeSchema).max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
  })
  .strict();

/** Validates a {@link ListModesResult}. */
export const ListModesResultSchema: z.ZodType<ListModesResult, ListModesResult> = z
  .object({ drivers: z.array(DriverModeReportSchema) })
  .strict();

/**
 * Validates `driver.interruptRun` input; the first consumer of `RunIdSchema`, which is why that
 * validator lives in this file. The shape is the driver param shape, not a session-addressed
 * envelope: a run id is globally unique, so a `sessionId` beside it would be a second addressing
 * key with no honest answer when the two disagree. The console-parity requests below are
 * session-addressed because the session is the authorization scope they mask against first.
 */
export const InterruptRunParamsSchema: z.ZodType<InterruptRunParams, InterruptRunParams> = z
  .object({
    runId: RunIdSchema,
    reason: wireFreeFormString(DRIVER_WIRE_REASON_MAX_LEN, "InterruptRunParams.reason").optional(),
  })
  .strict();

/**
 * Validates `driver.applyIntervention` input as a discriminated union on `type`, arm for arm with
 * `ApplyInterventionParams`. The union is the dispatch surface, so an unknown `type` fails parse at
 * the discriminator rather than reaching a handler that would have to invent a refusal.
 * `clientIdempotencyKey` is a requester-generated UUID validated here (`z.uuid()`); otherwise a
 * caller-chosen unbounded string would land in a durable receipt and replay keying would depend on
 * client discipline. `expectedRunVersion` is optimistic-concurrency state, so `.int()` and
 * `.nonnegative()` matter: a float or a negative would compare unequal to every stored version and
 * turn the check into an unconditional refusal that looks like a conflict.
 */
export const ApplyInterventionParamsSchema: z.ZodType<
  ApplyInterventionParams,
  ApplyInterventionParams
> = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("steer"),
      targetRunId: RunIdSchema,
      expectedRunVersion: z.number().int().nonnegative(),
      clientIdempotencyKey: z.uuid(),
      payload: z
        .object({
          content: wireFreeFormString(DRIVER_WIRE_STEER_CONTENT_MAX_LEN, "SteerPayload.content"),
          // `ArtifactId` elements, so a non-id element is refused outright; the `.max()` is the
          // coarse frame-abuse count ceiling. The policy count is the daemon's at carrier
          // acceptance (see `SteerPayload`).
          attachments: z.array(ArtifactIdSchema).max(DRIVER_WIRE_STEER_ATTACHMENTS_MAX).optional(),
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
      clientIdempotencyKey: z.uuid(),
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
      clientIdempotencyKey: z.uuid(),
      payload: z
        .object({
          reason: wireFreeFormString(DRIVER_WIRE_REASON_MAX_LEN, "CancelPayload.reason").optional(),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * Request of `driver.subscribeEvents`: a subscription opened against one run's driver event stream.
 * The reply is the shared `SubscribeAckResponse` (`jsonrpc-streaming.ts`), the opaque
 * `subscriptionId` with events arriving as later `$/subscription/notify` frames; a driver-specific
 * twin would fork an envelope the SDK's inbound dispatcher keys on uniformly.
 */
export interface DriverSubscribeEventsParams {
  runId: RunId;
}

/** Validates a {@link DriverSubscribeEventsParams}. */
export const DriverSubscribeEventsParamsSchema: z.ZodType<
  DriverSubscribeEventsParams,
  DriverSubscribeEventsParams
> = z.object({ runId: RunIdSchema }).strict();

// ---- Console-parity wire requests ----

// Both requests are session-addressed and neither carries a binding: a binding is daemon-internal
// state, and a request that could name one would hand a caller the routing key the daemon must
// enforce. The `sessionId` is the authorization scope both verbs mask against first (a non-member
// and an unknown session refuse byte-identically); the run or agent is resolved within it.

/**
 * Request of `driver.compactContext`, the user-triggered compaction. Run-addressed within the
 * session: compaction drives one run's live binding, and the daemon resolves that binding itself
 * (refusing `run.not_found` or `driver.unavailable`). The reply is a `DriverCompactionResult`,
 * never a bare acknowledgment: `refused` and `failed` are data a caller branches on, because the
 * daemon-side adjudication (`not_permitted`) settles on the operation's own result rather than as a
 * JSON-RPC error.
 */
export interface CompactContextRequest {
  sessionId: SessionId;
  runId: RunId;
}

/** Validates a {@link CompactContextRequest}. */
export const CompactContextRequestSchema: z.ZodType<CompactContextRequest, CompactContextRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
    })
    .strict();

/**
 * Request of `driver.listProviderCommands`, the command-surface enumeration. Agent-addressed
 * within the session: an agent can hold several live bindings, and the daemon's fan-out across
 * them is what the reply's group list carries. `.strict()` makes "the wire admits no binding
 * member" a refusal rather than a convention.
 */
export interface ListProviderCommandsRequest {
  sessionId: SessionId;
  // Typed `string`, not the branded `AgentId`: its brand and schema live in `agent-definition.ts`,
  // which imports this file, so importing back would create a load cycle. The schema checks it as
  // a UUID where it crosses; a branded `AgentId` is assignable to it at every call site.
  agentId: string;
}

/** Validates a {@link ListProviderCommandsRequest}. */
export const ListProviderCommandsRequestSchema: z.ZodType<
  ListProviderCommandsRequest,
  ListProviderCommandsRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    agentId: z.uuid(),
  })
  .strict();

/**
 * Validates a {@link ProviderCommandBindingGroup} on the reply. It checks a daemon-composed reply,
 * catching a composition bug (a dropped `runId` key, an unbounded merge) before it reaches a
 * renderer.
 */
export const ProviderCommandBindingGroupSchema: z.ZodType<
  ProviderCommandBindingGroup,
  ProviderCommandBindingGroup
> = z
  .object({
    // `.nullable()`, not `.optional()`: the zero-live-runs and two-or-more-live-runs cases both
    // answer `null`, and an absent key would look like a producer that forgot to attribute the
    // group.
    runId: RunIdSchema.nullable(),
    binding: z
      .object({
        driverName: z.string().min(1),
        providerAccountId: z.string().min(1).nullable(),
      })
      .strict(),
    // Bounded at `DRIVER_PROVIDER_COMMAND_ENTRIES_MAX`, the provider-boundary cap per group, not
    // the smaller `DRIVER_WIRE_CATALOG_ENTRIES_MAX`: entries already admitted at the larger cap
    // would otherwise fail result validation with a `-32603`. Truncation carries a marker, so this
    // cap only backstops a merge bug.
    entries: z.array(ProviderCommandEntrySchema).max(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX),
    complete: z.boolean(),
  })
  .strict();

/**
 * Validates a {@link ProviderCommandListResult}. `.min(1)`: a success reply is never the empty
 * group list, because the handler refuses an agent holding no live binding as `driver.unavailable`
 * before any dispatch, so zero groups is a composition bug. The group count is deliberately
 * uncapped, like the `drivers` arrays on the roster replies: it is the daemon's own fan-out over
 * the agent's live bindings, bounded by run admission, and a cap would refuse an honest reply while
 * defending against nothing a caller controls.
 */
export const ProviderCommandListResultSchema: z.ZodType<
  ProviderCommandListResult,
  ProviderCommandListResult
> = z
  .object({
    bindings: z.array(ProviderCommandBindingGroupSchema).min(1),
  })
  .strict();

// ---- Method table ----

// `driver.subscribeEvents` is in the table in `driver-event.ts`: its emission is the session
// event, and naming that schema here would import the event module, which imports this file.

/** The driver methods a client calls, each a query or a mutation. */
export interface DriverMethodDescriptors {
  readonly "driver.listCapabilities": MethodDescriptor<
    "driver.listCapabilities",
    DriverReadParams,
    ListCapabilitiesResult
  >;
  readonly "driver.listModels": MethodDescriptor<
    "driver.listModels",
    ListModelsRequest,
    ListModelsResult
  >;
  readonly "driver.listModes": MethodDescriptor<
    "driver.listModes",
    DriverReadParams,
    ListModesResult
  >;
  readonly "driver.interruptRun": MethodDescriptor<
    "driver.interruptRun",
    InterruptRunParams,
    DriverAckResult
  >;
  readonly "driver.applyIntervention": MethodDescriptor<
    "driver.applyIntervention",
    ApplyInterventionParams,
    DriverInterventionResult
  >;
  readonly "driver.compactContext": MethodDescriptor<
    "driver.compactContext",
    CompactContextRequest,
    DriverCompactionResult
  >;
  readonly "driver.listProviderCommands": MethodDescriptor<
    "driver.listProviderCommands",
    ListProviderCommandsRequest,
    ProviderCommandListResult
  >;
}

/** The driver methods a client calls: their names, how each answers, and their shapes. */
export const DRIVER_METHOD_DESCRIPTORS: DriverMethodDescriptors = defineMethodDescriptors({
  "driver.listCapabilities": {
    method: "driver.listCapabilities",
    procedureType: "query",
    mutating: false,
    requestSchema: DriverReadParamsSchema,
    responseSchema: ListCapabilitiesResultSchema,
  },
  "driver.listModels": {
    method: "driver.listModels",
    procedureType: "query",
    mutating: false,
    requestSchema: ListModelsRequestSchema,
    responseSchema: ListModelsResultSchema,
  },
  "driver.listModes": {
    method: "driver.listModes",
    procedureType: "query",
    mutating: false,
    requestSchema: DriverReadParamsSchema,
    responseSchema: ListModesResultSchema,
  },
  "driver.interruptRun": {
    method: "driver.interruptRun",
    procedureType: "mutation",
    mutating: true,
    requestSchema: InterruptRunParamsSchema,
    responseSchema: DriverAckResultSchema,
  },
  "driver.applyIntervention": {
    method: "driver.applyIntervention",
    procedureType: "mutation",
    mutating: true,
    requestSchema: ApplyInterventionParamsSchema,
    responseSchema: DriverInterventionResultSchema,
  },
  "driver.compactContext": {
    method: "driver.compactContext",
    procedureType: "mutation",
    mutating: true,
    requestSchema: CompactContextRequestSchema,
    responseSchema: DriverCompactionResultSchema,
  },
  "driver.listProviderCommands": {
    method: "driver.listProviderCommands",
    procedureType: "query",
    mutating: false,
    requestSchema: ListProviderCommandsRequestSchema,
    responseSchema: ProviderCommandListResultSchema,
  },
});
