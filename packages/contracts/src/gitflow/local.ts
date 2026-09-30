// What local git answers, for the git-flow contract: a branch's ship facts, the
// review pane's diff (a session's changes, its branch, one change request, or a
// workflow run between two snapshot points), the ship acts with their preview and
// progress, Generate, and the payload of `git.settled`, the one event that records a
// commit, a push, a pull, an opened change request or a posted review.
//
// This module imports nothing that reaches `../event.js`: `event.ts` imports
// `GitSettledPayloadSchema` from here, and a cycle among module-scope zod schemas
// throws at load time.
import { z } from "zod";

import { uuidTextFormSchema } from "../internal/branded.js";
import { countSchema } from "../internal/wire-scalars.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN, RunIdSchema, type RunId } from "../provider-driver.js";
import { GitObjectIdSchema, type GitObjectId } from "../repo-git-reads.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "../session.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "../workflow-run.js";
import {
  ChangeRequestSummarySchema,
  GIT_HOST_KINDS,
  REVIEW_SUBMIT_VERDICTS,
  type ChangeRequestSummary,
  type GitHostKind,
  type ReviewSubmitVerdict,
} from "./hosting.js";
import {
  ChangeRequestNumberSchema,
  GitRefNameSchema,
  GitShortObjectIdSchema,
  HostingAddressSchema,
  timestampSchema,
} from "./shared.js";

/** The id of one running or finished git act. The daemon mints it. */
export type GitActId = string & { readonly __brand: "GitActId" };
/** Wire schema for {@link GitActId}. */
export const GitActIdSchema: z.ZodType<GitActId, GitActId> = z
  .string()
  .min(1)
  .brand<"GitActId">() as unknown as z.ZodType<GitActId, GitActId>;

// --------------------------------------------------------------------------
// Closed sets
// --------------------------------------------------------------------------

/** The half-finished git operations that stop a commit until they are ended. */
export const PENDING_GIT_OPERATION_KINDS = ["merge", "rebase", "bisect"] as const;
/** One half-finished operation. */
export type PendingGitOperationKind = (typeof PENDING_GIT_OPERATION_KINDS)[number];

/** Where one command of a running act stands. */
export const GIT_ACT_COMMAND_STATES = ["pending", "running", "done", "failed"] as const;
/** One command state. */
export type GitActCommandState = (typeof GIT_ACT_COMMAND_STATES)[number];

/** What happened to a file between the two sides of a diff. A copy reads `added`. */
export const DIFF_FILE_KINDS = ["added", "deleted", "renamed", "modified"] as const;
/** One file kind. */
export type DiffFileKind = (typeof DIFF_FILE_KINDS)[number];

/** Why a changed file's contents cannot be shown. */
export const DIFF_FILE_UNREADABLE_REASONS = [
  "too_large",
  "permission_denied",
  "not_regular_file",
] as const;
/** One reason a file cannot be shown. */
export type DiffFileUnreadableReason = (typeof DIFF_FILE_UNREADABLE_REASONS)[number];

// --------------------------------------------------------------------------
// Refusal codes
// --------------------------------------------------------------------------

/**
 * Generating a commit message or a change request's text failed. The provider's own
 * words travel in the details, and nothing falls back to the other provider.
 */
export const GITFLOW_GENERATE_FAILED_CODE = "gitflow.generate_failed" as const;
/** The code string of {@link GITFLOW_GENERATE_FAILED_CODE}. */
export type GitflowGenerateFailedCode = typeof GITFLOW_GENERATE_FAILED_CODE;
/** The details of a {@link GITFLOW_GENERATE_FAILED_CODE} refusal. */
export interface GitflowGenerateFailedDetails {
  providerFailureDetail: string;
}
/** Wire schema for {@link GitflowGenerateFailedDetails}. */
export const GitflowGenerateFailedDetailsSchema: z.ZodType<GitflowGenerateFailedDetails> = z
  .object({
    providerFailureDetail: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "GitflowGenerateFailedDetails.providerFailureDetail",
    ),
  })
  .strict();

/**
 * A read the review pane depends on still failed after the daemon's one retry, so the
 * pane shows its own error state and keeps what it already drew.
 */
export const GITFLOW_READ_FAILED_CODE = "gitflow.read_failed" as const;
/** The code string of {@link GITFLOW_READ_FAILED_CODE}. */
export type GitflowReadFailedCode = typeof GITFLOW_READ_FAILED_CODE;

// --------------------------------------------------------------------------
// Branch facts
// --------------------------------------------------------------------------

/** A half-finished merge, rebase or bisect, with the command that ends it. */
export interface PendingGitOperation {
  kind: PendingGitOperationKind;
  endCommand: string;
}

/**
 * The `gitflow.branchContextRead` result: the branch's ship facts, which also carry
 * what the change-request form opens with (base, head, whether it pushes first, and
 * the host kind whose word the form prints).
 *
 * `neverLeftMachine` is true while the branch has never been pushed, so opening a
 * change request pushes it first. `countsAsOf` is when the background fetch that
 * `behindBase` comes from last succeeded. `hostKind` is absent where the daemon
 * cannot say which service the remote is. `changeRequests` lists the branch's
 * requests newest first.
 */
export interface GitflowBranchContextReadResponse {
  headBranch: string;
  baseBranch: string;
  defaultBranch: string;
  upstreamRef?: string | undefined;
  uncommittedFileCount: number;
  aheadOfBase: number;
  behindBase: number;
  unpushedCommitCount: number;
  neverLeftMachine: boolean;
  pendingOperation?: PendingGitOperation | undefined;
  changeRequests: ChangeRequestSummary[];
  hostKind?: GitHostKind | undefined;
  countsAsOf?: string | undefined;
}
/** Wire schema for {@link GitflowBranchContextReadResponse}. */
export const GitflowBranchContextReadResponseSchema: z.ZodType<GitflowBranchContextReadResponse> = z
  .object({
    headBranch: GitRefNameSchema,
    baseBranch: GitRefNameSchema,
    defaultBranch: GitRefNameSchema,
    upstreamRef: GitRefNameSchema.optional(),
    uncommittedFileCount: countSchema,
    aheadOfBase: countSchema,
    behindBase: countSchema,
    unpushedCommitCount: countSchema,
    neverLeftMachine: z.boolean(),
    pendingOperation: z
      .object({
        kind: z.enum(PENDING_GIT_OPERATION_KINDS),
        endCommand: z.string().min(1),
      })
      .strict()
      .optional(),
    changeRequests: z.array(ChangeRequestSummarySchema),
    hostKind: z.enum(GIT_HOST_KINDS).optional(),
    countsAsOf: timestampSchema.optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// The diff
// --------------------------------------------------------------------------

/**
 * One of a workflow run's snapshot points: its start, an approval pause, or its end,
 * within one execution of the run (each re-execution opens the next epoch).
 */
export type WorkflowRunSnapshotPoint =
  | { epoch: number; point: "start" }
  | { epoch: number; point: "pause"; pauseNumber: number }
  | { epoch: number; point: "end" };
const epochSchema = z.number().int().nonnegative();
const WorkflowRunSnapshotPointSchema: z.ZodType<
  WorkflowRunSnapshotPoint,
  WorkflowRunSnapshotPoint
> = z.discriminatedUnion("point", [
  z.object({ epoch: epochSchema, point: z.literal("start") }).strict(),
  z
    .object({
      epoch: epochSchema,
      point: z.literal("pause"),
      pauseNumber: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ epoch: epochSchema, point: z.literal("end") }).strict(),
]);

/**
 * The `gitflow.diffRead` input, one arm per comparison. `changes` is the working
 * folder against its last commit, untracked files included. `branch` is the branch
 * against `base` (absent: the daemon's default base), narrowed to one commit by
 * `commitId`. `change_request` is one of the branch's change requests. `workflow_run`
 * is what a workflow run changed between two of its snapshot points.
 */
export type GitflowDiffReadRequest =
  | { sessionId: SessionId; scope: "changes" }
  | {
      sessionId: SessionId;
      scope: "branch";
      base?: string | undefined;
      commitId?: GitObjectId | undefined;
    }
  | { sessionId: SessionId; scope: "change_request"; changeRequestNumber: number }
  | {
      sessionId: SessionId;
      scope: "workflow_run";
      workflowRunId: WorkflowRunId;
      from: WorkflowRunSnapshotPoint;
      to: WorkflowRunSnapshotPoint;
    };
/** Wire schema for {@link GitflowDiffReadRequest}. */
export const GitflowDiffReadRequestSchema: z.ZodType<
  GitflowDiffReadRequest,
  GitflowDiffReadRequest
> = z.discriminatedUnion("scope", [
  z.object({ sessionId: SessionIdSchema, scope: z.literal("changes") }).strict(),
  z
    .object({
      sessionId: SessionIdSchema,
      scope: z.literal("branch"),
      base: GitRefNameSchema.optional(),
      commitId: GitObjectIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      sessionId: SessionIdSchema,
      scope: z.literal("change_request"),
      changeRequestNumber: ChangeRequestNumberSchema,
    })
    .strict(),
  z
    .object({
      sessionId: SessionIdSchema,
      scope: z.literal("workflow_run"),
      workflowRunId: WorkflowRunIdSchema,
      from: WorkflowRunSnapshotPointSchema,
      to: WorkflowRunSnapshotPointSchema,
    })
    .strict(),
]);

/**
 * One changed path, composed into a single patch however many edits touched it.
 *
 * `oldPath` is present exactly when the file was renamed. `oldBlobId` and `newBlobId`
 * are git's blob ids for each side that exists. `binary` and `unreadable` say why the
 * lines are not shown; `patch` is the unified patch when they are. `newestTurn` is
 * the newest turn that touched the file, absent for a change made outside a turn;
 * on a workflow run's diff `stepId` names the step that changed it instead.
 */
export interface DiffFile {
  path: string;
  oldPath?: string | undefined;
  kind: DiffFileKind;
  modeChanged?: boolean | undefined;
  binary?: boolean | undefined;
  unreadable?: DiffFileUnreadableReason | undefined;
  additions: number;
  deletions: number;
  patch?: string | undefined;
  oldBlobId?: GitObjectId | undefined;
  newBlobId?: GitObjectId | undefined;
  newestTurn?: number | undefined;
  stepId?: string | undefined;
}
const DiffFileSchema: z.ZodType<DiffFile> = z
  .object({
    path: z.string().min(1),
    oldPath: z.string().min(1).optional(),
    kind: z.enum(DIFF_FILE_KINDS),
    modeChanged: z.boolean().optional(),
    binary: z.boolean().optional(),
    unreadable: z.enum(DIFF_FILE_UNREADABLE_REASONS).optional(),
    additions: countSchema,
    deletions: countSchema,
    patch: z.string().optional(),
    oldBlobId: GitObjectIdSchema.optional(),
    newBlobId: GitObjectIdSchema.optional(),
    newestTurn: z.number().int().positive().optional(),
    stepId: z.string().min(1).optional(),
  })
  .strict()
  .refine((file) => (file.kind === "renamed") === (file.oldPath !== undefined), {
    message: "oldPath is present exactly when the file was renamed",
    path: ["oldPath"],
  });

/**
 * One commit on the branch comparison. `agent` names the agent whose run made it,
 * read from the commit's run trailer; a commit without one is the person's.
 */
export interface DiffCommit {
  commitId: GitObjectId;
  shortId: string;
  subject: string;
  landedAt: string;
  agent?: { agentId: string; name: string } | undefined;
}
const DiffCommitSchema: z.ZodType<DiffCommit> = z
  .object({
    commitId: GitObjectIdSchema,
    shortId: GitShortObjectIdSchema,
    subject: z.string(),
    landedAt: timestampSchema,
    agent: z
      .object({ agentId: uuidTextFormSchema, name: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The `gitflow.diffRead` result. `head` and `base` name the two ends. `partial` is
 * true when the daemon cut the diff short at the size the machine can hold.
 * `commits` is present on the branch comparison.
 */
export interface GitflowDiffReadResponse {
  head: string;
  base: string;
  partial: boolean;
  files: DiffFile[];
  commits?: DiffCommit[] | undefined;
}
/** Wire schema for {@link GitflowDiffReadResponse}. */
export const GitflowDiffReadResponseSchema: z.ZodType<GitflowDiffReadResponse> = z
  .object({
    head: z.string().min(1),
    base: z.string().min(1),
    partial: z.boolean(),
    files: z.array(DiffFileSchema),
    commits: z.array(DiffCommitSchema).optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// Ship acts
// --------------------------------------------------------------------------

/**
 * The commit form. The subject has no length limit: its counter past 72 is a
 * reading, never a refusal.
 */
export interface CommitFormValues {
  subject: string;
  body?: string | undefined;
}
const CommitFormValuesSchema: z.ZodType<CommitFormValues, CommitFormValues> = z
  .object({ subject: z.string().min(1), body: z.string().optional() })
  .strict();

/** The change-request form: base branch, title, description, draft, reviewers and labels. */
export interface ChangeRequestFormValues {
  base: string;
  title: string;
  description: string;
  draft: boolean;
  reviewers: string[];
  labels: string[];
}
const ChangeRequestFormValuesSchema: z.ZodType<ChangeRequestFormValues, ChangeRequestFormValues> = z
  .object({
    base: GitRefNameSchema,
    title: z.string().min(1),
    description: z.string(),
    draft: z.boolean(),
    reviewers: z.array(z.string().min(1)),
    labels: z.array(z.string().min(1)),
  })
  .strict();

/**
 * One ship act with the values of its form. Push and pull have no form. The preview
 * and the execution take this one shape, so the commands shown before the press
 * are built by the code that runs them.
 */
export type GitActRequest =
  | { sessionId: SessionId; act: "commit"; formValues: CommitFormValues }
  | { sessionId: SessionId; act: "push" }
  | { sessionId: SessionId; act: "pull" }
  | { sessionId: SessionId; act: "open_change_request"; formValues: ChangeRequestFormValues };

function gitActRequestArms<Extra extends z.ZodRawShape>(extra: Extra) {
  return [
    z
      .object({
        sessionId: SessionIdSchema,
        act: z.literal("commit"),
        formValues: CommitFormValuesSchema,
        ...extra,
      })
      .strict(),
    z.object({ sessionId: SessionIdSchema, act: z.literal("push"), ...extra }).strict(),
    z.object({ sessionId: SessionIdSchema, act: z.literal("pull"), ...extra }).strict(),
    z
      .object({
        sessionId: SessionIdSchema,
        act: z.literal("open_change_request"),
        formValues: ChangeRequestFormValuesSchema,
        ...extra,
      })
      .strict(),
  ] as const;
}

/** The `gitflow.gitActionPreview` input. */
export type GitflowGitActionPreviewRequest = GitActRequest;
/** Wire schema for {@link GitflowGitActionPreviewRequest}. */
export const GitflowGitActionPreviewRequestSchema: z.ZodType<
  GitflowGitActionPreviewRequest,
  GitflowGitActionPreviewRequest
> = z.discriminatedUnion("act", gitActRequestArms({}));

/** The `gitflow.gitActionPreview` result: the exact commands the act will run, in order. */
export interface GitflowGitActionPreviewResponse {
  commands: string[];
}
/** Wire schema for {@link GitflowGitActionPreviewResponse}. */
export const GitflowGitActionPreviewResponseSchema: z.ZodType<GitflowGitActionPreviewResponse> = z
  .object({ commands: z.array(z.string().min(1)).min(1) })
  .strict();

/** The failed command of an earlier act that a retry runs again from. */
export interface GitActRetryPoint {
  actId: GitActId;
  commandIndex: number;
}

/**
 * The `gitflow.gitActionExecute` input. With `retryFromCommand`, the act resumes at
 * that failed command instead of starting over.
 */
export type GitflowGitActionExecuteRequest = GitActRequest & {
  retryFromCommand?: GitActRetryPoint | undefined;
};
/** Wire schema for {@link GitflowGitActionExecuteRequest}. */
export const GitflowGitActionExecuteRequestSchema: z.ZodType<
  GitflowGitActionExecuteRequest,
  GitflowGitActionExecuteRequest
> = z.discriminatedUnion(
  "act",
  gitActRequestArms({
    retryFromCommand: z
      .object({ actId: GitActIdSchema, commandIndex: z.number().int().nonnegative() })
      .strict()
      .optional(),
  }),
);

/**
 * The `gitflow.gitActionExecute` result: the act's id, whose progress
 * `gitflow.gitActionSubscribe` streams, and the commands it runs. A failed command
 * is a failed command on that stream, not an error reply.
 */
export interface GitflowGitActionExecuteResponse {
  actId: GitActId;
  commands: string[];
}
/** Wire schema for {@link GitflowGitActionExecuteResponse}. */
export const GitflowGitActionExecuteResponseSchema: z.ZodType<GitflowGitActionExecuteResponse> = z
  .object({ actId: GitActIdSchema, commands: z.array(z.string().min(1)).min(1) })
  .strict();

/** The `gitflow.gitActionSubscribe` input. */
export interface GitflowGitActionSubscribeRequest {
  actId: GitActId;
}
/** Wire schema for {@link GitflowGitActionSubscribeRequest}. */
export const GitflowGitActionSubscribeRequestSchema: z.ZodType<
  GitflowGitActionSubscribeRequest,
  GitflowGitActionSubscribeRequest
> = z.object({ actId: GitActIdSchema }).strict();

/** One command of a running act. `output` is the command's credential-scrubbed output. */
export interface GitActCommand {
  index: number;
  text: string;
  state: GitActCommandState;
  output?: string | undefined;
}

/** One frame of `gitflow.gitActionSubscribe`: every command of the act and where it stands. */
export interface GitActFrame {
  actId: GitActId;
  commands: GitActCommand[];
}
/** Wire schema for {@link GitActFrame}. */
export const GitActFrameSchema: z.ZodType<GitActFrame> = z
  .object({
    actId: GitActIdSchema,
    commands: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            text: z.string().min(1),
            state: z.enum(GIT_ACT_COMMAND_STATES),
            output: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

// --------------------------------------------------------------------------
// Generate
// --------------------------------------------------------------------------

/** The `gitflow.commitMessageGenerate` result. */
export interface GitflowCommitMessageGenerateResponse {
  subject: string;
  body: string;
}
/** Wire schema for {@link GitflowCommitMessageGenerateResponse}. */
export const GitflowCommitMessageGenerateResponseSchema: z.ZodType<GitflowCommitMessageGenerateResponse> =
  z.object({ subject: z.string().min(1), body: z.string() }).strict();

/** The `gitflow.changeRequestTextGenerate` result. */
export interface GitflowChangeRequestTextGenerateResponse {
  title: string;
  description: string;
}
/** Wire schema for {@link GitflowChangeRequestTextGenerateResponse}. */
export const GitflowChangeRequestTextGenerateResponseSchema: z.ZodType<GitflowChangeRequestTextGenerateResponse> =
  z.object({ title: z.string().min(1), description: z.string() }).strict();

// --------------------------------------------------------------------------
// git.settled
// --------------------------------------------------------------------------

/**
 * The `git.settled` payload: one record per act that left or changed the session's
 * branch, so its row in the conversation survives a reload. Each cause carries the
 * reference its row names. `runId` is present on a commit an agent made, read from
 * the commit's run trailer, and on a request an agent's own tool call opened; a push
 * carries none, because the row names the act and not the actor.
 *
 * A type alias rather than an interface so it narrows the event envelope's payload.
 */
export type GitSettledPayload =
  | { sessionId: SessionId; cause: "committed"; commitId: GitObjectId; runId?: RunId | undefined }
  | { sessionId: SessionId; cause: "pushed"; branch: string }
  | { sessionId: SessionId; cause: "pulled"; branch: string; commitId: GitObjectId }
  | {
      sessionId: SessionId;
      cause: "pull_request_opened";
      requestNumber: number;
      requestUrl: string;
      runId?: RunId | undefined;
    }
  | {
      sessionId: SessionId;
      cause: "review_posted";
      requestNumber: number;
      verdict: ReviewSubmitVerdict;
    };
/** Wire schema for {@link GitSettledPayload}. */
export const GitSettledPayloadSchema: z.ZodType<GitSettledPayload> = z.discriminatedUnion("cause", [
  z
    .object({
      sessionId: SessionIdSchema,
      cause: z.literal("committed"),
      commitId: GitObjectIdSchema,
      runId: RunIdSchema.optional(),
    })
    .strict(),
  z
    .object({ sessionId: SessionIdSchema, cause: z.literal("pushed"), branch: GitRefNameSchema })
    .strict(),
  z
    .object({
      sessionId: SessionIdSchema,
      cause: z.literal("pulled"),
      branch: GitRefNameSchema,
      commitId: GitObjectIdSchema,
    })
    .strict(),
  z
    .object({
      sessionId: SessionIdSchema,
      cause: z.literal("pull_request_opened"),
      requestNumber: ChangeRequestNumberSchema,
      requestUrl: HostingAddressSchema,
      runId: RunIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      sessionId: SessionIdSchema,
      cause: z.literal("review_posted"),
      requestNumber: ChangeRequestNumberSchema,
      verdict: z.enum(REVIEW_SUBMIT_VERDICTS),
    })
    .strict(),
]);
