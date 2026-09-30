// Backups of what the person would lose with the disk: reading where they stand,
// starting one now, the events a run records, and the manifest each backup
// carries.
//
// The service writes each backup into the folder the person chose. Settings ›
// Runtime reads them through `daemon.backupRead`. A restore replaces the
// service's own store, so it runs with the service stopped: the desktop app's
// main process or `sidekicks db restore` reads each backup's manifest straight
// from the folder, which is why the manifest's shape is a contract and not the
// service's alone.
//
// A backup is sealed with the master key named in its manifest. On the machine
// that wrote it, that key is in custody. Elsewhere it is found in the person's
// iCloud Keychain on a Mac, or opened with the recovery passphrase from a key
// envelope in the folder; a backup neither way reaches cannot be restored here.
//
// This file imports nothing from the event registry, which imports it.
import { z } from "zod";

import {
  BackupKeySyncStateSchema,
  DaemonEmptyPayloadSchema,
  MasterKeyIdSchema,
  type BackupKeySyncState,
  type DaemonEmptyPayload,
  type MasterKeyId,
} from "./daemon-data.js";
import { ERROR_MESSAGE_MAX_LEN } from "./error.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { ReleaseVersionSchema } from "./release-manifest.js";
import { ServicePlaceLocationSchema, type ServicePlaceLocation } from "./service-place.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./session.js";

/** The manifest's file name, beside each backup's database copy. */
export const BACKUP_MANIFEST_FILE_NAME = "manifest.json";

/** The longest backup id or computer name accepted. */
export const BACKUP_LABEL_MAX_LEN = 256;

/** One backup's id, minted by the service when it writes the backup. Opaque to every client. */
export type BackupId = string & { readonly __brand: "BackupId" };
/** Parses a {@link BackupId}. */
export const BackupIdSchema: z.ZodType<BackupId, BackupId> = wireFreeFormString(
  BACKUP_LABEL_MAX_LEN,
  "BackupId",
).brand<"BackupId">() as unknown as z.ZodType<BackupId, BackupId>;

// --------------------------------------------------------------------------
// The manifest
// --------------------------------------------------------------------------

/**
 * What a backup records about itself: when it was taken, the app and service
 * versions that wrote it, its size, the computer that wrote it and the id of the
 * master key it was sealed with. On a Windows computer it also names the side
 * that wrote it, Windows or a WSL distribution, so a restore on the other side
 * rewrites its stored paths into that side's form.
 */
export interface BackupManifest {
  backupId: BackupId;
  takenAt: string;
  appVersion: string;
  serviceVersion: string;
  totalBytes: number;
  computerName: string;
  masterKeyId: MasterKeyId;
  place?: ServicePlaceLocation | undefined;
}
/** Parses a {@link BackupManifest}. */
export const BackupManifestSchema: z.ZodType<BackupManifest> = z
  .object({
    backupId: BackupIdSchema,
    takenAt: z.iso.datetime({ offset: true }),
    appVersion: ReleaseVersionSchema,
    serviceVersion: ReleaseVersionSchema,
    totalBytes: z.number().int().nonnegative(),
    computerName: wireFreeFormString(BACKUP_LABEL_MAX_LEN, "BackupManifest.computerName"),
    masterKeyId: MasterKeyIdSchema,
    place: ServicePlaceLocationSchema.optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// daemon.backupRead
// --------------------------------------------------------------------------

/**
 * Whether this computer can restore a backup: `ready` when the key it was sealed
 * with is here, `needsRecoveryPassphrase` when only a key envelope in the folder
 * opens it, and `unavailable` when neither way reaches the key, so only the
 * computer that wrote it can open it.
 */
export type BackupRestoreAccess = "ready" | "needsRecoveryPassphrase" | "unavailable";
/** Parses a {@link BackupRestoreAccess}. */
export const BackupRestoreAccessSchema: z.ZodType<BackupRestoreAccess> = z.enum([
  "ready",
  "needsRecoveryPassphrase",
  "unavailable",
]);

/** One backup in the folder, as `Restore…` lists it. */
export interface BackupListEntry {
  backupId: BackupId;
  takenAt: string;
  totalBytes: number;
  appVersion: string;
  computerName: string;
  restoreAccess: BackupRestoreAccess;
}
const BackupListEntrySchema: z.ZodType<BackupListEntry> = z
  .object({
    backupId: BackupIdSchema,
    takenAt: z.iso.datetime({ offset: true }),
    totalBytes: z.number().int().nonnegative(),
    appVersion: ReleaseVersionSchema,
    computerName: wireFreeFormString(BACKUP_LABEL_MAX_LEN, "BackupListEntry.computerName"),
    restoreAccess: BackupRestoreAccessSchema,
  })
  .strict();

/**
 * How the last backup run ended: `completed`, or `failed` with the service's own
 * words for the cause. A failed run keeps the backups already there.
 */
export type BackupLastRun =
  | { outcome: "completed"; finishedAt: string }
  | { outcome: "failed"; finishedAt: string; message: string };
const BackupLastRunSchema: z.ZodType<BackupLastRun> = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("completed"), finishedAt: z.iso.datetime({ offset: true }) })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      finishedAt: z.iso.datetime({ offset: true }),
      message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "BackupLastRun.message"),
    })
    .strict(),
]);

/**
 * Where the backups stand: the folder and whether it sits on the service's own
 * disk, the folder's total size, the last run (`null` before the first), every
 * backup in the folder, whether a recovery passphrase is set, and, on a Mac
 * only, whether the backups' key is kept in iCloud Keychain.
 */
export interface BackupReadResponse {
  folder: string;
  folderOnServiceDisk: boolean;
  totalBytes: number;
  lastRun: BackupLastRun | null;
  backups: BackupListEntry[];
  recoveryPassphrase: "set" | "notSet";
  keySync?: BackupKeySyncState | undefined;
}
/** Parses a {@link BackupReadResponse}. */
export const BackupReadResponseSchema: z.ZodType<BackupReadResponse> = z
  .object({
    folder: wireFreeFormString(FILE_PATH_MAX_LEN, "BackupReadResponse.folder"),
    folderOnServiceDisk: z.boolean(),
    totalBytes: z.number().int().nonnegative(),
    lastRun: BackupLastRunSchema.nullable(),
    backups: z.array(BackupListEntrySchema),
    recoveryPassphrase: z.enum(["set", "notSet"]),
    keySync: BackupKeySyncStateSchema.optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// Events, recorded on the service's own session
// --------------------------------------------------------------------------

/** `backup.completed`: a run wrote a backup. */
export interface BackupCompletedPayload {
  backupId: BackupId;
  totalBytes: number;
}
/** Parses a {@link BackupCompletedPayload}. */
export const BackupCompletedPayloadSchema: z.ZodType<BackupCompletedPayload> = z
  .object({ backupId: BackupIdSchema, totalBytes: z.number().int().nonnegative() })
  .strict();

/** `backup.failed`: a run did not finish, in the service's own words. */
export interface BackupFailedPayload {
  message: string;
}
/** Parses a {@link BackupFailedPayload}. */
export const BackupFailedPayloadSchema: z.ZodType<BackupFailedPayload> = z
  .object({ message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "BackupFailedPayload.message") })
  .strict();

/** `backup.restored`: the service started again from a backup. */
export interface BackupRestoredPayload {
  backupId: BackupId;
}
/** Parses a {@link BackupRestoredPayload}. */
export const BackupRestoredPayloadSchema: z.ZodType<BackupRestoredPayload> = z
  .object({ backupId: BackupIdSchema })
  .strict();

// --------------------------------------------------------------------------
// The methods
// --------------------------------------------------------------------------

/** The backup methods, keyed by method name. */
export interface DaemonBackupMethodDescriptors {
  readonly "daemon.backupRead": MethodDescriptor<
    "daemon.backupRead",
    DaemonEmptyPayload,
    BackupReadResponse
  >;
  readonly "daemon.backupStart": MethodDescriptor<
    "daemon.backupStart",
    DaemonEmptyPayload,
    DaemonEmptyPayload
  >;
}

/** The backup methods. A run started now reports its end through the `backup.*` events. */
export const DAEMON_BACKUP_METHOD_DESCRIPTORS: DaemonBackupMethodDescriptors =
  defineMethodDescriptors({
    "daemon.backupRead": {
      method: "daemon.backupRead",
      procedureType: "query",
      mutating: false,
      requestSchema: DaemonEmptyPayloadSchema,
      responseSchema: BackupReadResponseSchema,
    },
    "daemon.backupStart": {
      method: "daemon.backupStart",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonEmptyPayloadSchema,
      responseSchema: DaemonEmptyPayloadSchema,
    },
  });
