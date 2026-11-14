// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What local git answers: a branch's ship facts, the review pane's diff, the ship acts with their preview and progress, Generate, and the git.settled payload.

import type { AgentId } from "../agent/definition.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { GitObjectId } from "../repo/git-reads.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { WorkflowNodeId } from "../workflow/definition/document.js";
import type { WorkflowRunId } from "../workflow/run/id.js";
import type { WorkflowRunEpoch, WorkflowRunPauseNumber } from "../workflow/run/snapshot.js";
import type { ChangeRequestSummary, GitHostKind, ReviewSubmitVerdict } from "./hosting.js";
import type { ChangeRequestNumber, GitShortObjectId, HostingAddress } from "./shared.js";

/**
 * The id of one running or finished git act, which the daemon mints.
 */
export type GitActId = string & { readonly __brand: "GitActId" };
/**
 * The half-finished git operations that stop a commit until they are ended.
 */
export type PendingGitOperationKind = "merge" | "rebase" | "bisect";
/**
 * Where one command of a running act stands.
 */
export type GitActCommandState = "pending" | "running" | "done" | "failed";
/**
 * Why a changed file's contents cannot be shown.
 */
export type DiffFileUnreadableReason = "permissionDenied" | "notRegularFile";
/**
 * One of a workflow run's snapshot points: its start, an approval pause, or its end, within one
 * execution of the run (each re-execution opens the next epoch, counted from 0).
 */
export type WorkflowRunSnapshotPoint =
  | {
      point: "start";
      /**
       * The execution.
       */
      epoch: WorkflowRunEpoch;
    }
  | {
      point: "pause";
      /**
       * The execution.
       */
      epoch: WorkflowRunEpoch;
      /**
       * The pause.
       */
      pauseNumber: WorkflowRunPauseNumber;
    }
  | {
      point: "end";
      /**
       * The execution.
       */
      epoch: WorkflowRunEpoch;
    };
/**
 * `git.diff.read`, one arm per comparison.
 */
export type GitDiffReadRequest =
  | {
      scope: "changes";
      /**
       * The session.
       */
      sessionId: SessionId;
    }
  | {
      scope: "branch";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The base.
       */
      base?: string;
      /**
       * One commit of the branch.
       */
      commitId?: GitObjectId;
    }
  | {
      scope: "changeRequest";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The change request.
       */
      changeRequestNumber: ChangeRequestNumber;
    }
  | {
      scope: "workflowRun";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The earlier point.
       */
      from: WorkflowRunSnapshotPoint;
      /**
       * The later point.
       */
      to: WorkflowRunSnapshotPoint;
    };
/**
 * One changed path, composed into a single patch however many edits touched it, by what
 * happened to it between the two sides; a copy reads `added`, and only a rename carries
 * the old path.
 */
export type DiffFile =
  | {
      kind: "added";
      /**
       * Only a rename carries the old path.
       */
      oldPath?: never;
      /**
       * The path.
       */
      path: string;
      /**
       * Whether its mode changed.
       */
      modeChanged?: boolean;
      /**
       * Whether it is binary.
       */
      binary?: boolean;
      /**
       * Why its contents cannot be shown.
       */
      unreadable?: DiffFileUnreadableReason;
      /**
       * Lines added.
       */
      additions: number;
      /**
       * Lines deleted.
       */
      deletions: number;
      /**
       * The unified patch, absent when `binary` or `unreadable` says why no lines are
       * shown.
       */
      patch?: string;
      /**
       * The blob before.
       */
      oldBlobId?: GitObjectId;
      /**
       * The blob after.
       */
      newBlobId?: GitObjectId;
      /**
       * The newest turn that touched it; absent for a change made outside a turn.
       */
      newestTurn?: number;
      /**
       * On a workflow run's diff, the step that changed it; absent for an edit made in
       * the checkout by anyone else.
       */
      step?: DiffFileStep;
    }
  | {
      kind: "deleted";
      /**
       * Only a rename carries the old path.
       */
      oldPath?: never;
      /**
       * The path.
       */
      path: string;
      /**
       * Whether its mode changed.
       */
      modeChanged?: boolean;
      /**
       * Whether it is binary.
       */
      binary?: boolean;
      /**
       * Why its contents cannot be shown.
       */
      unreadable?: DiffFileUnreadableReason;
      /**
       * Lines added.
       */
      additions: number;
      /**
       * Lines deleted.
       */
      deletions: number;
      /**
       * The unified patch, absent when `binary` or `unreadable` says why no lines are
       * shown.
       */
      patch?: string;
      /**
       * The blob before.
       */
      oldBlobId?: GitObjectId;
      /**
       * The blob after.
       */
      newBlobId?: GitObjectId;
      /**
       * The newest turn that touched it; absent for a change made outside a turn.
       */
      newestTurn?: number;
      /**
       * On a workflow run's diff, the step that changed it; absent for an edit made in
       * the checkout by anyone else.
       */
      step?: DiffFileStep;
    }
  | {
      kind: "renamed";
      /**
       * The path before the rename.
       */
      oldPath: string;
      /**
       * The path.
       */
      path: string;
      /**
       * Whether its mode changed.
       */
      modeChanged?: boolean;
      /**
       * Whether it is binary.
       */
      binary?: boolean;
      /**
       * Why its contents cannot be shown.
       */
      unreadable?: DiffFileUnreadableReason;
      /**
       * Lines added.
       */
      additions: number;
      /**
       * Lines deleted.
       */
      deletions: number;
      /**
       * The unified patch, absent when `binary` or `unreadable` says why no lines are
       * shown.
       */
      patch?: string;
      /**
       * The blob before.
       */
      oldBlobId?: GitObjectId;
      /**
       * The blob after.
       */
      newBlobId?: GitObjectId;
      /**
       * The newest turn that touched it; absent for a change made outside a turn.
       */
      newestTurn?: number;
      /**
       * On a workflow run's diff, the step that changed it; absent for an edit made in
       * the checkout by anyone else.
       */
      step?: DiffFileStep;
    }
  | {
      kind: "modified";
      /**
       * Only a rename carries the old path.
       */
      oldPath?: never;
      /**
       * The path.
       */
      path: string;
      /**
       * Whether its mode changed.
       */
      modeChanged?: boolean;
      /**
       * Whether it is binary.
       */
      binary?: boolean;
      /**
       * Why its contents cannot be shown.
       */
      unreadable?: DiffFileUnreadableReason;
      /**
       * Lines added.
       */
      additions: number;
      /**
       * Lines deleted.
       */
      deletions: number;
      /**
       * The unified patch, absent when `binary` or `unreadable` says why no lines are
       * shown.
       */
      patch?: string;
      /**
       * The blob before.
       */
      oldBlobId?: GitObjectId;
      /**
       * The blob after.
       */
      newBlobId?: GitObjectId;
      /**
       * The newest turn that touched it; absent for a change made outside a turn.
       */
      newestTurn?: number;
      /**
       * On a workflow run's diff, the step that changed it; absent for an edit made in
       * the checkout by anyone else.
       */
      step?: DiffFileStep;
    };
/**
 * `git.action.preview`: one ship act with the values of its form. The preview and the
 * execution take this one shape, so the commands shown before the press are built by the code
 * that runs them.
 */
export type GitActionPreviewRequest =
  | {
      act: "commit";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The commit form.
       */
      formValues: CommitFormValues;
    }
  | {
      act: "push";
      /**
       * The session.
       */
      sessionId: SessionId;
    }
  | {
      act: "pull";
      /**
       * The session.
       */
      sessionId: SessionId;
    }
  | {
      act: "openChangeRequest";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The change-request form.
       */
      formValues: ChangeRequestFormValues;
    };
/**
 * `git.action.execute`: the act, and with `retryFromCommand` the earlier act's failed
 * command it resumes at instead of starting over.
 */
export type GitActionExecuteRequest =
  | {
      act: "commit";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The commit form.
       */
      formValues: CommitFormValues;
      /**
       * The failed command to resume at.
       */
      retryFromCommand?: GitActRetryPoint;
    }
  | {
      act: "push";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The failed command to resume at.
       */
      retryFromCommand?: GitActRetryPoint;
    }
  | {
      act: "pull";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The failed command to resume at.
       */
      retryFromCommand?: GitActRetryPoint;
    }
  | {
      act: "openChangeRequest";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The change-request form.
       */
      formValues: ChangeRequestFormValues;
      /**
       * The failed command to resume at.
       */
      retryFromCommand?: GitActRetryPoint;
    };
/**
 * The `git.settled` payload: one record per act that left or changed the session's branch, so its
 * conversation row survives a reload. `runId` marks an agent's commit (from its run trailer) or
 * opened request; a push carries none, because its row names the act and not the actor.
 */
export type GitSettledPayload =
  | {
      cause: "committed";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The commit.
       */
      commitId: GitObjectId;
      /**
       * The agent's run that made it.
       */
      runId?: RunId;
    }
  | {
      cause: "pushed";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The branch pushed.
       */
      branch: string;
    }
  | {
      cause: "pulled";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The branch pulled.
       */
      branch: string;
      /**
       * The commit it pulled to.
       */
      commitId: GitObjectId;
    }
  | {
      cause: "pullRequestOpened";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Its number.
       */
      requestNumber: ChangeRequestNumber;
      /**
       * Its address.
       */
      requestUrl: HostingAddress;
      /**
       * The agent's run that opened it.
       */
      runId?: RunId;
    }
  | {
      cause: "reviewPosted";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The change request.
       */
      requestNumber: ChangeRequestNumber;
      /**
       * The verdict.
       */
      verdict: ReviewSubmitVerdict;
    };

/**
 * The details of a `git.generateFailed` refusal: the provider's own words; nothing falls
 * back to another provider, model or account.
 */
export interface GitGenerateFailedDetails {
  /**
   * The provider's words.
   */
  providerFailureDetail: string;
}
/**
 * The details of a `git.generateRefused` refusal: why, in the provider's own words; nothing
 * falls back to another provider, model or account.
 */
export interface GitGenerateRefusedDetails {
  /**
   * Why.
   */
  reason: "providerRefused";
  /**
   * The provider's words.
   */
  providerFailureDetail: string;
}
/**
 * A half-finished merge, rebase or bisect, with the command that ends it.
 */
export interface PendingGitOperation {
  /**
   * The operation.
   */
  kind: PendingGitOperationKind;
  /**
   * The command that ends it.
   */
  endCommand: string;
}
/**
 * The `git.branchContext.read` result: the branch's ship facts, which also carry what the
 * change-request form opens with.
 */
export interface GitBranchContextReadResponse {
  /**
   * The session's branch.
   */
  headBranch: string;
  /**
   * The branch it ships to.
   */
  baseBranch: string;
  /**
   * The repository's default branch.
   */
  defaultBranch: string;
  /**
   * Its upstream.
   */
  upstreamRef?: string;
  /**
   * Uncommitted files.
   */
  uncommittedFileCount: number;
  /**
   * Commits ahead of the base.
   */
  aheadOfBase: number;
  /**
   * Commits behind the base.
   */
  behindBase: number;
  /**
   * Commits not pushed.
   */
  unpushedCommitCount: number;
  /**
   * The branch was never pushed, so opening a change request pushes it first.
   */
  neverLeftMachine: boolean;
  /**
   * A half-finished operation.
   */
  pendingOperation?: PendingGitOperation;
  /**
   * The branch's change requests, newest first.
   */
  changeRequests: ChangeRequestSummary[];
  /**
   * The hosting service; absent where the daemon cannot say which service the remote is.
   */
  hostKind?: GitHostKind;
  /**
   * When the background fetch `behindBase` comes from last succeeded.
   */
  countsAsOf?: WireInstant;
}
/**
 * The workflow step that changed a file, named as the run's pinned version names it.
 */
export interface DiffFileStep {
  /**
   * The step's node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Its name.
   */
  nodeName: string;
}
/**
 * The agent whose run made a commit, read from the commit's run trailer.
 */
export interface DiffCommitAgent {
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * Its name.
   */
  name: string;
}
/**
 * One commit on the branch comparison; a commit without an agent is the person's.
 */
export interface DiffCommit {
  /**
   * The commit.
   */
  commitId: GitObjectId;
  /**
   * Its short id.
   */
  shortId: GitShortObjectId;
  /**
   * Its subject.
   */
  subject: string;
  /**
   * When it landed.
   */
  landedAt: WireInstant;
  /**
   * The agent whose run made it.
   */
  agent?: DiffCommitAgent;
}
/**
 * The `git.diff.read` result, always the whole diff: the daemon never cuts a patch at a size.
 * `head` and `base` name the two ends; `commits` is present on the branch comparison.
 */
export interface GitDiffReadResponse {
  /**
   * The head end.
   */
  head: string;
  /**
   * The base end.
   */
  base: string;
  /**
   * The changed files.
   */
  files: DiffFile[];
  /**
   * The branch's commits.
   */
  commits?: DiffCommit[];
}
/**
 * The commit form. The subject has no length limit: its counter past 72 is a reading, never a
 * refusal.
 */
export interface CommitFormValues {
  /**
   * The subject.
   */
  subject: string;
  /**
   * The body.
   */
  body?: string;
}
/**
 * The change-request form.
 */
export interface ChangeRequestFormValues {
  /**
   * The base branch.
   */
  base: string;
  /**
   * The title.
   */
  title: string;
  /**
   * The description.
   */
  description: string;
  /**
   * Whether it opens as a draft.
   */
  draft: boolean;
  /**
   * The reviewers asked.
   */
  reviewers: string[];
  /**
   * The labels.
   */
  labels: string[];
}
/**
 * The failed command of an earlier act that a retry runs again from.
 */
export interface GitActRetryPoint {
  /**
   * The earlier act.
   */
  actId: GitActId;
  /**
   * Its failed command, from 0.
   */
  commandIndex: number;
}
/**
 * The `git.action.preview` result: the exact commands the act will run, in order.
 */
export interface GitActionPreviewResponse {
  /**
   * The commands.
   *
   * @minItems 1
   */
  commands: [string, ...string[]];
}
/**
 * The `git.action.execute` result: the act's id, whose progress `git.action.subscribe`
 * streams, and the commands it runs. A failed command is a failed command on that stream, not an
 * error reply.
 */
export interface GitActionExecuteResponse {
  /**
   * The act.
   */
  actId: GitActId;
  /**
   * The commands.
   *
   * @minItems 1
   */
  commands: [string, ...string[]];
}
/**
 * `git.action.subscribe`: the act to follow.
 */
export interface GitActionSubscribeRequest {
  /**
   * The act.
   */
  actId: GitActId;
}
/**
 * One command of a running act; `output` is its credential-scrubbed output.
 */
export interface GitActCommand {
  /**
   * Its place, from 0.
   */
  index: number;
  /**
   * The command.
   */
  text: string;
  /**
   * Where it stands.
   */
  state: GitActCommandState;
  /**
   * Its output.
   */
  output?: string;
}
/**
 * One frame of `git.action.subscribe`: every command of the act and where it stands.
 */
export interface GitActFrame {
  /**
   * The act.
   */
  actId: GitActId;
  /**
   * Its commands.
   *
   * @minItems 1
   */
  commands: [GitActCommand, ...GitActCommand[]];
}
/**
 * The `git.commitMessage.generate` result.
 */
export interface GitCommitMessageGenerateResponse {
  /**
   * The subject.
   */
  subject: string;
  /**
   * The body.
   */
  body: string;
  /**
   * Each changed file no pass could read, which the text does not cover; empty when every file
   * was read.
   */
  unreadPaths: string[];
}
/**
 * The `git.changeRequest.text.generate` result.
 */
export interface GitChangeRequestTextGenerateResponse {
  /**
   * The title.
   */
  title: string;
  /**
   * The description.
   */
  description: string;
  /**
   * Each changed file no pass could read, which the text does not cover; empty when every file
   * was read.
   */
  unreadPaths: string[];
}

export {
  validateChangeRequestFormValues,
  validateCommitFormValues,
  validateDiffCommit,
  validateDiffCommitAgent,
  validateDiffFile,
  validateDiffFileStep,
  validateDiffFileUnreadableReason,
  validateGitActCommand,
  validateGitActCommandState,
  validateGitActFrame,
  validateGitActId,
  validateGitActRetryPoint,
  validateGitActionExecuteRequest,
  validateGitActionExecuteResponse,
  validateGitActionPreviewRequest,
  validateGitActionPreviewResponse,
  validateGitActionSubscribeRequest,
  validateGitBranchContextReadResponse,
  validateGitChangeRequestTextGenerateResponse,
  validateGitCommitMessageGenerateResponse,
  validateGitDiffReadRequest,
  validateGitDiffReadResponse,
  validateGitSettledPayload,
  validatePendingGitOperation,
  validatePendingGitOperationKind,
  validateWorkflowRunSnapshotPoint,
} from "../checks/git/local.js";
