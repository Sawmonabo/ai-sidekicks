// The service's acts on everything it keeps for the person and on the keys that read it:
// export, erase, unlock, key rotation, the recovery passphrase, and iCloud Keychain key sync.
// Settings › Runtime and the command line send the same verbs.
//
// Every passphrase member is write-only: it is on no response, event or log, and the service
// keeps none of them.
import { z } from "zod";

import { ERROR_MESSAGE_MAX_LEN } from "./error.js";
import { brandedUuidIdSchema } from "./internal/branded.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./session.js";

/** The longest passphrase accepted on the wire. */
export const DAEMON_PASSPHRASE_MAX_LEN = 1024;

const passphrase = (fieldLabel: string): z.ZodString =>
  wireFreeFormString(DAEMON_PASSPHRASE_MAX_LEN, fieldLabel);

/**
 * The id of a master key: 16 random bytes, written as 32 lowercase hex digits.
 * A backup's manifest names the key it was sealed with by this id, never the key.
 */
export type MasterKeyId = string & { readonly __brand: "MasterKeyId" };
/** Parses a {@link MasterKeyId}. */
export const MasterKeyIdSchema: z.ZodType<MasterKeyId, MasterKeyId> = z
  .string()
  .regex(/^[0-9a-f]{32}$/u, { message: "A master key id is 32 lowercase hex digits." })
  .brand<"MasterKeyId">() as unknown as z.ZodType<MasterKeyId, MasterKeyId>;

/** A request or result with no members. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonEmptyPayload {}
/** Parses a {@link DaemonEmptyPayload}; any member is refused. */
export const DaemonEmptyPayloadSchema: z.ZodType<DaemonEmptyPayload, DaemonEmptyPayload> = z
  .object({})
  .strict();

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
        sessionsExported: z.number().int().nonnegative(),
        sessionsTotal: z.number().int().nonnegative(),
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
        totalBytes: z.number().int().nonnegative(),
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

// Keys

/** The passphrase that opens the master key on a machine with no security chip and no keychain. */
export interface DaemonUnlockRequest {
  passphrase: string;
}
/** Parses a {@link DaemonUnlockRequest}. */
export const DaemonUnlockRequestSchema: z.ZodType<DaemonUnlockRequest, DaemonUnlockRequest> = z
  .object({ passphrase: passphrase("DaemonUnlockRequest.passphrase") })
  .strict();

/**
 * Replaces the master key. `passphrase` is the machine's passphrase, sent only
 * where the master key opens with one; `recoveryPassphrase` is the recovery
 * passphrase, sent only where one is set, so the new key's recovery envelope
 * can be written.
 */
export interface KeyRotateRequest {
  passphrase?: string | undefined;
  recoveryPassphrase?: string | undefined;
}
/** Parses a {@link KeyRotateRequest}. */
export const KeyRotateRequestSchema: z.ZodType<KeyRotateRequest, KeyRotateRequest> = z
  .object({
    passphrase: passphrase("KeyRotateRequest.passphrase").optional(),
    recoveryPassphrase: passphrase("KeyRotateRequest.recoveryPassphrase").optional(),
  })
  .strict();

/** Sets or changes the recovery passphrase every later backup's key envelope is wrapped under. */
export interface RecoveryPassphraseSetRequest {
  passphrase: string;
}
/** Parses a {@link RecoveryPassphraseSetRequest}. */
export const RecoveryPassphraseSetRequestSchema: z.ZodType<
  RecoveryPassphraseSetRequest,
  RecoveryPassphraseSetRequest
> = z.object({ passphrase: passphrase("RecoveryPassphraseSetRequest.passphrase") }).strict();

/** Turns keeping the backups' key in the person's iCloud Keychain on or off (a Mac only). */
export interface BackupKeySyncUpdateRequest {
  enabled: boolean;
}
/** Parses a {@link BackupKeySyncUpdateRequest}. */
export const BackupKeySyncUpdateRequestSchema: z.ZodType<
  BackupKeySyncUpdateRequest,
  BackupKeySyncUpdateRequest
> = z.object({ enabled: z.boolean() }).strict();

/**
 * Whether the backups' key is kept in iCloud Keychain. `refused` is a switch the
 * service could not turn on, with its own words for why.
 */
export type BackupKeySyncState =
  | { state: "on" }
  | { state: "off" }
  | { state: "refused"; reason: string };
/** Parses a {@link BackupKeySyncState}. */
export const BackupKeySyncStateSchema: z.ZodType<BackupKeySyncState> = z.discriminatedUnion(
  "state",
  [
    z.object({ state: z.literal("on") }).strict(),
    z.object({ state: z.literal("off") }).strict(),
    z
      .object({
        state: z.literal("refused"),
        reason: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "BackupKeySyncState.reason"),
      })
      .strict(),
  ],
);

// The methods

/** The data and key methods, keyed by method name. */
export interface DaemonDataMethodDescriptors {
  readonly "daemon.dataExport": MethodDescriptor<
    "daemon.dataExport",
    DataExportRequest,
    DataExportResponse
  >;
  readonly "daemon.dataExportSubscribe": SubscriptionMethodDescriptor<
    "daemon.dataExportSubscribe",
    DataExportSubscribeRequest,
    DataExportProgress,
    DataExportProgress
  >;
  readonly "daemon.dataErase": MethodDescriptor<
    "daemon.dataErase",
    DaemonEmptyPayload,
    DaemonEmptyPayload
  >;
  readonly "daemon.unlock": MethodDescriptor<
    "daemon.unlock",
    DaemonUnlockRequest,
    DaemonEmptyPayload
  >;
  readonly "daemon.keyRotate": MethodDescriptor<
    "daemon.keyRotate",
    KeyRotateRequest,
    DaemonEmptyPayload
  >;
  readonly "daemon.recoveryPassphraseSet": MethodDescriptor<
    "daemon.recoveryPassphraseSet",
    RecoveryPassphraseSetRequest,
    DaemonEmptyPayload
  >;
  readonly "daemon.backupKeySyncUpdate": MethodDescriptor<
    "daemon.backupKeySyncUpdate",
    BackupKeySyncUpdateRequest,
    BackupKeySyncState
  >;
}

/**
 * The data and key methods. The export stream's acknowledgement is the job's
 * progress as it stands when the subscription opens, and each emission after
 * it is the next change.
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
    responseSchema: DataExportProgressSchema,
    emissionSchema: DataExportProgressSchema,
  },
  "daemon.dataErase": {
    method: "daemon.dataErase",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DaemonEmptyPayloadSchema,
    responseSchema: DaemonEmptyPayloadSchema,
  },
  "daemon.unlock": {
    method: "daemon.unlock",
    procedureType: "mutation",
    mutating: true,
    requestSchema: DaemonUnlockRequestSchema,
    responseSchema: DaemonEmptyPayloadSchema,
  },
  "daemon.keyRotate": {
    method: "daemon.keyRotate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: KeyRotateRequestSchema,
    responseSchema: DaemonEmptyPayloadSchema,
  },
  "daemon.recoveryPassphraseSet": {
    method: "daemon.recoveryPassphraseSet",
    procedureType: "mutation",
    mutating: true,
    requestSchema: RecoveryPassphraseSetRequestSchema,
    responseSchema: DaemonEmptyPayloadSchema,
  },
  "daemon.backupKeySyncUpdate": {
    method: "daemon.backupKeySyncUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: BackupKeySyncUpdateRequestSchema,
    responseSchema: BackupKeySyncStateSchema,
  },
});
