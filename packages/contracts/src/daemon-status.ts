// `daemon.status.read`: the service's own facts, in one reply that Settings ›
// Runtime and `sidekicks daemon status` both render; and `daemon.crashList`,
// the crash reports this machine keeps.
//
// The processor and memory figures are read when this is called and stamped
// with the time each was taken; nothing samples them on a timer, so `Check
// again` is simply another call.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";

/** Where the service is in its own life. */
export type DaemonProcessState = "running" | "starting" | "stopping" | "degraded";
export const DAEMON_PROCESS_STATES: readonly DaemonProcessState[] = Object.freeze([
  "running",
  "starting",
  "stopping",
  "degraded",
]);

/** The longest path or free-form text the status carries. */
export const DAEMON_STATUS_TEXT_MAX_LEN = 4_096;

const StatusTextSchema = z.string().min(1).max(DAEMON_STATUS_TEXT_MAX_LEN);
const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

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

/** Where the approval rules the service evaluates with came from. */
export type ApprovalRulesSource = "built_in" | "update";
export const APPROVAL_RULES_SOURCES: readonly ApprovalRulesSource[] = Object.freeze([
  "built_in",
  "update",
]);

/** The signed bundle of approval rules the service runs. */
export interface DaemonApprovalRules {
  /** The bundle's number, which only ever rises. */
  version: number;
  builtAt: string;
  source: ApprovalRulesSource;
}

/** What scans an incoming file on this machine: the machine's antivirus through AMSI, or nothing. */
export type DaemonFileScanning = "amsi" | "none";
export const DAEMON_FILE_SCANNING_KINDS: readonly DaemonFileScanning[] = Object.freeze([
  "amsi",
  "none",
]);

/**
 * The terminal's sidecar binary refused at spawn because its hash did not match
 * the release manifest's entry.
 */
export interface DaemonSidecarHashMismatch {
  path: string;
  expectedSha256: string;
  actualSha256: string;
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

/** Everything a status surface prints, in one reply. */
export interface DaemonStatusReadResponse {
  processState: DaemonProcessState;
  /** The service's own version. */
  version: string;
  protocolVersion: string;
  transportEndpoint: string;
  startedAt: string;
  uptimeMs: number;
  /** The data directory this service holds; a second service cannot hold it. */
  dataDirectory: string;
  processor: DaemonProcessorReading;
  memory: DaemonMemoryReading;
  approvalRules: DaemonApprovalRules;
  fileScanning: DaemonFileScanning;
  /** The sidecar refused at its last spawn, or `null` when none was. */
  sidecarHashMismatch: DaemonSidecarHashMismatch | null;
  relay?: DaemonRelayStatus | undefined;
}

/** Parses a {@link DaemonStatusReadResponse}. */
export const DaemonStatusReadResponseSchema: z.ZodType<DaemonStatusReadResponse> = z
  .object({
    processState: z.enum(DAEMON_PROCESS_STATES),
    version: StatusTextSchema,
    protocolVersion: StatusTextSchema,
    transportEndpoint: StatusTextSchema,
    startedAt: TimestampSchema,
    uptimeMs: z.number().int().nonnegative(),
    dataDirectory: StatusTextSchema,
    processor: z.object({ percent: z.number().min(0).max(100), readAt: TimestampSchema }).strict(),
    memory: z
      .object({ residentBytes: z.number().int().nonnegative(), readAt: TimestampSchema })
      .strict(),
    approvalRules: z
      .object({
        version: z.number().int().positive(),
        builtAt: TimestampSchema,
        source: z.enum(APPROVAL_RULES_SOURCES),
      })
      .strict(),
    fileScanning: z.enum(DAEMON_FILE_SCANNING_KINDS),
    sidecarHashMismatch: z
      .object({
        path: StatusTextSchema,
        expectedSha256: Sha256HexSchema,
        actualSha256: Sha256HexSchema,
      })
      .strict()
      .nullable(),
    relay: z
      .object({
        devices: z.array(
          z
            .object({
              name: StatusTextSchema,
              connected: z.boolean(),
              lastFrameOutAgeMs: z.number().int().nonnegative().optional(),
              lastFrameInAgeMs: z.number().int().nonnegative().optional(),
              reconnectCount: z.number().int().nonnegative(),
              rejectedFrameCount: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        pinRefused: z.boolean(),
      })
      .strict()
      .optional(),
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
          crashedAt: TimestampSchema,
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
                  offset: z.number().int().nonnegative(),
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
  > & { readonly procedureType: "query" };
  readonly "daemon.crashList": MethodDescriptor<
    "daemon.crashList",
    DaemonCrashListRequest,
    DaemonCrashListResponse
  > & { readonly procedureType: "query" };
}
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
