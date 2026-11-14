// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Undo: the dry run, the undo itself with edit and resend, the event every undo settles with, and the list of a session's snapshots.

import type { AttachmentReferenceList } from "../artifacts/attachment-reference.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { QueuedSkillPick } from "../run/queue.js";
import type { EventCursor, SessionId } from "./id.js";

/**
 * The daemon-minted id of one of a session's snapshots. Opaque to every client.
 */
export type SnapshotId = string & { readonly __brand: "SnapshotId" };
/**
 * The point an undo goes back to: before one of the person's messages, or a snapshot.
 */
export type SessionRestoreTarget =
  | {
      kind: "message";
      /**
       * The message's cursor in the session's history.
       */
      anchorCursor: EventCursor;
    }
  | {
      kind: "snapshot";
      /**
       * The snapshot.
       */
      snapshotId: SnapshotId;
    };
/**
 * What an undo is asked to put back.
 */
export type SessionRestoreScope = "conversationAndFiles" | "conversation" | "files";
/**
 * One part an undo puts back on its own.
 */
export type SessionRestorePart = "conversation" | "files";
/**
 * What a finished undo put back: a scope, or nothing.
 */
export type SessionRestoredScope = "conversationAndFiles" | "conversation" | "files" | "nothing";
/**
 * Why a file is skipped rather than put back.
 */
export type SessionRestoreSkipReason =
  | "symbolicLink"
  | "hardLink"
  | "notARegularFile"
  | "directoryMoved"
  | "tooLarge"
  | "noPlaceOnVolume"
  | "branchMovedByCommand";
/**
 * What an undo, or an edit and resend, reports, split on `outcome`: a finished undo with what
 * was asked, what went back and the daemon's reason for every asked-for part that did not, or an
 * edit and resend whose undo applied and whose send failed.
 */
export type SessionRestoreOutcome =
  | {
      outcome: "restoreFinished";
      /**
       * What was asked.
       */
      requested: SessionRestoreScope;
      /**
       * What went back.
       */
      restored: SessionRestoredScope;
      /**
       * What the files part did, present exactly when the files went back.
       */
      files?: SessionRestoreFileOutcome;
      /**
       * The daemon's reason for each asked-for part that did not go back.
       */
      failures?: SessionRestoreFailures;
    }
  | {
      outcome: "resendUnapplied";
      /**
       * The send's reason.
       */
      reason: string;
    };

/**
 * Asks for a session's snapshots. A chat session has none.
 */
export interface SessionSnapshotListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One snapshot: its id, the name the inspector shows (`Before <turn>`), and when it was taken.
 */
export interface SessionSnapshotSummary {
  /**
   * The snapshot.
   */
  snapshotId: SnapshotId;
  /**
   * The name the inspector shows.
   */
  name: string;
  /**
   * When it was taken.
   */
  createdAt: WireInstant;
}
/**
 * A session's snapshots.
 */
export interface SessionSnapshotListResponse {
  /**
   * The snapshots.
   */
  snapshots: SessionSnapshotSummary[];
}
/**
 * A file an undo leaves as it is, and why. A skip is always named and never stops the undo.
 */
export interface SessionRestoreSkippedFile {
  /**
   * The file.
   */
  path: string;
  /**
   * Why it is skipped.
   */
  reason: SessionRestoreSkipReason;
}
/**
 * Paths another session working in the same folder also changed since the point.
 */
export interface SessionRestoreAlsoChanged {
  /**
   * The other session.
   */
  sessionId: SessionId;
  /**
   * The paths it changed.
   */
  paths: string[];
}
/**
 * Asks what an undo would do, and changes nothing.
 */
export interface SessionRestorePreviewRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The point to go back to.
   */
  target: SessionRestoreTarget;
  /**
   * What to put back.
   */
  scope: SessionRestoreScope;
}
/**
 * What an undo would do. `fileCount` and `lineCount` are the files it would put back and the
 * lines across them; `affectedChildCount` and `runningCommands` count the agents and commands
 * started after the point that are still running, which the undo stops first. `ignoredFolders`
 * and `commandsRanAfterPoint` feed the notice shown whenever a command ran after the point;
 * `alsoChangedBy` names the paths another session changed since the point.
 */
export interface SessionRestorePreviewResponse {
  /**
   * The files it would put back.
   */
  fileCount: number;
  /**
   * The lines across them.
   */
  lineCount: number;
  /**
   * The files it would skip.
   */
  skipped: SessionRestoreSkippedFile[];
  /**
   * The agents started after the point that are still running.
   */
  affectedChildCount: number;
  /**
   * The commands started after the point that are still running.
   */
  runningCommands: number;
  /**
   * The folders the project ignores, never put back.
   */
  ignoredFolders: string[];
  /**
   * Whether a command ran after the point.
   */
  commandsRanAfterPoint: boolean;
  /**
   * The paths other sessions changed since the point.
   */
  alsoChangedBy: SessionRestoreAlsoChanged[];
}
/**
 * The edited message an edit and resend sends once the undo has applied, with its files, the
 * skills picked for it and the output-speed level its turn alone runs at, as a send carries them.
 */
export interface SessionRestoreResend {
  /**
   * The edited message.
   */
  content: string;
  /**
   * Its files, where it has any.
   */
  attachments?: AttachmentReferenceList;
  /**
   * Each skill picked for it, in the order picked.
   */
  skills?: QueuedSkillPick[];
  /**
   * The output-speed level its turn alone runs at.
   */
  outputSpeedForTurn?: string;
}
/**
 * Undoes to a point, and with `resend` sends an edited message from there in the same call.
 * `clientIdempotencyKey` is unique within the session, so a retried undo never cuts twice.
 * `includeAlsoChanged` puts back the paths another session also changed since the point.
 * `resend` goes only with the conversation and the files together; a narrower scope is refused.
 */
export interface SessionRestoreRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The point to go back to.
   */
  target: SessionRestoreTarget;
  /**
   * What to put back.
   */
  scope: SessionRestoreScope;
  /**
   * The client's key for this undo.
   */
  clientIdempotencyKey: string;
  /**
   * Whether to put back the paths another session also changed.
   */
  includeAlsoChanged: boolean;
  /**
   * The edited message to send once the undo has applied.
   */
  resend?: SessionRestoreResend;
}
/**
 * Why one asked-for part did not go back, in the daemon's words.
 */
export interface SessionRestoreFailure {
  /**
   * The daemon's reason.
   */
  reason: string;
}
/**
 * The daemon's reason for each asked-for part that did not go back.
 */
export interface SessionRestoreFailures {
  /**
   * Why the conversation did not go back.
   */
  conversation?: SessionRestoreFailure;
  /**
   * Why the files did not go back.
   */
  files?: SessionRestoreFailure;
}
/**
 * What the files part of an undo actually did: the files it put back, the lines across them, and
 * every file it skipped with the reason. These are the undo's own figures, not the dry run's,
 * because the folder can change between the two.
 */
export interface SessionRestoreFileOutcome {
  /**
   * The files put back.
   */
  restoredFileCount: number;
  /**
   * The lines across them.
   */
  restoredLineCount: number;
  /**
   * The files skipped.
   */
  skipped: SessionRestoreSkippedFile[];
}
/**
 * The payload of `session.restore.completed`: one stored record per undo, carrying its result. The
 * conversation cut is also recorded by the run's own rolled-back event.
 */
export interface SessionRestoreCompletedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The point the undo went back to.
   */
  target: SessionRestoreTarget;
  /**
   * What it reported.
   */
  result: SessionRestoreOutcome;
}

export {
  validateSessionRestoreCompletedPayload,
  validateSessionRestoreFailure,
  validateSessionRestoreFailures,
  validateSessionRestoreFileOutcome,
  validateSessionRestoreOutcome,
  validateSessionRestoreScope,
  validateSessionRestoreSkipReason,
  validateSessionRestoreSkippedFile,
  validateSessionRestoreTarget,
  validateSessionRestoredScope,
  validateSnapshotId,
} from "../checks/session/restore.js";

/** The methods of {@link SESSION_RESTORE_METHOD_DESCRIPTORS}, each with its kind. */
export interface SessionRestoreMethodDescriptors {
  readonly "session.restore.preview": {
    readonly method: "session.restore.preview";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "session.restore": {
    readonly method: "session.restore";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.snapshot.list": {
    readonly method: "session.snapshot.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link SESSION_RESTORE_METHOD_DESCRIPTORS}. */
export interface SessionRestoreMethodTypes {
  readonly "session.restore.preview": {
    readonly params: SessionRestorePreviewRequest;
    readonly result: SessionRestorePreviewResponse;
  };
  readonly "session.restore": {
    readonly params: SessionRestoreRequest;
    readonly result: SessionRestoreOutcome;
  };
  readonly "session.snapshot.list": {
    readonly params: SessionSnapshotListRequest;
    readonly result: SessionSnapshotListResponse;
  };
}
/** The undo methods, each with its types. */
export const SESSION_RESTORE_METHOD_DESCRIPTORS: SessionRestoreMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.restore.preview": /* @__PURE__ */ Object.freeze({
      method: "session.restore.preview",
      procedureType: "query",
      mutating: false,
    }),
    "session.restore": /* @__PURE__ */ Object.freeze({
      method: "session.restore",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.snapshot.list": /* @__PURE__ */ Object.freeze({
      method: "session.snapshot.list",
      procedureType: "query",
      mutating: false,
    }),
  });
