// `daemon.status.read`: the service's own facts in one reply, and `daemon.crashList`: the
// crash reports this machine keeps. Processor and memory figures are read when called and
// stamped with the time taken; nothing samples them on a timer.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "../method-descriptor.js";
import { ProcessIdentitySchema, type ProcessIdentity } from "../process-identity.js";
import { ReleaseVersionSchema } from "../release-manifest.js";
import { FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/** Where the service is in its own life. */
export type DaemonProcessState = "running" | "starting" | "stopping" | "degraded";
/** Every {@link DaemonProcessState}. */
export const DAEMON_PROCESS_STATES: readonly DaemonProcessState[] = Object.freeze([
  "running",
  "starting",
  "stopping",
  "degraded",
]);

/** The longest free-form text the status carries. */
export const DAEMON_STATUS_TEXT_MAX_LEN = 4_096;

const StatusTextSchema = z.string().min(1).max(DAEMON_STATUS_TEXT_MAX_LEN);
const StatusPathSchema = z.string().min(1).max(FILE_PATH_MAX_LEN);

/** How much of the machine's processor the service and every process it started use. */
export interface DaemonProcessorReading {
  /** A share of the whole machine's processor, from 0 to 100. */
  percent: number;
  readAt: string;
}

/** How much memory the service and every process it started hold. */
export interface DaemonMemoryReading {
  residentBytes: number;
  readAt: string;
}

/** One linked device as the relay last saw it, counted since the service started. */
export interface DaemonRelayDevice {
  name: string;
  connected: boolean;
  /** How long ago the last frame went out; absent when none has. */
  lastFrameOutAgeMs?: number | undefined;
  /** How long ago the last frame came in; absent when none has. */
  lastFrameInAgeMs?: number | undefined;
  reconnectCount: number;
  rejectedFrameCount: number;
}

/** The relay block, present only while a relay is configured. */
export interface DaemonRelayStatus {
  devices: DaemonRelayDevice[];
  /** The pinned relay presented a key other than the one pinned when it was linked. */
  pinRefused: boolean;
}

/** `daemon.status.read` takes nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonStatusReadRequest {}
/** Parses a {@link DaemonStatusReadRequest}. */
export const DaemonStatusReadRequestSchema: z.ZodType<
  DaemonStatusReadRequest,
  DaemonStatusReadRequest
> = z.object({}).strict();

/** Everything a status reader prints, in one reply. */
export interface DaemonStatusReadResponse {
  processState: DaemonProcessState;
  /**
   * The service's own process as the system knows it, by which a client that found it running
   * ends it and never a process that took over its id.
   */
  processIdentity: ProcessIdentity;
  /** The service's own version. */
  version: string;
  protocolVersion: string;
  transportEndpoint: string;
  startedAt: string;
  uptimeMs: number;
  /** The data directory this service holds; a second service cannot hold it. */
  dataDirectory: string;
  /** `null` when the reading could not be taken at this call. */
  processor: DaemonProcessorReading | null;
  /** `null` when the reading could not be taken at this call. */
  memory: DaemonMemoryReading | null;
  relay?: DaemonRelayStatus | undefined;
  /**
   * The file the service keeps its secrets in, readable only by the person: present only on
   * Linux where no Secret Service answers.
   */
  secretsFile?: string | undefined;
}

/** Parses a {@link DaemonStatusReadResponse}. */
export const DaemonStatusReadResponseSchema: z.ZodType<DaemonStatusReadResponse> = z
  .object({
    processState: z.enum(DAEMON_PROCESS_STATES),
    processIdentity: ProcessIdentitySchema,
    version: ReleaseVersionSchema,
    protocolVersion: StatusTextSchema,
    transportEndpoint: StatusTextSchema,
    startedAt: isoDateTimeSchema,
    uptimeMs: countSchema,
    dataDirectory: StatusPathSchema,
    processor: z
      .object({ percent: z.number().min(0).max(100), readAt: isoDateTimeSchema })
      .strict()
      .nullable(),
    memory: z.object({ residentBytes: countSchema, readAt: isoDateTimeSchema }).strict().nullable(),
    relay: z
      .object({
        devices: z.array(
          z
            .object({
              name: StatusTextSchema,
              connected: z.boolean(),
              lastFrameOutAgeMs: countSchema.optional(),
              lastFrameInAgeMs: countSchema.optional(),
              reconnectCount: countSchema,
              rejectedFrameCount: countSchema,
            })
            .strict(),
        ),
        pinRefused: z.boolean(),
      })
      .strict()
      .optional(),
    secretsFile: StatusPathSchema.optional(),
  })
  .strict();

/** The most frames a report keeps of the crashing thread's stack. */
export const CRASH_REPORT_STACK_MAX_FRAMES = 256;

/**
 * One frame of the crashing thread's stack: the module's file name, never its
 * path, and the offset into it.
 */
export interface CrashStackFrame {
  module: string;
  offset: number;
}

/**
 * A report the service built on this machine from a crash's dump, with personal
 * data stripped: file paths cut to their names and session ids replaced by
 * stable hashes. The dump itself never leaves the machine.
 */
export interface CrashReport {
  crashedAt: string;
  /** The crashed process's type as the crash dump records it, such as `renderer`. */
  processType: string;
  appVersion: string;
  serviceVersion: string;
  platform: string;
  stack: CrashStackFrame[];
}

/** `daemon.crashList` takes nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonCrashListRequest {}
/** Parses a {@link DaemonCrashListRequest}. */
export const DaemonCrashListRequestSchema: z.ZodType<
  DaemonCrashListRequest,
  DaemonCrashListRequest
> = z.object({}).strict();

/** The reports this machine keeps, newest first; kept as long as its diagnostic logs. */
export interface DaemonCrashListResponse {
  reports: CrashReport[];
}
/** Parses a {@link DaemonCrashListResponse}. */
export const DaemonCrashListResponseSchema: z.ZodType<DaemonCrashListResponse> = z
  .object({
    reports: z.array(
      z
        .object({
          crashedAt: isoDateTimeSchema,
          processType: StatusTextSchema,
          appVersion: StatusTextSchema,
          serviceVersion: StatusTextSchema,
          platform: StatusTextSchema,
          stack: z
            .array(
              z
                .object({
                  module: z
                    .string()
                    .min(1)
                    .max(DAEMON_STATUS_TEXT_MAX_LEN)
                    .refine((module) => !/[\\/]/.test(module), {
                      message: "A stack frame names its module's file, never a path.",
                    }),
                  offset: countSchema,
                })
                .strict(),
            )
            .max(CRASH_REPORT_STACK_MAX_FRAMES),
        })
        .strict(),
    ),
  })
  .strict();

/** The status read's and the crash list's descriptors. */
export interface DaemonStatusMethodDescriptors {
  readonly "daemon.status.read": MethodDescriptor<
    "daemon.status.read",
    DaemonStatusReadRequest,
    DaemonStatusReadResponse
  >;
  readonly "daemon.crashList": MethodDescriptor<
    "daemon.crashList",
    DaemonCrashListRequest,
    DaemonCrashListResponse
  >;
}

/** The status and crash-list methods' names, procedure types and shapes. */
export const DAEMON_STATUS_METHOD_DESCRIPTORS: DaemonStatusMethodDescriptors =
  defineMethodDescriptors({
    "daemon.status.read": {
      method: "daemon.status.read",
      procedureType: "query",
      mutating: false,
      requestSchema: DaemonStatusReadRequestSchema,
      responseSchema: DaemonStatusReadResponseSchema,
    },
    "daemon.crashList": {
      method: "daemon.crashList",
      procedureType: "query",
      mutating: false,
      requestSchema: DaemonCrashListRequestSchema,
      responseSchema: DaemonCrashListResponseSchema,
    },
  });
