// Workflow run records: the run's own record, reading one run, the runs table and its count,
// deleting runs and keeping their step data, the runs-needing-you section, the hold on starting new
// runs and clearing the values runs keep for later ones, with their method table.
import { z } from "zod";

import { ApprovalDecisionSchema, type ApprovalDecision } from "../../approval.js";
import {
  defineMethodDescriptors,
  EmptyPayloadSchema,
  type EmptyPayload,
  type MethodDescriptor,
} from "../../method-descriptor.js";
import { SessionIdSchema, type SessionId } from "../../session/id.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowStepErrorSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowStepError,
} from "../definition/document.js";
import {
  GOING_RUN_STATUSES,
  WorkflowRunStatusSchema,
  WorkflowWaitCauseSchema,
  type WorkflowRunStatus,
  type WorkflowWaitCause,
} from "./status.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "./id.js";
import {
  WorkflowCostSchema,
  WorkflowSpentAccountSchema,
  WorkflowStepSchema,
  type WorkflowCost,
  type WorkflowSpentAccount,
  type WorkflowStep,
} from "./step/record.js";
import {
  WorkflowRunModeSchema,
  WorkflowStartedBySchema,
  WorkflowTriggerKindSchema,
  type WorkflowRunMode,
  type WorkflowStartedBy,
  type WorkflowTriggerKind,
} from "./trigger.js";
import { countSchema, isoDateTimeSchema } from "../../internal/wire-scalars.js";

// The run record

/** The members a run's record carries whatever its status. */
interface WorkflowRunFields {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
  mode: WorkflowRunMode;
  triggerKind: WorkflowTriggerKind;
  startedBy: WorkflowStartedBy;
  /** The Keep mark, which `Delete runs older than…` leaves. */
  keep: boolean;
  startedAt: string;
}

/**
 * One workflow run as its row records it: the session it lives in, the version it pins, its
 * status, how and by whom it was started, its Keep mark, when it started and ended, and, on a run
 * that failed, was canceled or crashed, its `error`: why. It carries its end exactly once it has
 * ended; a `failed` run may carry none, because one parked on its failed step has not ended and
 * `Cancel` and `Resume` still act on it.
 */
export type WorkflowRun = WorkflowRunFields &
  (
    | {
        status: Extract<WorkflowRunStatus, "new" | "running" | "waiting">;
        finishedAt?: undefined;
        error?: undefined;
      }
    | { status: "failed"; finishedAt?: string | undefined; error?: WorkflowStepError | undefined }
    | { status: "succeeded"; finishedAt: string; error?: undefined }
    | {
        status: Extract<WorkflowRunStatus, "canceled" | "crashed">;
        finishedAt: string;
        error?: WorkflowStepError | undefined;
      }
  );
const workflowRunFields = {
  workflowRunId: WorkflowRunIdSchema,
  sessionId: SessionIdSchema,
  definitionId: WorkflowDefinitionIdSchema,
  workflowVersionId: WorkflowVersionIdSchema,
  mode: WorkflowRunModeSchema,
  triggerKind: WorkflowTriggerKindSchema,
  startedBy: WorkflowStartedBySchema,
  keep: z.boolean(),
  startedAt: isoDateTimeSchema,
};

// The run's status, its end and its error, one arm per kind of status: a going run has not ended,
// an ended one carries its end, a failed one may be parked on its failed step without one, and
// only a run that failed, was canceled or crashed says why.
const goingRunEndFields = {
  status: WorkflowRunStatusSchema.extract(["new", "running", "waiting"]),
  finishedAt: z.undefined().optional(),
  error: z.undefined().optional(),
};
const failedRunEndFields = {
  status: WorkflowRunStatusSchema.extract(["failed"]),
  finishedAt: isoDateTimeSchema.optional(),
  error: WorkflowStepErrorSchema.optional(),
};
const succeededRunEndFields = {
  status: WorkflowRunStatusSchema.extract(["succeeded"]),
  finishedAt: isoDateTimeSchema,
  error: z.undefined().optional(),
};
const stoppedRunEndFields = {
  status: WorkflowRunStatusSchema.extract(["canceled", "crashed"]),
  finishedAt: isoDateTimeSchema,
  error: WorkflowStepErrorSchema.optional(),
};

/**
 * Wire schema for {@link WorkflowRun}.
 *
 * @consumedBy the daemon's run service, which reads and writes the run row
 */
export const WorkflowRunSchema: z.ZodType<WorkflowRun> = z.discriminatedUnion("status", [
  z.object({ ...workflowRunFields, ...goingRunEndFields }).strict(),
  z.object({ ...workflowRunFields, ...failedRunEndFields }).strict(),
  z.object({ ...workflowRunFields, ...succeededRunEndFields }).strict(),
  z.object({ ...workflowRunFields, ...stoppedRunEndFields }).strict(),
]);

// workflow.runRead

/** The `workflow.runRead` input. */
export interface WorkflowRunReadRequest {
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowRunReadRequest}. */
export const WorkflowRunReadRequestSchema: z.ZodType<
  WorkflowRunReadRequest,
  WorkflowRunReadRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema }).strict();

/** Where a going run is: the live step's place in the run and its node's name. */
export interface WorkflowLiveStep {
  index: number;
  total: number;
  nodeName: string;
}
/** Wire schema for {@link WorkflowLiveStep}. */
export const WorkflowLiveStepSchema: z.ZodType<WorkflowLiveStep> = z
  .object({
    index: z.number().int().positive(),
    total: z.number().int().positive(),
    nodeName: z.string().min(1),
  })
  .strict()
  .refine((live) => live.index <= live.total, { message: "The live step is within the run." });

/**
 * The first run of a run's chain: runs a run starts join its chain, and a first run
 * names itself. The header links the first run only when it is another run. `runCount` is
 * how many runs the chain has started from that first run, the first run included, which
 * the chain's question and a held step's live line both read.
 */
export interface WorkflowChainRoot {
  runId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  workflowName: string;
  startedAt: string;
  runCount: number;
}
/** Wire schema for {@link WorkflowChainRoot}. */
export const WorkflowChainRootSchema: z.ZodType<WorkflowChainRoot> = z
  .object({
    runId: WorkflowRunIdSchema,
    definitionId: WorkflowDefinitionIdSchema,
    workflowName: z.string().min(1),
    startedAt: isoDateTimeSchema,
    runCount: z.number().int().positive(),
  })
  .strict();

/**
 * The chain's question as its first run's page carries it: open, or answered with the decision
 * and the run count it was taken at, which its receipt reads (`Kept going at 100 runs`). It is an
 * approval the engine raises on the first run and answers through `workflow.gateResolve` naming no
 * node: `approved` keeps the chain going, `rejected` stops every run of it.
 */
export type WorkflowChainQuestion =
  | { state: "open" }
  | { state: "answered"; decision: ApprovalDecision; runCount: number; answeredAt: string };
/** Wire schema for {@link WorkflowChainQuestion}. */
export const WorkflowChainQuestionSchema: z.ZodType<WorkflowChainQuestion> = z.discriminatedUnion(
  "state",
  [
    z.object({ state: z.literal("open") }).strict(),
    z
      .object({
        state: z.literal("answered"),
        decision: ApprovalDecisionSchema,
        runCount: z.number().int().positive(),
        answeredAt: isoDateTimeSchema,
      })
      .strict(),
  ],
);

/** How many items went through one edge of the run's graph, summed over every pass. */
export interface WorkflowEdgeItemCount {
  edgeId: string;
  itemCount: number;
}
/** Wire schema for {@link WorkflowEdgeItemCount}. */
export const WorkflowEdgeItemCountSchema: z.ZodType<WorkflowEdgeItemCount> = z
  .object({ edgeId: z.string().min(1), itemCount: countSchema })
  .strict();

/**
 * The end snapshot a finished run's `Open in Review` compares with its start. Pinned, it names
 * the execution whose start and end snapshots are compared; missing, it carries the daemon's words
 * for why the end snapshot could not be taken, and `Open in Review` stays in place saying so.
 */
export type WorkflowRunReview =
  | { state: "pinned"; epoch: number }
  | { state: "missing"; reason: string };
/** Wire schema for {@link WorkflowRunReview}. */
const WorkflowRunReviewSchema: z.ZodType<WorkflowRunReview> = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pinned"), epoch: countSchema }).strict(),
  z.object({ state: z.literal("missing"), reason: z.string().min(1) }).strict(),
]);

/**
 * The `workflow.runRead` result: the run's record with its header facts and every step, from
 * which the page draws its graph and its step panel. A `waiting` run always carries the step that
 * waits.
 */
export type WorkflowRunReadResponse = WorkflowRun & {
  chainRoot: WorkflowChainRoot;
  /**
   * True for a run in a project's repository, which records its checkout and snapshot points so
   * `Open in Review` opens its changes; false for a chat's run and a `None` run, which record none.
   */
  executionContextCaptured: boolean;
  /** The session a failed step was opened in to be fixed, linked for the life of the run. */
  fixSessionId?: SessionId | undefined;
  steps: WorkflowStep[];
  /** Summed from the steps' stored amounts. */
  cost?: WorkflowCost | undefined;
  /** The step a going run is on. */
  liveStep?: WorkflowLiveStep | undefined;
  /** Every edge items went through. */
  edgeItemCounts: WorkflowEdgeItemCount[];
  /** On a finished run whose checkout was captured, the snapshots `Open in Review` compares. */
  review?: WorkflowRunReview | undefined;
  /** On the chain's first run, the chain's question once one has been asked. */
  chainQuestion?: WorkflowChainQuestion | undefined;
};
const workflowRunReadFields = {
  ...workflowRunFields,
  chainRoot: WorkflowChainRootSchema,
  executionContextCaptured: z.boolean(),
  fixSessionId: SessionIdSchema.optional(),
  steps: z.array(WorkflowStepSchema),
  cost: WorkflowCostSchema.optional(),
  liveStep: WorkflowLiveStepSchema.optional(),
  edgeItemCounts: z.array(WorkflowEdgeItemCountSchema),
  review: WorkflowRunReviewSchema.optional(),
  chainQuestion: WorkflowChainQuestionSchema.optional(),
};
/** Wire schema for {@link WorkflowRunReadResponse}. */
export const WorkflowRunReadResponseSchema: z.ZodType<WorkflowRunReadResponse> = z
  .discriminatedUnion("status", [
    z.object({ ...workflowRunReadFields, ...goingRunEndFields }).strict(),
    z.object({ ...workflowRunReadFields, ...failedRunEndFields }).strict(),
    z.object({ ...workflowRunReadFields, ...succeededRunEndFields }).strict(),
    z.object({ ...workflowRunReadFields, ...stoppedRunEndFields }).strict(),
  ])
  .refine((run) => GOING_RUN_STATUSES.includes(run.status) || run.liveStep === undefined, {
    path: ["liveStep"],
    message: "Only a going run has a live step.",
  })
  .refine(
    (run) => run.status !== "waiting" || run.steps.some((step) => step.status === "waiting"),
    {
      path: ["steps"],
      message: "A waiting run carries the step that waits.",
    },
  )
  .refine(
    (run) =>
      run.review === undefined || (run.executionContextCaptured && run.finishedAt !== undefined),
    { path: ["review"], message: "Only a finished run with a captured checkout is reviewed." },
  )
  .refine((run) => run.chainQuestion === undefined || run.chainRoot.runId === run.workflowRunId, {
    path: ["chainQuestion"],
    message: "The chain's question sits on the chain's first run.",
  });

// workflow.runList

/**
 * The `workflow.runList` input: the runs table's filters (workflow, status, trigger kind
 * and date range) and the version scope `Show runs` hands in, which comes only with the workflow
 * it belongs to. Without `sessionId` it lists every run this daemon ran.
 */
export type WorkflowRunListRequest = {
  sessionId?: SessionId | undefined;
  status?: [WorkflowRunStatus, ...WorkflowRunStatus[]] | undefined;
  triggerKind?: [WorkflowTriggerKind, ...WorkflowTriggerKind[]] | undefined;
  startedAfter?: string | undefined;
  startedBefore?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
} & (
  | { definitionId?: WorkflowDefinitionId | undefined; workflowVersionId?: undefined }
  | { definitionId: WorkflowDefinitionId; workflowVersionId: string }
);
const workflowRunListFilterFields = {
  sessionId: SessionIdSchema.optional(),
  status: z.tuple([WorkflowRunStatusSchema], WorkflowRunStatusSchema).optional(),
  triggerKind: z.tuple([WorkflowTriggerKindSchema], WorkflowTriggerKindSchema).optional(),
  startedAfter: isoDateTimeSchema.optional(),
  startedBefore: isoDateTimeSchema.optional(),
  limit: z.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
};
/** Wire schema for {@link WorkflowRunListRequest}; a version scope names its workflow. */
export const WorkflowRunListRequestSchema: z.ZodType<
  WorkflowRunListRequest,
  WorkflowRunListRequest
> = z.union([
  z
    .object({ ...workflowRunListFilterFields, definitionId: WorkflowDefinitionIdSchema.optional() })
    .strict(),
  z
    .object({
      ...workflowRunListFilterFields,
      definitionId: WorkflowDefinitionIdSchema,
      workflowVersionId: WorkflowVersionIdSchema,
    })
    .strict(),
]);

/**
 * One row of the runs table, in the order the row reads it, built from the run's record. It names
 * the definition the run came from, because a list answers with runs nobody named, and the run's
 * session, which the row opens. While the run is going it carries its live step and no
 * duration; a `failed` run parked on its failed step has not ended and carries none either. A
 * waiting run names its cause, and an account wait the instant it resumes itself where one is
 * armed. `keep` is the Keep mark the row shows.
 */
export type WorkflowRunSummary = Pick<
  WorkflowRun,
  | "workflowRunId"
  | "sessionId"
  | "definitionId"
  | "mode"
  | "triggerKind"
  | "startedBy"
  | "startedAt"
  | "keep"
> & {
  definitionName: string;
  durationMs?: number | undefined;
  stepCount: number;
  liveStep?: WorkflowLiveStep | undefined;
  cost?: WorkflowCost | undefined;
} & (
    | { status: "waiting"; waitCause: "account"; resumeAt?: string | undefined }
    | {
        status: "waiting";
        waitCause: Exclude<WorkflowWaitCause, "account">;
        resumeAt?: undefined;
      }
    | { status: Exclude<WorkflowRunStatus, "waiting">; waitCause?: undefined; resumeAt?: undefined }
  );
const workflowRunSummaryFields = {
  workflowRunId: workflowRunFields.workflowRunId,
  sessionId: workflowRunFields.sessionId,
  definitionId: workflowRunFields.definitionId,
  definitionName: z.string().min(1),
  mode: workflowRunFields.mode,
  triggerKind: workflowRunFields.triggerKind,
  startedBy: workflowRunFields.startedBy,
  startedAt: workflowRunFields.startedAt,
  durationMs: countSchema.optional(),
  stepCount: countSchema,
  liveStep: WorkflowLiveStepSchema.optional(),
  cost: WorkflowCostSchema.optional(),
  keep: workflowRunFields.keep,
};
/**
 * Wire schema for {@link WorkflowRunSummary}: only a waiting run names its cause, and only an
 * account wait carries a resume instant.
 */
export const WorkflowRunSummarySchema: z.ZodType<WorkflowRunSummary> = z
  .union([
    z
      .object({
        ...workflowRunSummaryFields,
        status: WorkflowRunStatusSchema.extract(["waiting"]),
        waitCause: z.literal("account"),
        resumeAt: isoDateTimeSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...workflowRunSummaryFields,
        status: WorkflowRunStatusSchema.extract(["waiting"]),
        waitCause: WorkflowWaitCauseSchema.exclude(["account"]),
      })
      .strict(),
    z
      .object({ ...workflowRunSummaryFields, status: WorkflowRunStatusSchema.exclude(["waiting"]) })
      .strict(),
  ])
  .refine(
    (row) =>
      row.status === "failed" ||
      GOING_RUN_STATUSES.includes(row.status) === (row.durationMs === undefined),
    {
      path: ["durationMs"],
      message: "An ended run carries its duration and a going or parked one does not.",
    },
  )
  .refine((row) => GOING_RUN_STATUSES.includes(row.status) || row.liveStep === undefined, {
    path: ["liveStep"],
    message: "Only a going run has a live step.",
  });

/**
 * The `workflow.runList` result: one page of runs, each listed once across pages, and
 * how many runs the filters match in all, which the tab's count reads.
 */
export interface WorkflowRunListResponse {
  runs: WorkflowRunSummary[];
  nextCursor?: string | undefined;
  totalCount: number;
}
/** Wire schema for {@link WorkflowRunListResponse}. */
export const WorkflowRunListResponseSchema: z.ZodType<WorkflowRunListResponse> = z
  .object({
    runs: z.array(WorkflowRunSummarySchema),
    nextCursor: z.string().min(1).optional(),
    totalCount: countSchema,
  })
  .strict()
  .refine((page) => page.runs.length <= page.totalCount, {
    path: ["totalCount"],
    message: "A page holds no more runs than the total.",
  });

// workflow.runDelete, workflow.runsDeletePreview, workflow.runsDelete, workflow.runKeepSet

/**
 * The `workflow.runDelete` input. Deleting a run removes its record, its steps and its
 * recorded snapshots. A new, running or waiting run is refused: cancel it first.
 */
export interface WorkflowRunDeleteRequest {
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowRunDeleteRequest}. */
export const WorkflowRunDeleteRequestSchema: z.ZodType<
  WorkflowRunDeleteRequest,
  WorkflowRunDeleteRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema }).strict();

/** The `workflow.runDelete` result. */
export interface WorkflowRunDeleteResponse {
  workflowRunId: WorkflowRunId;
  deleted: true;
}
/** Wire schema for {@link WorkflowRunDeleteResponse}. */
export const WorkflowRunDeleteResponseSchema: z.ZodType<WorkflowRunDeleteResponse> = z
  .object({ workflowRunId: WorkflowRunIdSchema, deleted: z.literal(true) })
  .strict();

/**
 * The `workflow.runsDeletePreview` and `workflow.runsDelete` input: runs that started
 * before this instant. A run marked Keep and a waiting run are never removed.
 */
export interface WorkflowRunsDeleteRequest {
  olderThan: string;
}
/** Wire schema for {@link WorkflowRunsDeleteRequest}. */
export const WorkflowRunsDeleteRequestSchema: z.ZodType<
  WorkflowRunsDeleteRequest,
  WorkflowRunsDeleteRequest
> = z.object({ olderThan: isoDateTimeSchema }).strict();

/**
 * The `workflow.runsDeletePreview` result, read before the confirm: how many runs the
 * delete would remove, and how many older runs it would leave because they are kept or
 * waiting.
 */
export interface WorkflowRunsDeletePreviewResponse {
  deleteCount: number;
  keptCount: number;
  waitingCount: number;
}
/** Wire schema for {@link WorkflowRunsDeletePreviewResponse}. */
export const WorkflowRunsDeletePreviewResponseSchema: z.ZodType<WorkflowRunsDeletePreviewResponse> =
  z
    .object({
      deleteCount: countSchema,
      keptCount: countSchema,
      waitingCount: countSchema,
    })
    .strict();

/**
 * The `workflow.runsDelete` result. Runs may start or end between the preview and the
 * delete, so this count, not the preview's, is what was removed.
 */
export interface WorkflowRunsDeleteResponse {
  deletedCount: number;
}
/** Wire schema for {@link WorkflowRunsDeleteResponse}. */
export const WorkflowRunsDeleteResponseSchema: z.ZodType<WorkflowRunsDeleteResponse> = z
  .object({ deletedCount: countSchema })
  .strict();

/** The `workflow.runKeepSet` input and result: whether the run's step data outlives its bound. */
export interface WorkflowRunKeepSet {
  workflowRunId: WorkflowRunId;
  keep: boolean;
}
/** Wire schema for {@link WorkflowRunKeepSet}, the request and the reply alike. */
export const WorkflowRunKeepSetSchema: z.ZodType<WorkflowRunKeepSet, WorkflowRunKeepSet> = z
  .object({ workflowRunId: WorkflowRunIdSchema, keep: z.boolean() })
  .strict();

// workflow.runAttentionList

/**
 * One line of the runs-needing-you section. A run waiting on a person is its own line: the
 * workflow's name, what it waits on, the name of the step that waits, and since when. Runs held
 * by one spent provider account fold into one line keyed by that account, named as the steps
 * waiting on it name it, with how many runs it holds, since when the oldest waits, and the
 * instant it resumes itself where one is armed.
 */
export type WorkflowRunAttentionEntry =
  | {
      kind: "run";
      workflowRunId: WorkflowRunId;
      workflowName: string;
      waitCause: Exclude<WorkflowWaitCause, "account">;
      waitingStepName: string;
      waitingSince: string;
    }
  | {
      kind: "account";
      account: WorkflowSpentAccount;
      affectedRunCount: number;
      waitingSince: string;
      resumeAt?: string | undefined;
    };
/** Wire schema for {@link WorkflowRunAttentionEntry}. */
export const WorkflowRunAttentionEntrySchema: z.ZodType<WorkflowRunAttentionEntry> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("run"),
        workflowRunId: WorkflowRunIdSchema,
        workflowName: z.string().min(1),
        waitCause: WorkflowWaitCauseSchema.exclude(["account"]),
        waitingStepName: z.string().min(1),
        waitingSince: isoDateTimeSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("account"),
        account: WorkflowSpentAccountSchema,
        affectedRunCount: z.number().int().positive(),
        waitingSince: isoDateTimeSchema,
        resumeAt: isoDateTimeSchema.optional(),
      })
      .strict(),
  ]);

/**
 * The `workflow.runAttentionList` result: the account lines first, then the runs
 * waiting on a person, oldest first. `waitingOnPersonCount` counts those runs, the
 * queue `Next waiting` walks; an account wait is never in it.
 */
export interface WorkflowRunAttentionListResponse {
  entries: WorkflowRunAttentionEntry[];
  waitingOnPersonCount: number;
}
/** Wire schema for {@link WorkflowRunAttentionListResponse}; no account line follows a run line. */
export const WorkflowRunAttentionListResponseSchema: z.ZodType<WorkflowRunAttentionListResponse> = z
  .object({
    entries: z.array(WorkflowRunAttentionEntrySchema),
    waitingOnPersonCount: countSchema,
  })
  .strict()
  .refine(
    (reply) => {
      const firstRunLine = reply.entries.findIndex((entry) => entry.kind === "run");
      return (
        firstRunLine === -1 ||
        !reply.entries.slice(firstRunLine).some((entry) => entry.kind === "account")
      );
    },
    { path: ["entries"], message: "The account lines stand above the runs waiting on a person." },
  )
  .refine(
    (reply) =>
      reply.waitingOnPersonCount === reply.entries.filter((entry) => entry.kind === "run").length,
    { path: ["waitingOnPersonCount"], message: "The count is of the runs waiting on a person." },
  );

// workflow.runsPauseSet

/**
 * The `workflow.runsPauseSet` input: the hold on starting new runs, one per daemon over
 * its whole scheduler. A run already going finishes; every new start waits until the
 * hold is off.
 */
export interface WorkflowRunsPauseSetRequest {
  paused: boolean;
}
/** Wire schema for {@link WorkflowRunsPauseSetRequest}. */
export const WorkflowRunsPauseSetRequestSchema: z.ZodType<
  WorkflowRunsPauseSetRequest,
  WorkflowRunsPauseSetRequest
> = z.object({ paused: z.boolean() }).strict();

/** The hold and how many starts wait behind it, as the reply and the live stream carry it. */
export interface WorkflowRunsPauseState {
  paused: boolean;
  waitingStartCount: number;
}
/** Wire schema for {@link WorkflowRunsPauseState}. */
export const WorkflowRunsPauseStateSchema: z.ZodType<WorkflowRunsPauseState> = z
  .object({ paused: z.boolean(), waitingStartCount: countSchema })
  .strict();

// workflow.keptVarsClear

/**
 * The `workflow.keptVarsClear` input: clear every value `Keep for later runs` kept for
 * one workflow. Kept values belong to the workflow, not to a version.
 */
export interface WorkflowKeptVarsClearRequest {
  definitionId: WorkflowDefinitionId;
}
/** Wire schema for {@link WorkflowKeptVarsClearRequest}. */
export const WorkflowKeptVarsClearRequestSchema: z.ZodType<
  WorkflowKeptVarsClearRequest,
  WorkflowKeptVarsClearRequest
> = z.object({ definitionId: WorkflowDefinitionIdSchema }).strict();

/** The `workflow.keptVarsClear` result: how many kept values went. */
export interface WorkflowKeptVarsClearResponse {
  definitionId: WorkflowDefinitionId;
  clearedCount: number;
}
/** Wire schema for {@link WorkflowKeptVarsClearResponse}. */
export const WorkflowKeptVarsClearResponseSchema: z.ZodType<WorkflowKeptVarsClearResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    clearedCount: countSchema,
  })
  .strict();

// Refusals

/**
 * `Delete run` on a new, running or waiting run or a failed run parked on its failed step, or on a
 * chain's first run while a later run of its chain is one of those; nothing is deleted
 * (`Cancel it first.`).
 */
export const WORKFLOW_RUN_NOT_DELETABLE_CODE = "workflow.run_not_deletable" as const;

// The workflow run records method table

/**
 * The `workflow.*` methods that read, list and keep run records, keyed by name.
 * `workflow.runAttentionList` takes no members: the runs table's filters never narrow it.
 */
export interface WorkflowRunRecordMethodDescriptors {
  readonly "workflow.runRead": MethodDescriptor<
    "workflow.runRead",
    WorkflowRunReadRequest,
    WorkflowRunReadResponse
  >;
  readonly "workflow.runList": MethodDescriptor<
    "workflow.runList",
    WorkflowRunListRequest,
    WorkflowRunListResponse
  >;
  readonly "workflow.runDelete": MethodDescriptor<
    "workflow.runDelete",
    WorkflowRunDeleteRequest,
    WorkflowRunDeleteResponse
  >;
  readonly "workflow.runsDeletePreview": MethodDescriptor<
    "workflow.runsDeletePreview",
    WorkflowRunsDeleteRequest,
    WorkflowRunsDeletePreviewResponse
  >;
  readonly "workflow.runsDelete": MethodDescriptor<
    "workflow.runsDelete",
    WorkflowRunsDeleteRequest,
    WorkflowRunsDeleteResponse
  >;
  readonly "workflow.runKeepSet": MethodDescriptor<
    "workflow.runKeepSet",
    WorkflowRunKeepSet,
    WorkflowRunKeepSet
  >;
  readonly "workflow.runAttentionList": MethodDescriptor<
    "workflow.runAttentionList",
    EmptyPayload,
    WorkflowRunAttentionListResponse
  >;
  readonly "workflow.runsPauseSet": MethodDescriptor<
    "workflow.runsPauseSet",
    WorkflowRunsPauseSetRequest,
    WorkflowRunsPauseState
  >;
  readonly "workflow.keptVarsClear": MethodDescriptor<
    "workflow.keptVarsClear",
    WorkflowKeptVarsClearRequest,
    WorkflowKeptVarsClearResponse
  >;
}

/**
 * The `workflow.*` methods that read, list and keep run records.
 */
export const WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS: WorkflowRunRecordMethodDescriptors =
  defineMethodDescriptors({
    "workflow.runRead": {
      method: "workflow.runRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowRunReadRequestSchema,
      responseSchema: WorkflowRunReadResponseSchema,
    },
    "workflow.runList": {
      method: "workflow.runList",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowRunListRequestSchema,
      responseSchema: WorkflowRunListResponseSchema,
    },
    "workflow.runDelete": {
      method: "workflow.runDelete",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunDeleteRequestSchema,
      responseSchema: WorkflowRunDeleteResponseSchema,
    },
    "workflow.runsDeletePreview": {
      method: "workflow.runsDeletePreview",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowRunsDeleteRequestSchema,
      responseSchema: WorkflowRunsDeletePreviewResponseSchema,
    },
    "workflow.runsDelete": {
      method: "workflow.runsDelete",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunsDeleteRequestSchema,
      responseSchema: WorkflowRunsDeleteResponseSchema,
    },
    "workflow.runKeepSet": {
      method: "workflow.runKeepSet",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunKeepSetSchema,
      responseSchema: WorkflowRunKeepSetSchema,
    },
    "workflow.runAttentionList": {
      method: "workflow.runAttentionList",
      procedureType: "query",
      mutating: false,
      requestSchema: EmptyPayloadSchema,
      responseSchema: WorkflowRunAttentionListResponseSchema,
    },
    "workflow.runsPauseSet": {
      method: "workflow.runsPauseSet",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunsPauseSetRequestSchema,
      responseSchema: WorkflowRunsPauseStateSchema,
    },
    "workflow.keptVarsClear": {
      method: "workflow.keptVarsClear",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowKeptVarsClearRequestSchema,
      responseSchema: WorkflowKeptVarsClearResponseSchema,
    },
  });
