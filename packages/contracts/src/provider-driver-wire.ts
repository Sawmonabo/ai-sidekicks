// Client-facing wire schemas for the `driver.*` methods, and the method table that registers them.

import { z } from "zod";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import {
  DriverCompactionResultSchema,
  ProviderCommandBindingSchema,
  ProviderCommandEntrySchema,
  type DriverCompactionResult,
  type ProviderCommandBindingGroup,
  type ProviderCommandListResult,
} from "./provider-driver-transcript.js";
import {
  ArtifactIdSchema,
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DriverInterventionResultSchema,
  RunIdSchema,
  type ApplyInterventionParams,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverInterventionResult,
  type InterruptRunParams,
  type ProviderMode,
  type ProviderModel,
  type RunId,
} from "./provider-driver.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  wireUncappedFreeFormString,
  type SessionId,
} from "./session.js";
import { countSchema } from "./internal/wire-scalars.js";

// ---- Client-facing SDK-seam wire schemas ----

// A third boundary, separate from the provider boundary in `provider-driver.ts`: these schemas
// guard client input crossing into the daemon over JSON-RPC, plus the daemon's own replies. A
// client is untrusted about different values than a provider, so the caps below are a disjoint
// set.
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
 * the longest published model id (25 characters at the pinned surfaces).
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
 * Max entries in a per-driver model or mode list and in the token arrays inside a model. Unlike
 * `DRIVER_PROVIDER_COMMAND_ENTRIES_MAX` it rejects rather than truncates: these replies carry no
 * `complete` flag, and a silently short catalog would look like a provider publishing fewer
 * models. Sized far above the pinned surfaces (8 models on Codex, 4 on Claude), so tripping it
 * means a daemon composition bug.
 */
export const DRIVER_WIRE_CATALOG_ENTRIES_MAX = 256;
/**
 * Max length of a driver's `contractVersion`, on the capability reply and where the daemon stores
 * it. The daemon's SQL CHECK constraints repeat the value and change with it.
 */
export const DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN = 64;

/**
 * Request of the two reads that take nothing (`driver.listCapabilities`, `driver.listModes`). An
 * unknown key is refused: the caller believes it is calling a different method.
 */
export type DriverReadParams = Record<string, never>;
/** Validates a {@link DriverReadParams}. */
export const DriverReadParamsSchema: z.ZodType<DriverReadParams, DriverReadParams> = z
  .object({})
  .strict();

/** Request of `driver.listModels`: the session whose model control reads the catalog. */
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
  driverName: ProviderName;
  capabilities: DriverCapabilities;
  outputSpeedLevels?: string[] | undefined;
  builtInTools: string[];
}

/** Reply of `driver.listCapabilities`: one report per driver. */
export interface ListCapabilitiesResult {
  drivers: DriverCapabilityReport[];
}

/**
 * Validates a {@link DriverCapabilityReport}. That `outputSpeedLevels` is present iff
 * `output_speed` is true is enforced by the daemon's cache at composition time, not here (absence
 * is also the shape for every driver whose flag is false); the schema enforces that a present
 * member is a bounded array of bounded tokens.
 */
export const DriverCapabilityReportSchema: z.ZodType<
  DriverCapabilityReport,
  DriverCapabilityReport
> = z
  .object({
    driverName: ProviderNameSchema,
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
  driverName: ProviderName;
  models: ProviderModel[];
}

/** Reply of `driver.listModels`: one group per driver. */
export interface ListModelsResult {
  drivers: DriverModelReport[];
}

/** Validates a {@link DriverModelReport}. */
export const DriverModelReportSchema: z.ZodType<DriverModelReport, DriverModelReport> = z
  .object({
    driverName: ProviderNameSchema,
    models: z.array(ProviderModelSchema).max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
  })
  .strict();

/** Validates a {@link ListModelsResult}. */
export const ListModelsResultSchema: z.ZodType<ListModelsResult, ListModelsResult> = z
  .object({ drivers: z.array(DriverModelReportSchema) })
  .strict();

/** One driver's modes in the `listModes` reply. */
export interface DriverModeReport {
  driverName: ProviderName;
  modes: ProviderMode[];
}

/** Reply of `driver.listModes`: one group per driver. */
export interface ListModesResult {
  drivers: DriverModeReport[];
}

/** Validates a {@link DriverModeReport}. */
export const DriverModeReportSchema: z.ZodType<DriverModeReport, DriverModeReport> = z
  .object({
    driverName: ProviderNameSchema,
    modes: z.array(ProviderModeSchema).max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
  })
  .strict();

/** Validates a {@link ListModesResult}. */
export const ListModesResultSchema: z.ZodType<ListModesResult, ListModesResult> = z
  .object({ drivers: z.array(DriverModeReportSchema) })
  .strict();

/**
 * Validates `driver.interruptRun` input; the first consumer of `RunIdSchema`, which is why that
 * validator lives in `provider-driver.ts`. The shape is the driver param shape, not a
 * session-addressed envelope: a run id is globally unique, so a `sessionId` beside it would be a
 * second addressing key with no honest answer when the two disagree. The console-parity requests
 * below are session-addressed because the session is the authorization scope they mask against
 * first.
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
      expectedRunVersion: countSchema,
      clientIdempotencyKey: z.uuid(),
      payload: z
        .object({
          content: wireUncappedFreeFormString("SteerPayload.content"),
          // `ArtifactId` elements, so a non-id element is refused outright. How many files a
          // message carries is what the daemon and the provider accept, never a count of ours.
          attachments: z.array(ArtifactIdSchema).optional(),
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
      expectedRunVersion: countSchema,
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
      expectedRunVersion: countSchema,
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
    binding: ProviderCommandBindingSchema,
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

// `driver.subscribeEvents` is in the table in `driver-event.ts`: its emission is the session event.

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
    EmptyPayload
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
    responseSchema: EmptyPayloadSchema,
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
