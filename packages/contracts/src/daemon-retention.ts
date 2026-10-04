// The two retention bounds on Settings › Runtime, and `Delete old data`. Only the service's
// diagnostic logs go on their own past a bound; a session is removed only by the purge, which the
// person confirms after reading the count, and a workflow run's step data stays until its run or
// its session is deleted.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

const DaysSchema = z.number().int().positive();

/** The two bounds, each in whole days. */
export interface DaemonRetentionBounds {
  /**
   * The service's own logs and, in each account home, what the provider writes
   * and never reads back for a session. Any period is taken as set.
   */
  keepDiagnosticLogsDays: number;
  /** How long a finished session stays before it can be deleted. */
  keepSessionsDays: number;
}
const RetentionBoundsObjectSchema = z
  .object({
    keepDiagnosticLogsDays: DaysSchema,
    keepSessionsDays: DaysSchema,
  })
  .strict();
/** Parses {@link DaemonRetentionBounds}. */
export const DaemonRetentionBoundsSchema: z.ZodType<DaemonRetentionBounds> =
  RetentionBoundsObjectSchema;

/** What `Delete old data` would remove if it ran now. */
export interface DaemonRetentionPurgePreview {
  archivedSessionCount: number;
  /** Sessions archived before this moment are the ones counted. */
  cutoffAt: string;
}

/** `daemon.retentionRead` takes nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonRetentionReadRequest {}
/** Parses a {@link DaemonRetentionReadRequest}. */
export const DaemonRetentionReadRequestSchema: z.ZodType<
  DaemonRetentionReadRequest,
  DaemonRetentionReadRequest
> = z.object({}).strict();

/** The bounds, and the count the purge's confirm names. */
export interface DaemonRetentionReadResponse extends DaemonRetentionBounds {
  purge: DaemonRetentionPurgePreview;
}
/** Parses a {@link DaemonRetentionReadResponse}. */
export const DaemonRetentionReadResponseSchema: z.ZodType<DaemonRetentionReadResponse> =
  RetentionBoundsObjectSchema.extend({
    purge: z
      .object({
        archivedSessionCount: countSchema,
        cutoffAt: isoDateTimeSchema,
      })
      .strict(),
  }).strict();

/** `daemon.retentionUpdate`: exactly one bound. Setting a bound deletes nothing. */
export interface DaemonRetentionUpdateRequest {
  keepDiagnosticLogsDays?: number | undefined;
  keepSessionsDays?: number | undefined;
}
/** Parses a {@link DaemonRetentionUpdateRequest}: one bound, never none and never two. */
export const DaemonRetentionUpdateRequestSchema: z.ZodType<
  DaemonRetentionUpdateRequest,
  DaemonRetentionUpdateRequest
> = RetentionBoundsObjectSchema.partial()
  .strict()
  .refine((request) => Object.values(request).filter((bound) => bound !== undefined).length === 1, {
    message: "A retention update carries exactly one bound.",
  });

/**
 * `daemon.retentionPurge`: the cutoff the confirm was read against, so the
 * purge removes exactly what the confirm named and a second press removes
 * nothing more.
 */
export interface DaemonRetentionPurgeRequest {
  cutoffAt: string;
}
/** Parses a {@link DaemonRetentionPurgeRequest}. */
export const DaemonRetentionPurgeRequestSchema: z.ZodType<
  DaemonRetentionPurgeRequest,
  DaemonRetentionPurgeRequest
> = z.object({ cutoffAt: isoDateTimeSchema }).strict();

/** How many sessions the purge removed. */
export interface DaemonRetentionPurgeResponse {
  deletedSessionCount: number;
}
/** Parses a {@link DaemonRetentionPurgeResponse}. */
export const DaemonRetentionPurgeResponseSchema: z.ZodType<DaemonRetentionPurgeResponse> = z
  .object({ deletedSessionCount: countSchema })
  .strict();

/** The retention verbs' descriptors. */
export interface DaemonRetentionMethodDescriptors {
  readonly "daemon.retentionRead": MethodDescriptor<
    "daemon.retentionRead",
    DaemonRetentionReadRequest,
    DaemonRetentionReadResponse
  >;
  readonly "daemon.retentionUpdate": MethodDescriptor<
    "daemon.retentionUpdate",
    DaemonRetentionUpdateRequest,
    DaemonRetentionBounds
  >;
  readonly "daemon.retentionPurge": MethodDescriptor<
    "daemon.retentionPurge",
    DaemonRetentionPurgeRequest,
    DaemonRetentionPurgeResponse
  >;
}

/**
 * The retention methods' names, procedure types and shapes.
 *
 * @consumedBy the daemon's retention handlers
 */
export const DAEMON_RETENTION_METHOD_DESCRIPTORS: DaemonRetentionMethodDescriptors =
  defineMethodDescriptors({
    "daemon.retentionRead": {
      method: "daemon.retentionRead",
      procedureType: "query",
      mutating: false,
      requestSchema: DaemonRetentionReadRequestSchema,
      responseSchema: DaemonRetentionReadResponseSchema,
    },
    "daemon.retentionUpdate": {
      method: "daemon.retentionUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonRetentionUpdateRequestSchema,
      responseSchema: DaemonRetentionBoundsSchema,
    },
    "daemon.retentionPurge": {
      method: "daemon.retentionPurge",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonRetentionPurgeRequestSchema,
      responseSchema: DaemonRetentionPurgeResponseSchema,
    },
  });
