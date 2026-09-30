// Undo: the dry run a person reads before anything moves, the undo itself (with edit and resend
// as the same call), the event every undo settles with, and the list of a session's snapshots.
//
// An undo goes back to a stable point: one of the person's own messages, named by its cursor in
// the session's history, or one of the session's snapshots. A numeric or provider position never
// appears here. The conversation is cut with the provider's own verb and the files are put back
// from the daemon's own checkpoints, so a dry run and an undo name the same three choices: the
// conversation and the files, the conversation alone, or the files alone.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { ArtifactIdSchema, type ArtifactId } from "./provider-driver.js";
import {
  DRIVER_WIRE_STEER_ATTACHMENTS_MAX,
  DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
} from "./provider-driver-wire.js";
import {
  EventCursorSchema,
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  wireFreeFormString,
  type EventCursor,
  type SessionId,
} from "./session.js";

/** The longest snapshot id the daemon accepts. */
export const SNAPSHOT_ID_MAX_LEN = 256;

/** The daemon-minted id of one of a session's snapshots. Opaque to every client. */
export type SnapshotId = string & { readonly __brand: "SnapshotId" };
/** Parses a {@link SnapshotId}: a non-empty string up to {@link SNAPSHOT_ID_MAX_LEN}. */
export const SnapshotIdSchema: z.ZodType<SnapshotId, SnapshotId> = z
  .string()
  .min(1)
  .max(SNAPSHOT_ID_MAX_LEN)
  .brand<"SnapshotId">() as unknown as z.ZodType<SnapshotId, SnapshotId>;

/** Asks for a session's snapshots. A chat session has none. */
export interface SessionSnapshotListRequest {
  sessionId: SessionId;
}
/** Parses a {@link SessionSnapshotListRequest}. */
export const SessionSnapshotListRequestSchema: z.ZodType<
  SessionSnapshotListRequest,
  SessionSnapshotListRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/** One snapshot: its id, the name the inspector shows (`Before <turn>`), and when it was taken. */
export interface SessionSnapshotSummary {
  snapshotId: SnapshotId;
  name: string;
  createdAt: string;
}

/** A session's snapshots. */
export interface SessionSnapshotListResponse {
  snapshots: SessionSnapshotSummary[];
}
/** Parses a {@link SessionSnapshotListResponse}. */
export const SessionSnapshotListResponseSchema: z.ZodType<SessionSnapshotListResponse> = z
  .object({
    snapshots: z.array(
      z
        .object({
          snapshotId: SnapshotIdSchema,
          name: z.string().min(1),
          createdAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    ),
  })
  .strict();

/** The point an undo goes back to: before one of the person's messages, or a snapshot. */
export type SessionRestoreTarget =
  | { kind: "message"; anchorCursor: EventCursor }
  | { kind: "snapshot"; snapshotId: SnapshotId };
const SessionRestoreTargetSchema: z.ZodType<SessionRestoreTarget, SessionRestoreTarget> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("message"), anchorCursor: EventCursorSchema }).strict(),
    z.object({ kind: z.literal("snapshot"), snapshotId: SnapshotIdSchema }).strict(),
  ]);

/** What an undo is asked to put back. */
export type SessionRestoreScope = "conversation-and-files" | "conversation" | "files";

/** One part an undo puts back on its own. */
export type SessionRestorePart = Exclude<SessionRestoreScope, "conversation-and-files">;

const SessionRestoreScopeSchema: z.ZodType<SessionRestoreScope, SessionRestoreScope> = z.enum([
  "conversation-and-files",
  "conversation",
  "files",
]);

/**
 * Why a file is skipped rather than put back:
 *
 * - `symbolic_link`, `hard_link`, `not_a_regular_file`: the path is not a plain file.
 * - `directory_moved`: the folder that held it moved.
 * - `too_large`: a file over 10 MiB a command changed, on a disk that cannot clone it, so no
 *   copy of it was kept.
 * - `branch_moved_by_command`: a command that moved the branch (a commit, a checkout, a reset, a
 *   pull) changed it; putting it back would turn the branch's commits into uncommitted reversals.
 */
export const SESSION_RESTORE_SKIP_REASONS = [
  "symbolic_link",
  "hard_link",
  "not_a_regular_file",
  "directory_moved",
  "too_large",
  "branch_moved_by_command",
] as const;
/** One of {@link SESSION_RESTORE_SKIP_REASONS}. */
export type SessionRestoreSkipReason = (typeof SESSION_RESTORE_SKIP_REASONS)[number];

/** A file an undo leaves as it is, and why. A skip is always named and never stops the undo. */
export interface SessionRestoreSkippedFile {
  path: string;
  reason: SessionRestoreSkipReason;
}
const SessionRestoreSkippedFileSchema: z.ZodType<SessionRestoreSkippedFile> = z
  .object({
    path: z.string().min(1).max(FILE_PATH_MAX_LEN),
    reason: z.enum(SESSION_RESTORE_SKIP_REASONS),
  })
  .strict();

/** Paths another session working in the same folder also changed since the point. */
export interface SessionRestoreAlsoChanged {
  sessionId: SessionId;
  paths: string[];
}

/** Asks what an undo would do, and changes nothing. */
export interface SessionRestorePreviewRequest {
  sessionId: SessionId;
  target: SessionRestoreTarget;
  scope: SessionRestoreScope;
}
/** Parses a {@link SessionRestorePreviewRequest}. */
export const SessionRestorePreviewRequestSchema: z.ZodType<
  SessionRestorePreviewRequest,
  SessionRestorePreviewRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    target: SessionRestoreTargetSchema,
    scope: SessionRestoreScopeSchema,
  })
  .strict();

/**
 * What an undo would do. `fileCount` and `lineCount` are the files it would put back and the
 * lines across them. `affectedChildCount` and `runningCommands` count the agents and commands
 * started after the point that are still running, which the undo stops first. `ignoredFolders`
 * and `commandsRanAfterPoint` feed the notice shown whenever a command ran after the point: the
 * folders the project ignores are never put back, and neither is what a command wrote outside
 * the working folder. `alsoChangedBy` names the paths in this undo another session changed since
 * the point; they are left as they are unless the undo includes them.
 */
export interface SessionRestorePreviewResponse {
  fileCount: number;
  lineCount: number;
  skipped: SessionRestoreSkippedFile[];
  affectedChildCount: number;
  runningCommands: number;
  ignoredFolders: string[];
  commandsRanAfterPoint: boolean;
  alsoChangedBy: SessionRestoreAlsoChanged[];
}
/** Parses a {@link SessionRestorePreviewResponse}. */
export const SessionRestorePreviewResponseSchema: z.ZodType<SessionRestorePreviewResponse> = z
  .object({
    fileCount: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    skipped: z.array(SessionRestoreSkippedFileSchema),
    affectedChildCount: z.number().int().nonnegative(),
    runningCommands: z.number().int().nonnegative(),
    ignoredFolders: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)),
    commandsRanAfterPoint: z.boolean(),
    alsoChangedBy: z.array(
      z
        .object({
          sessionId: SessionIdSchema,
          paths: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)),
        })
        .strict(),
    ),
  })
  .strict();

/** The edited message an edit and resend sends once the undo has applied, with its files. */
export interface SessionRestoreResend {
  content: string;
  attachments?: ArtifactId[] | undefined;
}

/**
 * Undoes to a point, and with `resend` sends an edited message from there in the same call, so a
 * cut conversation is never left with nothing sent unremarked. `clientIdempotencyKey` is unique
 * within the session, so a retried undo never cuts twice. `includeAlsoChanged` puts back the
 * paths another session also changed since the point; it is false unless the person asked.
 * `resend` goes only with the conversation and the files together, as `Undo to here` does.
 */
export interface SessionRestoreRequest {
  sessionId: SessionId;
  target: SessionRestoreTarget;
  scope: SessionRestoreScope;
  clientIdempotencyKey: string;
  includeAlsoChanged: boolean;
  resend?: SessionRestoreResend | undefined;
}
/** Parses a {@link SessionRestoreRequest}; a `resend` at a narrower scope is refused. */
export const SessionRestoreRequestSchema: z.ZodType<SessionRestoreRequest, SessionRestoreRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      target: SessionRestoreTargetSchema,
      scope: SessionRestoreScopeSchema,
      clientIdempotencyKey: z.uuid(),
      includeAlsoChanged: z.boolean(),
      resend: z
        .object({
          content: wireFreeFormString(DRIVER_WIRE_STEER_CONTENT_MAX_LEN, "resend.content"),
          attachments: z.array(ArtifactIdSchema).max(DRIVER_WIRE_STEER_ATTACHMENTS_MAX).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine(
      (request) => request.resend === undefined || request.scope === "conversation-and-files",
      {
        message: "An edit and resend puts back the conversation and the files together.",
        path: ["resend"],
      },
    );

// One undo has one result: what was asked, what went back, the files it actually put back, and
// the daemon's reason for each asked-for part that did not. An undo can land in part: the
// conversation cut can apply while the files cannot go back, or the reverse; `restored:
// "nothing"` means both are as they were. When an edit and resend's undo applied and its send did
// not, the result says so with the send's reason.

/** Why one asked-for part did not go back, in the daemon's words. */
export interface SessionRestoreFailure {
  reason: string;
}
const SessionRestoreFailureSchema: z.ZodType<SessionRestoreFailure> = z
  .object({ reason: z.string().min(1) })
  .strict();

/**
 * What the files part of an undo actually did: the files it put back, the lines across them, and
 * every file it skipped with the reason. These are the undo's own figures, not the dry run's,
 * because the folder can change between the two.
 */
export interface SessionRestoreFileOutcome {
  restoredFileCount: number;
  restoredLineCount: number;
  skipped: SessionRestoreSkippedFile[];
}

/**
 * A finished undo: what was asked, what went back, and why each other asked-for part did not.
 * `files` is present exactly when the files went back.
 */
export interface SessionRestoreFinished {
  outcome: "restore-finished";
  requested: SessionRestoreScope;
  restored: SessionRestoreScope | "nothing";
  files?: SessionRestoreFileOutcome | undefined;
  failures?: { [Part in SessionRestorePart]?: SessionRestoreFailure | undefined } | undefined;
}

/** An edit and resend whose undo applied and whose send failed, with the send's reason. */
export interface SessionResendUnapplied {
  outcome: "resend-unapplied";
  reason: string;
}

/** What an undo, or an edit and resend, reports. */
export type SessionRestoreResult = SessionRestoreFinished | SessionResendUnapplied;

/** Parses a {@link SessionRestoreResult}. */
export const SessionRestoreResultSchema: z.ZodType<SessionRestoreResult> = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("restore-finished"),
        requested: SessionRestoreScopeSchema,
        restored: z.enum(["conversation-and-files", "conversation", "files", "nothing"]),
        files: z
          .object({
            restoredFileCount: z.number().int().nonnegative(),
            restoredLineCount: z.number().int().nonnegative(),
            skipped: z.array(SessionRestoreSkippedFileSchema),
          })
          .strict()
          .optional(),
        failures: z
          .object({
            conversation: SessionRestoreFailureSchema.optional(),
            files: SessionRestoreFailureSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine(
        (finished) =>
          (finished.files !== undefined) ===
          (finished.restored === "files" || finished.restored === "conversation-and-files"),
        {
          path: ["files"],
          message: "The files outcome is present exactly when the files went back.",
        },
      ),
    z.object({ outcome: z.literal("resend-unapplied"), reason: z.string().min(1) }).strict(),
  ],
);

/** The event an undo settles with, whatever it managed to do. */
export const SESSION_RESTORE_FINISHED_EVENT = "session.restore_finished" as const;

/**
 * The payload of {@link SESSION_RESTORE_FINISHED_EVENT}: one stored record per undo, carrying its
 * result. The conversation cut is also recorded by the run's own rolled-back event, which covers
 * the conversation alone.
 */
export interface SessionRestoreFinishedPayload {
  sessionId: SessionId;
  target: SessionRestoreTarget;
  result: SessionRestoreResult;
}
/** Parses a {@link SessionRestoreFinishedPayload}. */
export const SessionRestoreFinishedPayloadSchema: z.ZodType<SessionRestoreFinishedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    target: SessionRestoreTargetSchema,
    result: SessionRestoreResultSchema,
  })
  .strict();

/** The undo methods, keyed by method name. */
export interface SessionRestoreMethodDescriptors {
  readonly "session.restorePreview": MethodDescriptor<
    "session.restorePreview",
    SessionRestorePreviewRequest,
    SessionRestorePreviewResponse
  >;
  readonly "session.restore": MethodDescriptor<
    "session.restore",
    SessionRestoreRequest,
    SessionRestoreResult
  >;
  readonly "session.snapshotList": MethodDescriptor<
    "session.snapshotList",
    SessionSnapshotListRequest,
    SessionSnapshotListResponse
  >;
}

/** The undo methods, each with its schemas. */
export const SESSION_RESTORE_METHOD_DESCRIPTORS: SessionRestoreMethodDescriptors =
  defineMethodDescriptors({
    "session.restorePreview": {
      method: "session.restorePreview",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionRestorePreviewRequestSchema,
      responseSchema: SessionRestorePreviewResponseSchema,
    },
    "session.restore": {
      method: "session.restore",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionRestoreRequestSchema,
      responseSchema: SessionRestoreResultSchema,
    },
    "session.snapshotList": {
      method: "session.snapshotList",
      procedureType: "query",
      mutating: false,
      requestSchema: SessionSnapshotListRequestSchema,
      responseSchema: SessionSnapshotListResponseSchema,
    },
  });
