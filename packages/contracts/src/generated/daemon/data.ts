// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Everything the service keeps for the person: the data folder, and the two acts on it, export and erase.

import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { KeychainRefusalCause } from "../keychain.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { ProviderAccountId } from "../provider/account/record.js";
import type { ProviderId } from "../provider/id.js";

/**
 * The service's data folder, inside the person's home folder: its database, the machine's
 * settings and every other file it keeps.
 */
export const DAEMON_DATA_FOLDER_NAME = ".ai-sidekicks" as const;

/**
 * The id of one export job, minted by the service.
 */
export type DataExportJobId = string & { readonly __brand: "DataExportJobId" };
/**
 * Where an export stands, told apart by its `state`. A running export exports one session at a
 * time, so it counts sessions, never past its total.
 */
export type DataExportProgress =
  | {
      state: "running";
      /**
       * The sessions exported so far; never more than `sessionsTotal`.
       */
      sessionsExported: number;
      /**
       * The sessions the export holds.
       */
      sessionsTotal: number;
    }
  | {
      state: "completed";
      /**
       * The folder written.
       */
      path: string;
      /**
       * The sessions exported.
       */
      sessionsExported: number;
      /**
       * Its size in bytes.
       */
      totalBytes: number;
    }
  | {
      state: "failed";
      /**
       * The cause.
       */
      message: string;
    }
  | {
      state: "canceled";
      /**
       * The folder the export was writing.
       */
      path: string;
    };
/**
 * Why the erase left an account signed in with its provider: no registered provider runs its
 * sign-out (`noProvider`), the provider's own sign-out failed or was refused (`refused`), or it
 * did not end within its bound (`timedOut`).
 */
export type DataEraseSignOutFailure = "noProvider" | "refused" | "timedOut";
/**
 * How an account the erase left signed in stood on the account list: listed there (`listed`),
 * removed from it, its home kept (`removed`), or minted by a sign-in that did not finish, so it
 * never reached the list (`signInUnfinished`).
 */
export type DataEraseAccountListing = "listed" | "removed" | "signInUnfinished";

/**
 * Starts an export into a new folder. `destination` is the folder's path: the one the platform's
 * save dialog picked, which the desktop app's main process turns from its token into a path, or
 * the one typed on the command line.
 */
export interface DaemonDataExportStartRequest {
  /**
   * The new folder's path.
   */
  destination: string;
}
/**
 * The export job the request started; its progress streams on `daemon.dataExport.subscribe`.
 */
export interface DaemonDataExportStartResponse {
  /**
   * The job.
   */
  jobId: DataExportJobId;
}
/**
 * The export job whose progress to stream.
 */
export interface DaemonDataExportSubscribeRequest {
  /**
   * The job.
   */
  jobId: DataExportJobId;
}
/**
 * The export job to stop. A job already finished stays as it ended.
 */
export interface DaemonDataExportCancelRequest {
  /**
   * The job.
   */
  jobId: DataExportJobId;
}
/**
 * The details of `daemon.dataExport.alreadyRunning`: the export that runs now.
 */
export interface DaemonDataExportAlreadyRunningDetails {
  /**
   * The running job.
   */
  jobId: DataExportJobId;
}
/**
 * The details of `daemon.dataExport.destination.notWritable`: the folder that could not be made.
 */
export interface DaemonDataExportDestinationNotWritableDetails {
  /**
   * The folder.
   */
  path: string;
}
/**
 * The details of `daemon.data.storeUnavailable`: why the keychain the erase must empty could not
 * be used. The erase is refused before anything is erased, so it can be sent again.
 */
export interface DaemonDataStoreUnavailableDetails {
  /**
   * Why the keychain could not be used: `locked`, or it cannot be used (`unavailable`).
   */
  cause: KeychainRefusalCause;
}
/**
 * An account the erase could not sign out, which stays signed in with its provider once its home
 * is deleted.
 */
export interface DataEraseSignedInAccount {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * The account's provider, named here since a removed account has no row to name it.
   */
  provider: ProviderId;
  /**
   * How the account stood on the account list.
   */
  listing: DataEraseAccountListing;
  /**
   * Why it was not signed out.
   */
  cause: DataEraseSignOutFailure;
}
/**
 * The erase's answer, sent once every account's sign-out has ended and the sessions' folders on
 * other volumes were removed, and before the work stops; the rest of the erase follows it.
 */
export interface DaemonDataEraseResponse {
  /**
   * Each account left signed in with its provider, with why; empty when every one signed out.
   */
  signedInAccounts: DataEraseSignedInAccount[];
  /**
   * Whether the account list could not all be read: none was signed out where it could not be
   * read at all, and a row naming no valid account or provider id was left signed in while the
   * rest were signed out.
   */
  isAccountListUnread: boolean;
  /**
   * Each session's own folder on another volume that stays once the data folder is gone, its
   * volume not connected or its removal refused; empty when every one went.
   */
  volumeFoldersLeft: string[];
  /**
   * Whether the sessions' folders on other volumes could not be read, so none was removed.
   */
  isVolumeFolderListUnread: boolean;
}

/** The methods of {@link DAEMON_DATA_METHOD_DESCRIPTORS}, each with its kind. */
export interface DaemonDataMethodDescriptors {
  readonly "daemon.dataExport.start": {
    readonly method: "daemon.dataExport.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "daemon.dataExport.subscribe": {
    readonly method: "daemon.dataExport.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "daemon.dataExport.cancel": {
    readonly method: "daemon.dataExport.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "daemon.data.erase": {
    readonly method: "daemon.data.erase";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link DAEMON_DATA_METHOD_DESCRIPTORS}. */
export interface DaemonDataMethodTypes {
  readonly "daemon.dataExport.start": {
    readonly params: DaemonDataExportStartRequest;
    readonly result: DaemonDataExportStartResponse;
  };
  readonly "daemon.dataExport.subscribe": {
    readonly params: DaemonDataExportSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: DataExportProgress;
  };
  readonly "daemon.dataExport.cancel": {
    readonly params: DaemonDataExportCancelRequest;
    readonly result: EmptyPayload;
  };
  readonly "daemon.data.erase": {
    readonly params: EmptyPayload;
    readonly result: DaemonDataEraseResponse;
  };
}
/**
 * The data methods. The export stream's acknowledgment is the subscription, and each
 * emission is the job's progress as it changes.
 */
export const DAEMON_DATA_METHOD_DESCRIPTORS: DaemonDataMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "daemon.dataExport.start": /* @__PURE__ */ Object.freeze({
      method: "daemon.dataExport.start",
      procedureType: "mutation",
      mutating: true,
    }),
    "daemon.dataExport.subscribe": /* @__PURE__ */ Object.freeze({
      method: "daemon.dataExport.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "daemon.dataExport.cancel": /* @__PURE__ */ Object.freeze({
      method: "daemon.dataExport.cancel",
      procedureType: "mutation",
      mutating: true,
    }),
    "daemon.data.erase": /* @__PURE__ */ Object.freeze({
      method: "daemon.data.erase",
      procedureType: "mutation",
      mutating: true,
    }),
  });
