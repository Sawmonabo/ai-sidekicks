// The service's acts on everything it keeps for the person: export and erase. Settings ›
// Runtime and the command line send the same verbs.
import { z } from "zod";

import { ERROR_MESSAGE_MAX_LEN } from "./error.js";
import { brandedUuidIdSchema } from "./internal/branded.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "./method-descriptor.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./session.js";
import { countSchema } from "./internal/wire-scalars.js";

// Export all data

/** The id of one export job, minted by the service. */
export type DataExportJobId = string & { readonly __brand: "DataExportJobId" };
/** Parses a {@link DataExportJobId}. */
export const DataExportJobIdSchema: z.ZodType<DataExportJobId, DataExportJobId> =
  brandedUuidIdSchema<DataExportJobId>("DataExportJobId");

/**
 * Starts an export into a new folder. `destination` is the folder's path: the
 * one the platform's save dialog picked, which the desktop app's main process
 * turns from its token into a path, or the one typed on the command line.
 */
export interface DataExportRequest {
  destination: string;
}
/** Parses a {@link DataExportRequest}. */
export const DataExportRequestSchema: z.ZodType<DataExportRequest, DataExportRequest> = z
  .object({ destination: wireFreeFormString(FILE_PATH_MAX_LEN, "DataExportRequest.destination") })
  .strict();

/** The export job the request started; its progress streams on `daemon.dataExportSubscribe`. */
export interface DataExportResponse {
  jobId: DataExportJobId;
}
/** Parses a {@link DataExportResponse}. */
export const DataExportResponseSchema: z.ZodType<DataExportResponse> = z
  .object({ jobId: DataExportJobIdSchema })
  .strict();

/** The export job whose progress to stream. */
export interface DataExportSubscribeRequest {
  jobId: DataExportJobId;
}
/** Parses a {@link DataExportSubscribeRequest}. */
export const DataExportSubscribeRequestSchema: z.ZodType<
  DataExportSubscribeRequest,
  DataExportSubscribeRequest
> = z.object({ jobId: DataExportJobIdSchema }).strict();

/**
 * Where an export stands. It exports one session at a time, so a running
 * export counts sessions; a finished one names the folder and its size; a
 * failed one carries the service's own words for the cause.
 */
export type DataExportProgress =
  | { state: "running"; sessionsExported: number; sessionsTotal: number }
  | { state: "completed"; path: string; totalBytes: number }
  | { state: "failed"; message: string };

/** Parses a {@link DataExportProgress}; a running export never counts past its total. */
export const DataExportProgressSchema: z.ZodType<DataExportProgress> = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("running"),
        sessionsExported: countSchema,
        sessionsTotal: countSchema,
      })
      .strict()
      .refine((progress) => progress.sessionsExported <= progress.sessionsTotal, {
        message: "sessionsExported cannot exceed sessionsTotal.",
        path: ["sessionsExported"],
      }),
    z
      .object({
        state: z.literal("completed"),
        path: wireFreeFormString(FILE_PATH_MAX_LEN, "DataExportProgress.path"),
        totalBytes: countSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("failed"),
        message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "DataExportProgress.message"),
      })
      .strict(),
  ],
);

// The methods

/** The data methods, keyed by method name. */
export interface DaemonDataMethodDescriptors {
  readonly "daemon.dataExport": MethodDescriptor<
    "daemon.dataExport",
    DataExportRequest,
    DataExportResponse
  >;
  readonly "daemon.dataExportSubscribe": SubscriptionMethodDescriptor<
    "daemon.dataExportSubscribe",
    DataExportSubscribeRequest,
    SubscribeAckResponse,
    DataExportProgress
  >;
  readonly "daemon.dataErase": MethodDescriptor<"daemon.dataErase", EmptyPayload, EmptyPayload>;
}

/**
 * The data methods. The export stream's acknowledgement is the subscription,
 * and each emission is the job's progress as it changes.
 */
export const DAEMON_DATA_METHOD_DESCRIPTORS: DaemonDataMethodDescriptors = defineMethodDescriptors({
  "daemon.dataExport": {
    method: "daemon.dataExport",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DataExportRequestSchema,
    responseSchema: DataExportResponseSchema,
  },
  "daemon.dataExportSubscribe": {
    method: "daemon.dataExportSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: DataExportSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: DataExportProgressSchema,
  },
  "daemon.dataErase": {
    method: "daemon.dataErase",
    procedureType: "mutation",
    mutating: true,
    requestSchema: EmptyPayloadSchema,
    responseSchema: EmptyPayloadSchema,
  },
});
