// Backups of what the person would lose with the disk: reading where they stand, starting
// one now, the events a run records, and each backup's manifest.
//
// A restore replaces the service's own store, so it runs with the service stopped and reads
// each manifest straight from the folder; that is why the manifest's shape is a contract.
// A backup is a plain copy that holds no key, so any computer can restore it.
//
// This file imports nothing from the event registry, which imports it.
import { z } from "zod";

import { ERROR_MESSAGE_MAX_LEN } from "../error.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "../method-descriptor.js";
import { ReleaseVersionSchema } from "../release-manifest.js";
import { ServicePlaceLocationSchema, type ServicePlaceLocation } from "../service-place.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/**
 * The manifest's file name, beside each backup's database copy.
 *
 * @consumedBy the daemon's backups, which write a manifest beside each copy
 */
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

// The manifest

/**
 * What a backup records about itself: when it was taken, the app and service
 * versions that wrote it, its size and the computer that wrote it. On a Windows
 * computer it also names the side that wrote it, Windows or a WSL distribution,
 * so a restore on the other side rewrites its stored paths into that side's form.
 */
export interface BackupManifest {
  backupId: BackupId;
  takenAt: string;
  appVersion: string;
  serviceVersion: string;
  totalBytes: number;
  computerName: string;
  place?: ServicePlaceLocation | undefined;
}
/** Parses a {@link BackupManifest}. */
export const BackupManifestSchema: z.ZodType<BackupManifest> = z
  .object({
    backupId: BackupIdSchema,
    takenAt: isoDateTimeSchema,
    appVersion: ReleaseVersionSchema,
    serviceVersion: ReleaseVersionSchema,
    totalBytes: countSchema,
    computerName: wireFreeFormString(BACKUP_LABEL_MAX_LEN, "BackupManifest.computerName"),
    place: ServicePlaceLocationSchema.optional(),
  })
  .strict();

// daemon.backupRead

/** One backup in the folder, as `Restore…` lists it. */
export interface BackupListEntry {
  backupId: BackupId;
  takenAt: string;
  totalBytes: number;
  appVersion: string;
  computerName: string;
}
const BackupListEntrySchema: z.ZodType<BackupListEntry> = z
  .object({
    backupId: BackupIdSchema,
    takenAt: isoDateTimeSchema,
    totalBytes: countSchema,
    appVersion: ReleaseVersionSchema,
    computerName: wireFreeFormString(BACKUP_LABEL_MAX_LEN, "BackupListEntry.computerName"),
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
  z.object({ outcome: z.literal("completed"), finishedAt: isoDateTimeSchema }).strict(),
  z
    .object({
      outcome: z.literal("failed"),
      finishedAt: isoDateTimeSchema,
      message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "BackupLastRun.message"),
    })
    .strict(),
]);

/**
 * Where the backups stand: the folder and whether it sits on the service's own
 * disk, the folder's total size, the last run (`null` before the first) and
 * every backup in the folder.
 */
export interface BackupReadResponse {
  folder: string;
  folderOnServiceDisk: boolean;
  totalBytes: number;
  lastRun: BackupLastRun | null;
  backups: BackupListEntry[];
}
/** Parses a {@link BackupReadResponse}. */
export const BackupReadResponseSchema: z.ZodType<BackupReadResponse> = z
  .object({
    folder: wireFreeFormString(FILE_PATH_MAX_LEN, "BackupReadResponse.folder"),
    folderOnServiceDisk: z.boolean(),
    totalBytes: countSchema,
    lastRun: BackupLastRunSchema.nullable(),
    backups: z.array(BackupListEntrySchema),
  })
  .strict();

// Events, recorded on the service's own session

/** `backup.completed`: a run wrote a backup. */
export interface BackupCompletedPayload {
  backupId: BackupId;
  totalBytes: number;
}
/** Parses a {@link BackupCompletedPayload}. */
export const BackupCompletedPayloadSchema: z.ZodType<BackupCompletedPayload> = z
  .object({ backupId: BackupIdSchema, totalBytes: countSchema })
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

// The methods

/** The backup methods, keyed by method name. */
export interface DaemonBackupMethodDescriptors {
  readonly "daemon.backupRead": MethodDescriptor<
    "daemon.backupRead",
    EmptyPayload,
    BackupReadResponse
  >;
  readonly "daemon.backupStart": MethodDescriptor<"daemon.backupStart", EmptyPayload, EmptyPayload>;
}

/**
 * The backup methods. A run started now reports its end through the `backup.*` events.
 *
 * @consumedBy the daemon's `daemon.backupRead` and `daemon.backupStart` handlers
 */
export const DAEMON_BACKUP_METHOD_DESCRIPTORS: DaemonBackupMethodDescriptors =
  defineMethodDescriptors({
    "daemon.backupRead": {
      method: "daemon.backupRead",
      procedureType: "query",
      mutating: false,
      requestSchema: EmptyPayloadSchema,
      responseSchema: BackupReadResponseSchema,
    },
    "daemon.backupStart": {
      method: "daemon.backupStart",
      procedureType: "mutation",
      mutating: true,
      requestSchema: EmptyPayloadSchema,
      responseSchema: EmptyPayloadSchema,
    },
  });
