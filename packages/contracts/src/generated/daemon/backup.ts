// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Backups of what the person would lose with the disk: where they stand, starting one now, the events a run records, and each backup's manifest.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { DistroName } from "../place.js";
import type { ReleaseVersion } from "../release-manifest.js";

/** The longest backup id or computer name accepted, in code points. */
export const BACKUP_LABEL_MAX_LEN = 256 as const;

/**
 * One backup's id, minted by the service when it writes the backup. Opaque to every client.
 */
export type BackupId = string & { readonly __brand: "BackupId" };
/**
 * How the last backup run ended: `completed`, or `failed` with the service's own words for the
 * cause. A failed run keeps the backups already there.
 */
export type BackupLastRun =
  | {
      outcome: "completed";
      /**
       * When it finished.
       */
      finishedAt: WireInstant;
    }
  | {
      outcome: "failed";
      /**
       * When it stopped.
       */
      finishedAt: WireInstant;
      /**
       * The cause, in the service's own words.
       */
      message: string;
    };

/**
 * What a backup records about itself: when it was taken, the app and service versions that wrote
 * it, its size and the computer that wrote it. On a Windows computer it also names each WSL 2
 * distribution whose part it holds, so a restore writes each part back into the distribution of
 * that name and keeps a part whose distribution is not on the computer.
 */
export interface BackupManifest {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * When it was taken.
   */
  takenAt: WireInstant;
  /**
   * The app version that wrote it.
   */
  appVersion: ReleaseVersion;
  /**
   * The service version that wrote it.
   */
  serviceVersion: ReleaseVersion;
  /**
   * Its size in bytes.
   */
  totalBytes: number;
  /**
   * The computer that wrote it.
   */
  computerName: string;
  /**
   * The WSL 2 distributions whose parts it holds, by name; absent where it holds none.
   *
   * @minItems 1
   */
  distributionParts?: [DistroName, ...DistroName[]];
}
/**
 * One backup in the folder, as `Restore…` lists it.
 */
export interface BackupListEntry {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * When it was taken.
   */
  takenAt: WireInstant;
  /**
   * Its size in bytes.
   */
  totalBytes: number;
  /**
   * The app version that wrote it.
   */
  appVersion: ReleaseVersion;
  /**
   * The computer that wrote it.
   */
  computerName: string;
}
/**
 * Where the backups stand: the folder and whether it sits on the service's own disk, the
 * folder's total size, the last run (`null` before the first) and every backup in the folder.
 */
export interface DaemonBackupReadResponse {
  /**
   * The folder.
   */
  folder: string;
  /**
   * Whether the folder sits on the service's own disk.
   */
  folderOnServiceDisk: boolean;
  /**
   * The folder's total size in bytes.
   */
  totalBytes: number;
  /**
   * The last run, or `null` before the first.
   */
  lastRun: BackupLastRun | null;
  /**
   * Every backup in the folder.
   */
  backups: BackupListEntry[];
}
/**
 * `daemon.backup.completed`: a run wrote a backup.
 */
export interface DaemonBackupCompletedPayload {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * Its size in bytes.
   */
  totalBytes: number;
}
/**
 * `daemon.backup.failed`: a run did not finish, in the service's own words.
 */
export interface DaemonBackupFailedPayload {
  /**
   * The cause.
   */
  message: string;
}
/**
 * One WSL 2 distribution's part a restore kept in the backup, because no distribution of that
 * name is on this computer, with how many sessions it holds.
 */
export interface BackupKeptDistributionPart {
  /**
   * The distribution, by name.
   */
  distro: DistroName;
  /**
   * How many sessions the part holds.
   */
  sessionCount: number;
}
/**
 * `daemon.backup.restored`: the service started again from a backup, naming each distribution part
 * it kept in the backup.
 */
export interface DaemonBackupRestoredPayload {
  /**
   * The backup.
   */
  backupId: BackupId;
  /**
   * The distribution parts kept in the backup; absent where every part was written back.
   *
   * @minItems 1
   */
  keptDistributionParts?: [BackupKeptDistributionPart, ...BackupKeptDistributionPart[]];
}

export {
  validateBackupId,
  validateBackupKeptDistributionPart,
  validateDaemonBackupCompletedPayload,
  validateDaemonBackupFailedPayload,
  validateDaemonBackupRestoredPayload,
} from "../checks/daemon/backup.js";

/** The methods of {@link DAEMON_BACKUP_METHOD_DESCRIPTORS}, each with its kind. */
export interface DaemonBackupMethodDescriptors {
  readonly "daemon.backup.read": {
    readonly method: "daemon.backup.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "daemon.backup.start": {
    readonly method: "daemon.backup.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link DAEMON_BACKUP_METHOD_DESCRIPTORS}. */
export interface DaemonBackupMethodTypes {
  readonly "daemon.backup.read": {
    readonly params: EmptyPayload;
    readonly result: DaemonBackupReadResponse;
  };
  readonly "daemon.backup.start": { readonly params: EmptyPayload; readonly result: EmptyPayload };
}
/** The backup methods. A run started now reports its end through the `daemon.backup.*` events. */
export const DAEMON_BACKUP_METHOD_DESCRIPTORS: DaemonBackupMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "daemon.backup.read": /* @__PURE__ */ Object.freeze({
      method: "daemon.backup.read",
      procedureType: "query",
      mutating: false,
    }),
    "daemon.backup.start": /* @__PURE__ */ Object.freeze({
      method: "daemon.backup.start",
      procedureType: "mutation",
      mutating: true,
    }),
  });
