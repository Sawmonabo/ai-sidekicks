// Workflow run records: reading one run, the runs table and its count, deleting runs
// and keeping their step data, the runs-needing-you section, the hold on starting new
// runs, clearing the values runs keep for later ones, and the one live stream the runs
// surface reads, with their method table. A descriptor registers nothing.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { ProviderAccountIdSchema, type ProviderAccountId } from "./provider-account.js";
import { SessionIdSchema, type SessionId } from "./session.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowNodeIdSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowNodeId,
} from "./workflow-definition.js";
import {
  WorkflowDefinitionSummarySchema,
  type WorkflowDefinitionSummary,
} from "./workflow-definition-methods.js";
import {
  WORKFLOW_WAIT_CAUSES,
  WorkflowCostSchema,
  WorkflowRunIdSchema,
  WorkflowRunModeSchema,
  WorkflowRunStatusSchema,
  WorkflowStartedBySchema,
  WorkflowStepSchema,
  WorkflowWaitCauseSchema,
  type WorkflowCost,
  type WorkflowRunId,
  type WorkflowRunMode,
  type WorkflowRunStatus,
  type WorkflowStartedBy,
  type WorkflowStep,
  type WorkflowWaitCause,
} from "./workflow-run.js";

/** The statuses of a run that is still going: new, running or waiting. */
const GOING_RUN_STATUSES: readonly WorkflowRunStatus[] = ["new", "running", "waiting"];

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

/**
 * The first run of a run's chain: runs a run starts join its chain, and a first run
 * names itself. The header links the first run only when it is another run.
 */
export interface WorkflowChainRoot {
  runId: WorkflowRunId;
  workflowId: WorkflowDefinitionId;
  workflowName: string;
  startedAt: string;
}
/** Wire schema for {@link WorkflowChainRoot}. */
export const WorkflowChainRootSchema: z.ZodType<WorkflowChainRoot> = z
  .object({
    runId: WorkflowRunIdSchema,
    workflowId: WorkflowDefinitionIdSchema,
    workflowName: z.string().min(1),
    startedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * The `workflow.runRead` result: the run's header facts and every step. The page draws
 * its graph and its step panel from `steps`.
 *
 * `executionContextCaptured` is true when the run recorded its checkout and snapshot
 * points, which is what lets `Open in Review` open the run's changes; a run in a chat
 * session records none. `keep` holds the run's step data past the time bound.
 * `fixSessionId` names the session a failed step was opened in to be fixed, linked for
 * the life of the run. `failureReason` also carries a cancellation's reason.
 */
export interface WorkflowRunReadResponse {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
  state: WorkflowRunStatus;
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
  chainRoot: WorkflowChainRoot;
  executionContextCaptured: boolean;
  keep: boolean;
  fixSessionId?: SessionId | undefined;
  steps: WorkflowStep[];
  failureReason?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
}
/** Wire schema for {@link WorkflowRunReadResponse}. */
export const WorkflowRunReadResponseSchema: z.ZodType<WorkflowRunReadResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    sessionId: SessionIdSchema,
    definitionId: WorkflowDefinitionIdSchema,
    workflowVersionId: WorkflowVersionIdSchema,
    state: WorkflowRunStatusSchema,
    mode: WorkflowRunModeSchema,
    startedBy: WorkflowStartedBySchema,
    chainRoot: WorkflowChainRootSchema,
    executionContextCaptured: z.boolean(),
    keep: z.boolean(),
    fixSessionId: SessionIdSchema.optional(),
    steps: z.array(WorkflowStepSchema),
    failureReason: z.string().min(1).optional(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

// workflow.runList

/**
 * The `workflow.runList` input: the runs table's four filters (workflow, status,
 * trigger and date range) and the one version scope `Show runs` hands in. Without
 * `sessionId` it lists every run this daemon ran.
 */
export interface WorkflowRunListRequest {
  sessionId?: SessionId | undefined;
  definitionId?: WorkflowDefinitionId | undefined;
  workflowVersionId?: string | undefined;
  status?: WorkflowRunStatus[] | undefined;
  mode?: WorkflowRunMode[] | undefined;
  startedAfter?: string | undefined;
  startedBefore?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
/** Wire schema for {@link WorkflowRunListRequest}. */
export const WorkflowRunListRequestSchema: z.ZodType<
  WorkflowRunListRequest,
  WorkflowRunListRequest
> = z
  .object({
    sessionId: SessionIdSchema.optional(),
    definitionId: WorkflowDefinitionIdSchema.optional(),
    workflowVersionId: WorkflowVersionIdSchema.optional(),
    status: z.array(WorkflowRunStatusSchema).min(1).optional(),
    mode: z.array(WorkflowRunModeSchema).min(1).optional(),
    startedAfter: z.iso.datetime({ offset: true }).optional(),
    startedBefore: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/** Where a going run is: the live step's place in the run and its node's name. */
export interface WorkflowLiveStep {
  index: number;
  total: number;
  nodeName: string;
}

/**
 * One row of the runs table, in the order the row reads it. It names the definition
 * the run came from, because a list answers with runs nobody named. While the run is
 * going it carries its live step and no duration; a waiting run names its cause.
 */
export interface WorkflowRunSummary {
  workflowRunId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  definitionName: string;
  status: WorkflowRunStatus;
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
  startedAt: string;
  durationMs?: number | undefined;
  stepCount: number;
  liveStep?: WorkflowLiveStep | undefined;
  cost?: WorkflowCost | undefined;
  waitCause?: WorkflowWaitCause | undefined;
  resumeAt?: string | undefined;
}
/** Wire schema for {@link WorkflowRunSummary}. */
export const WorkflowRunSummarySchema: z.ZodType<WorkflowRunSummary> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    definitionId: WorkflowDefinitionIdSchema,
    definitionName: z.string().min(1),
    status: WorkflowRunStatusSchema,
    mode: WorkflowRunModeSchema,
    startedBy: WorkflowStartedBySchema,
    startedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().int().nonnegative().optional(),
    stepCount: z.number().int().nonnegative(),
    liveStep: z
      .object({
        index: z.number().int().positive(),
        total: z.number().int().positive(),
        nodeName: z.string().min(1),
      })
      .strict()
      .refine((live) => live.index <= live.total, { message: "The live step is within the run." })
      .optional(),
    cost: WorkflowCostSchema.optional(),
    waitCause: WorkflowWaitCauseSchema.optional(),
    resumeAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((row) => GOING_RUN_STATUSES.includes(row.status) === (row.durationMs === undefined), {
    path: ["durationMs"],
    message: "A finished run carries its duration and a going one does not.",
  })
  .refine((row) => GOING_RUN_STATUSES.includes(row.status) || row.liveStep === undefined, {
    path: ["liveStep"],
    message: "Only a going run has a live step.",
  })
  .refine((row) => (row.status === "waiting") === (row.waitCause !== undefined), {
    path: ["waitCause"],
    message: "A waiting run names its cause, and no other run carries one.",
  })
  .refine((row) => row.status === "waiting" || row.resumeAt === undefined, {
    path: ["resumeAt"],
    message: "Only a waiting run carries a resume instant.",
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
    totalCount: z.number().int().nonnegative(),
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
> = z.object({ olderThan: z.iso.datetime({ offset: true }) }).strict();

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
      deleteCount: z.number().int().nonnegative(),
      keptCount: z.number().int().nonnegative(),
      waitingCount: z.number().int().nonnegative(),
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
  .object({ deletedCount: z.number().int().nonnegative() })
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

/** `workflow.runAttentionList` takes no members: the runs table's filters never narrow it. */
export type WorkflowRunAttentionListRequest = Record<string, never>;
/** Wire schema for {@link WorkflowRunAttentionListRequest}: an empty object. */
export const WorkflowRunAttentionListRequestSchema: z.ZodType<
  WorkflowRunAttentionListRequest,
  WorkflowRunAttentionListRequest
> = z.object({}).strict();

/**
 * One line of the runs-needing-you section. A run waiting on a person is its own line:
 * the workflow's name, what it waits on, and since when. Runs held by one spent provider
 * account fold into one line keyed by that account, with how many runs it holds, since
 * when the oldest waits, and the instant it resumes itself where one is armed.
 */
export type WorkflowRunAttentionEntry =
  | {
      kind: "run";
      workflowRunId: WorkflowRunId;
      workflowName: string;
      waitCause: Exclude<WorkflowWaitCause, "account">;
      waitingSince: string;
    }
  | {
      kind: "account";
      providerAccountId: ProviderAccountId;
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
        waitCause: z.enum(WORKFLOW_WAIT_CAUSES).exclude(["account"]),
        waitingSince: z.iso.datetime({ offset: true }),
      })
      .strict(),
    z
      .object({
        kind: z.literal("account"),
        providerAccountId: ProviderAccountIdSchema,
        affectedRunCount: z.number().int().positive(),
        waitingSince: z.iso.datetime({ offset: true }),
        resumeAt: z.iso.datetime({ offset: true }).optional(),
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
    waitingOnPersonCount: z.number().int().nonnegative(),
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
  .object({ paused: z.boolean(), waitingStartCount: z.number().int().nonnegative() })
  .strict();

// workflow.keptVarsClear

/**
 * The `workflow.keptVarsClear` input: clear every value `Keep for later runs` kept for
 * one workflow. Kept values belong to the workflow, not to a version.
 */
export interface WorkflowKeptVarsClearRequest {
  workflowId: WorkflowDefinitionId;
}
/** Wire schema for {@link WorkflowKeptVarsClearRequest}. */
export const WorkflowKeptVarsClearRequestSchema: z.ZodType<
  WorkflowKeptVarsClearRequest,
  WorkflowKeptVarsClearRequest
> = z.object({ workflowId: WorkflowDefinitionIdSchema }).strict();

/** The `workflow.keptVarsClear` result: how many kept values went. */
export interface WorkflowKeptVarsClearResponse {
  workflowId: WorkflowDefinitionId;
  clearedCount: number;
}
/** Wire schema for {@link WorkflowKeptVarsClearResponse}. */
export const WorkflowKeptVarsClearResponseSchema: z.ZodType<WorkflowKeptVarsClearResponse> = z
  .object({ workflowId: WorkflowDefinitionIdSchema, clearedCount: z.number().int().nonnegative() })
  .strict();

// workflow.subscribe

/**
 * The `workflow.subscribe` input: one subscription for the whole runs surface and the
 * canvas overlay, never one per row. Without `sessionId` it covers every run this
 * daemon ran.
 */
export interface WorkflowSubscribeRequest {
  sessionId?: SessionId | undefined;
  definitionId?: WorkflowDefinitionId | undefined;
}
/** Wire schema for {@link WorkflowSubscribeRequest}. */
export const WorkflowSubscribeRequestSchema: z.ZodType<
  WorkflowSubscribeRequest,
  WorkflowSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema.optional(),
    definitionId: WorkflowDefinitionIdSchema.optional(),
  })
  .strict();

/**
 * One emission of `workflow.subscribe`. The current hold comes first, then run, step
 * and schedule changes as they happen. A definition's change and a removed definition
 * or run ride it too, so no view keeps a row that is gone. A skipped schedule fire is
 * reported here and never becomes a run.
 */
export type WorkflowSubscribeNotification =
  | ({ kind: "runsPause" } & WorkflowRunsPauseState)
  | { kind: "run"; run: WorkflowRunSummary }
  | { kind: "runsRemoved"; workflowRunIds: WorkflowRunId[] }
  | { kind: "step"; workflowRunId: WorkflowRunId; step: WorkflowStep }
  | {
      kind: "schedule";
      definitionId: WorkflowDefinitionId;
      nodeId: WorkflowNodeId;
      event: "armed" | "disarmed" | "fired" | "skipped";
      scheduledAt: string;
      nextFireAt?: string | undefined;
    }
  | { kind: "definition"; definition: WorkflowDefinitionSummary }
  | { kind: "definitionRemoved"; definitionId: WorkflowDefinitionId };
/** Wire schema for {@link WorkflowSubscribeNotification}. */
export const WorkflowSubscribeNotificationSchema: z.ZodType<WorkflowSubscribeNotification> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("runsPause"),
        paused: z.boolean(),
        waitingStartCount: z.number().int().nonnegative(),
      })
      .strict(),
    z.object({ kind: z.literal("run"), run: WorkflowRunSummarySchema }).strict(),
    z
      .object({
        kind: z.literal("runsRemoved"),
        workflowRunIds: z.array(WorkflowRunIdSchema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("step"),
        workflowRunId: WorkflowRunIdSchema,
        step: WorkflowStepSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("schedule"),
        definitionId: WorkflowDefinitionIdSchema,
        nodeId: WorkflowNodeIdSchema,
        event: z.enum(["armed", "disarmed", "fired", "skipped"]),
        scheduledAt: z.iso.datetime({ offset: true }),
        nextFireAt: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("definition"), definition: WorkflowDefinitionSummarySchema })
      .strict(),
    z
      .object({ kind: z.literal("definitionRemoved"), definitionId: WorkflowDefinitionIdSchema })
      .strict(),
  ]);

// Refusals

/** `Delete run` on a new, running or waiting run; nothing is deleted (`Cancel it first.`). */
export type WorkflowRunNotDeletableCode = "workflow.run_not_deletable";
/** The code of a delete on a run that is still going. */
export const WORKFLOW_RUN_NOT_DELETABLE_CODE: WorkflowRunNotDeletableCode =
  "workflow.run_not_deletable";

// The workflow run records method table

/** The `workflow.*` methods that read, list and keep run records, keyed by name. */
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
    WorkflowRunAttentionListRequest,
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
  readonly "workflow.subscribe": SubscriptionMethodDescriptor<
    "workflow.subscribe",
    WorkflowSubscribeRequest,
    SubscribeAckResponse,
    WorkflowSubscribeNotification
  >;
}

/** The `workflow.*` methods that read, list and keep run records. */
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
      requestSchema: WorkflowRunAttentionListRequestSchema,
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
    "workflow.subscribe": {
      method: "workflow.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: WorkflowSubscribeRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: WorkflowSubscribeNotificationSchema,
    },
  });
