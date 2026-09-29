// The machine-wide service settings on Settings › Runtime, and the two package
// caches whose size limit is one of them.
//
// Each value is set in this one place. A value that is not a port or not a size
// is refused by the request's shape, with nothing written. A port already taken
// is saved all the same: the listener's own state says nothing is listening,
// and the service never moves to another port.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";

/** `Stop a run after`'s steps, in minutes; `null` is `No limit`. */
export type RunTimeLimitMinutes = 30 | 60 | 240 | 720 | 1440;
export const RUN_TIME_LIMIT_MINUTES: readonly RunTimeLimitMinutes[] = Object.freeze([
  30, 60, 240, 720, 1440,
]);

/** `Ask me after one start leads to`'s steps, in runs; `null` is `Never ask`. */
export type WorkflowChainAskAfterRuns = 25 | 100 | 500 | 2000;
export const WORKFLOW_CHAIN_ASK_AFTER_RUNS_STEPS: readonly WorkflowChainAskAfterRuns[] =
  Object.freeze([25, 100, 500, 2000]);

/** The longest file path the settings name. */
export const DAEMON_CONFIG_PATH_MAX_LEN = 4_096;

const SizeBytesSchema = z.number().int().positive();

const WRITABLE_CONFIG_MEMBER_SCHEMAS = {
  workflowListenerPort: z.number().int().min(1).max(65_535),
  runTimeLimitMinutes: z.literal(RUN_TIME_LIMIT_MINUTES).nullable(),
  workflowChainAskAfterRuns: z.literal(WORKFLOW_CHAIN_ASK_AFTER_RUNS_STEPS).nullable(),
  maxStepsPerTurn: z.number().int().positive().nullable(),
  toolMemoryCapBytes: SizeBytesSchema.nullable(),
  packageCacheLimitBytes: SizeBytesSchema.nullable(),
  recordTraces: z.boolean(),
  recordReplayLog: z.boolean(),
};

/** The settings a person changes, one per press. */
export interface DaemonConfigSettings {
  /** The port a workflow started by a web request listens on. */
  workflowListenerPort: number;
  /** `Stop a run after`; `null` is `No limit`. */
  runTimeLimitMinutes: RunTimeLimitMinutes | null;
  /** How many runs one start may lead to before the next asks; `null` is `Never ask`. */
  workflowChainAskAfterRuns: WorkflowChainAskAfterRuns | null;
  /** `Max steps per turn`; `null` is `Unlimited`, each provider's own behavior. */
  maxStepsPerTurn: number | null;
  /** `Memory cap for tool processes`; `null` is no cap. */
  toolMemoryCapBytes: number | null;
  /** `Cache limit`, applied to each package cache on its own; `null` is `Unlimited`. */
  packageCacheLimitBytes: number | null;
  /** `Record traces`. */
  recordTraces: boolean;
  /** `Record an event-replay log`. */
  recordReplayLog: boolean;
}

/** The settings, and the two facts the page draws beside them. */
export interface DaemonConfig extends DaemonConfigSettings {
  /** Whether this operating system lets the service enforce the memory cap. */
  toolMemoryCapEnforceable: boolean;
  /** The file the event-replay log is written to. */
  replayLogPath: string;
}
/** Parses a {@link DaemonConfig}. */
export const DaemonConfigSchema: z.ZodType<DaemonConfig> = z
  .object({
    ...WRITABLE_CONFIG_MEMBER_SCHEMAS,
    toolMemoryCapEnforceable: z.boolean(),
    replayLogPath: z.string().min(1).max(DAEMON_CONFIG_PATH_MAX_LEN),
  })
  .strict();

/** `daemon.configRead` takes nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonConfigReadRequest {}
/** Parses a {@link DaemonConfigReadRequest}. */
export const DaemonConfigReadRequestSchema: z.ZodType<
  DaemonConfigReadRequest,
  DaemonConfigReadRequest
> = z.object({}).strict();

/** `daemon.configUpdate`: exactly one setting. */
export type DaemonConfigUpdateRequest = {
  [Member in keyof DaemonConfigSettings]?: DaemonConfigSettings[Member] | undefined;
};
/** Parses a {@link DaemonConfigUpdateRequest}: one setting, never none and never two. */
export const DaemonConfigUpdateRequestSchema: z.ZodType<
  DaemonConfigUpdateRequest,
  DaemonConfigUpdateRequest
> = z
  .object(WRITABLE_CONFIG_MEMBER_SCHEMAS)
  .partial()
  .strict()
  .refine(
    (request) => Object.values(request).filter((setting) => setting !== undefined).length === 1,
    { message: "A config update carries exactly one setting." },
  );

/** The two package caches workflow steps install from. */
export type PackageCache = "bun" | "uv";

/** One cache's size, read by walking its folder when asked. */
export interface PackageCacheReading {
  bytes: number;
  readAt: string;
}

/** `daemon.packageCacheRead` takes nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonPackageCacheReadRequest {}
/** Parses a {@link DaemonPackageCacheReadRequest}. */
export const DaemonPackageCacheReadRequestSchema: z.ZodType<
  DaemonPackageCacheReadRequest,
  DaemonPackageCacheReadRequest
> = z.object({}).strict();

/** Each cache's size and when it was read; the page adds the total. */
export type DaemonPackageCacheReading = Record<PackageCache, PackageCacheReading>;
const PackageCacheReadingSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    readAt: z.iso.datetime({ offset: true }),
  })
  .strict();
/** Parses a {@link DaemonPackageCacheReading}. */
export const DaemonPackageCacheReadingSchema: z.ZodType<DaemonPackageCacheReading> = z
  .object({ bun: PackageCacheReadingSchema, uv: PackageCacheReadingSchema })
  .strict();

/** Which cache a clear empties. */
export type PackageCacheClearTarget = PackageCache | "all";
export const PACKAGE_CACHE_CLEAR_TARGETS: readonly PackageCacheClearTarget[] = Object.freeze([
  "bun",
  "uv",
  "all",
]);

/**
 * `daemon.packageCacheClear`. A clear waits for the installs using that cache,
 * never removes a step already installed, and answers with the new reading.
 */
export interface DaemonPackageCacheClearRequest {
  cache: PackageCacheClearTarget;
}
/** Parses a {@link DaemonPackageCacheClearRequest}. */
export const DaemonPackageCacheClearRequestSchema: z.ZodType<
  DaemonPackageCacheClearRequest,
  DaemonPackageCacheClearRequest
> = z.object({ cache: z.enum(PACKAGE_CACHE_CLEAR_TARGETS) }).strict();

/** The config and package-cache verbs' descriptors. */
export interface DaemonConfigMethodDescriptors {
  readonly "daemon.configRead": MethodDescriptor<
    "daemon.configRead",
    DaemonConfigReadRequest,
    DaemonConfig
  > & { readonly procedureType: "query" };
  readonly "daemon.configUpdate": MethodDescriptor<
    "daemon.configUpdate",
    DaemonConfigUpdateRequest,
    DaemonConfig
  > & { readonly procedureType: "mutation" };
  readonly "daemon.packageCacheRead": MethodDescriptor<
    "daemon.packageCacheRead",
    DaemonPackageCacheReadRequest,
    DaemonPackageCacheReading
  > & { readonly procedureType: "query" };
  readonly "daemon.packageCacheClear": MethodDescriptor<
    "daemon.packageCacheClear",
    DaemonPackageCacheClearRequest,
    DaemonPackageCacheReading
  > & { readonly procedureType: "mutation" };
}
export const DAEMON_CONFIG_METHOD_DESCRIPTORS: DaemonConfigMethodDescriptors =
  defineMethodDescriptors({
    "daemon.configRead": {
      method: "daemon.configRead",
      procedureType: "query",
      mutating: false,
      requestSchema: DaemonConfigReadRequestSchema,
      responseSchema: DaemonConfigSchema,
    },
    "daemon.configUpdate": {
      method: "daemon.configUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonConfigUpdateRequestSchema,
      responseSchema: DaemonConfigSchema,
    },
    "daemon.packageCacheRead": {
      method: "daemon.packageCacheRead",
      procedureType: "query",
      mutating: false,
      requestSchema: DaemonPackageCacheReadRequestSchema,
      responseSchema: DaemonPackageCacheReadingSchema,
    },
    "daemon.packageCacheClear": {
      method: "daemon.packageCacheClear",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonPackageCacheClearRequestSchema,
      responseSchema: DaemonPackageCacheReadingSchema,
    },
  });
