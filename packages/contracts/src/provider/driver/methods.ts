// Client-facing wire schemas for the `driver.*` methods, and the method table that registers them.

import { z } from "zod";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "../../method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "../name.js";
import {
  DriverCompactionResultSchema,
  ProviderCommandBindingSchema,
  ProviderCommandEntrySchema,
  type DriverCompactionResult,
  type ProviderCommandBindingGroup,
  type ProviderCommandListResult,
} from "./transcript.js";
import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type ProviderMode,
  type ProviderModel,
} from "./capabilities.js";
import {
  DriverInterventionResultSchema,
  type ApplyInterventionParams,
  type DriverInterventionResult,
  type InterruptRunParams,
} from "./intervention.js";
import { DRIVER_PROVIDER_COMMAND_ENTRIES_MAX } from "./caps.js";
import { ArtifactIdSchema } from "../../artifacts/id.js";
import { RunIdSchema, type RunId } from "../../run/id.js";
import { wireFreeFormString, wireUncappedFreeFormString } from "../../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../../session/id.js";
import { countSchema } from "../../internal/wire-scalars.js";

// ---- Client-facing wire schemas ----

// These guard client input crossing into the daemon, and the daemon's own replies. Only methods
// that act on an existing session or run are here: the lifecycle operations (`createSession`,
// `resumeSession`, `startRun`, `closeSession`) have no client-facing shape, so a client cannot
// reach them. `driver.subscribeEvents` is registered in `provider/driver/event.ts`.
//
// Every reply answers for every driver as a list grouped by `driverName`, never a merged array:
// model and mode ids collide across providers, so grouping keeps one provider's value from being
// sent through an agent bound to the other.

// Per-field length caps, applied through `wireFreeFormString` so an empty, whitespace-only,
// NUL-bearing or over-long value is refused before a store lookup or a driver dispatch.

/**
 * Max length of a short identifier or label: model and mode `id` and `name`, and the tokens inside
 * `capabilities`, `effortLevels` and `outputSpeedLevels`.
 */
export const DRIVER_WIRE_TOKEN_MAX_LEN = 128;
/**
 * Max length of an opaque provider handle a client echoes back (`SteerPayload.expectedTurnId`);
 * roomier than a token, because refusing a real handle would make a valid steer unsendable.
 */
export const DRIVER_WIRE_HANDLE_MAX_LEN = 256;
/** Max length of the person's `reason` on an interrupt or a cancel. */
export const DRIVER_WIRE_REASON_MAX_LEN = 512;
/**
 * Max entries in a per-driver model or mode list and in the token arrays inside a model. It
 * refuses rather than truncates, because these replies carry no `complete` flag and a silently
 * short catalog would read as the provider's own.
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

// Derived from `DRIVER_CAPABILITY_FLAGS`, so a new flag is never stripped off the reply. The cast
// narrows `Object.fromEntries`' index signature to the flag names.
const DRIVER_CAPABILITY_FLAG_SHAPE: Record<DriverCapabilityFlag, z.ZodBoolean> = Object.fromEntries(
  DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, z.boolean()]),
) as Record<DriverCapabilityFlag, z.ZodBoolean>;

/** Validates `DriverCapabilities` on the wire. */
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
 * One driver's entry in the `driver.listCapabilities` reply: its flags, the output-speed levels it
 * declares for every model, and `builtInTools`, the provider's own tool names in its own words,
 * which the tool-allowlist picker offers. A provider that publishes its speed levels per model
 * carries them on `ProviderModel.outputSpeedLevels` instead.
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
 * Validates a {@link DriverCapabilityReport}. The daemon sends `outputSpeedLevels` exactly when
 * `output_speed` is true and the driver declares its levels statically; the schema bounds only its
 * length.
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

/** Validates a {@link ProviderModel} on the `listModels` reply. */
export const ProviderModelSchema: z.ZodType<ProviderModel, ProviderModel> = z
  .object({
    id: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.id"),
    name: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.name"),
    capabilities: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.capabilities"))
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX),
    // No `.default([])`: absent means the model has no effort axis, which an empty list would deny.
    effortLevels: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.effortLevels"))
      .max(DRIVER_WIRE_CATALOG_ENTRIES_MAX)
      .optional(),
    // No `.default([])` either: absent means the model has no speed selection.
    outputSpeedLevels: z
      .array(wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "ProviderModel.outputSpeedLevels"))
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
 * Validates `driver.interruptRun` input. A run id is unique on its own, so no `sessionId` sits
 * beside it as a second key that could disagree.
 */
export const InterruptRunParamsSchema: z.ZodType<InterruptRunParams, InterruptRunParams> = z
  .object({
    runId: RunIdSchema,
    reason: wireFreeFormString(DRIVER_WIRE_REASON_MAX_LEN, "InterruptRunParams.reason").optional(),
  })
  .strict();

/**
 * Validates `driver.applyIntervention` input, arm for arm with `ApplyInterventionParams`, so an
 * unknown `type` is refused at parse. `clientIdempotencyKey` must be a UUID, so an unbounded
 * caller string never lands in a stored receipt.
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
          // How many files a message carries is what the daemon and the provider accept.
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
 * Request of `driver.subscribeEvents`: one run's driver event stream. The reply is the shared
 * `SubscribeAckResponse`, with events arriving as later `$/subscription/notify` frames.
 */
export interface DriverSubscribeEventsParams {
  runId: RunId;
}

/** Validates a {@link DriverSubscribeEventsParams}. */
export const DriverSubscribeEventsParamsSchema: z.ZodType<
  DriverSubscribeEventsParams,
  DriverSubscribeEventsParams
> = z.object({ runId: RunIdSchema }).strict();

// ---- Session-addressed requests ----

// Neither request names a binding, which is the daemon's own routing state: the session is the
// scope both check first, and the run or agent is resolved within it.

/**
 * Request of `driver.compactContext`, the person's compaction of one run's context. The reply's
 * `refused` and `failed` arms are data a caller branches on, never a JSON-RPC error.
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
 * Request of `driver.listProviderCommands`: the commands and skills one agent's providers publish,
 * one group per live binding the agent holds.
 */
export interface ListProviderCommandsRequest {
  sessionId: SessionId;
  // Not the branded `AgentId`: `agent/definition.ts`, which owns it, imports this file.
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

/** Validates a {@link ProviderCommandBindingGroup} on the reply. */
export const ProviderCommandBindingGroupSchema: z.ZodType<
  ProviderCommandBindingGroup,
  ProviderCommandBindingGroup
> = z
  .object({
    // `null`, never absent, when the binding has no live run or more than one.
    runId: RunIdSchema.nullable(),
    binding: ProviderCommandBindingSchema,
    // The provider-side cap, not `DRIVER_WIRE_CATALOG_ENTRIES_MAX`: a list the driver already
    // truncated to it must still parse.
    entries: z.array(ProviderCommandEntrySchema).max(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX),
    complete: z.boolean(),
  })
  .strict();

/**
 * Validates a {@link ProviderCommandListResult}. It holds at least one group, since an agent with
 * no live binding is refused as `driver.unavailable`; the group count is the daemon's own and is
 * not capped.
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

// `driver.subscribeEvents` is in the table in `provider/driver/event.ts`: its emission is the
// session event.

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
