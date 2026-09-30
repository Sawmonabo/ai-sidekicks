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
//   - The client-facing SDK-seam schemas (`RunIdSchema`, and in `provider-driver-wire.ts`
//     `InterruptRunParamsSchema` and the list replies) guard client-to-daemon input, a different
//     boundary with its own length caps.
//
// The contract carries no remote-authority handle or control-plane dispatch shape, so a driver may
// call a remote provider API behind these methods while execution authority stays with the local
// runtime.

import { z } from "zod";
import { brandedUuidIdSchema } from "./internal/branded.js";
import type {
  ClearSessionGoalParams,
  DriverAuthProbeResult,
  DriverResumeResult,
  ForkConversationParams,
  ForkConversationResult,
  SetSessionGoalParams,
} from "./provider-driver-recovery.js";
import type {
  CompactContextParams,
  DriverCompactionResult,
  DriverTranscriptExportResult,
  DriverTranscriptReplayResult,
  ExportTranscriptParams,
  ListProviderCommandsParams,
  ProviderCommandListResult,
  ReplayTranscriptParams,
} from "./provider-driver-transcript.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

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
  // Two bounds: `DRIVER_WIRE_STEER_ATTACHMENTS_MAX` in `provider-driver-wire.ts` is this seam's
  // coarse frame-abuse ceiling; the policy bound `max_attachments_per_carrier` (default 10,
  // operator-tunable 1-50) is enforced by the daemon at carrier acceptance, which refuses the whole
  // carrier as `artifact.too_many_attachments` (413) rather than truncating. A schema constant
  // cannot read operator configuration.
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
