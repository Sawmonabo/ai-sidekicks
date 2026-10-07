// The acts on a workflow run: starting one, canceling and resuming it, retrying from a
// step, running one node from the builder and posting a finished run's results into a
// session, with their refusals, the run events they write and their method table. A
// descriptor registers nothing.
import { z } from "zod";

import { FILE_PATH_MAX_LEN } from "../../free-form-string.js";
import { jsonUtf8ByteLength } from "../../jsonrpc/message.js";
import { defineMethodDescriptors, type MethodDescriptor } from "../../method-descriptor.js";
import { ProjectIdSchema, type ProjectId } from "../../project.js";
import { SessionIdSchema, type SessionId } from "../../session/id.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowItemSchema,
  WorkflowNodeIdSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowItem,
  type WorkflowNodeId,
  type WorkflowTriggerInput,
} from "../definition/document.js";
import { WorkflowRunStatusSchema, type WorkflowRunStatus } from "./status.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "./id.js";
import { workflowStepKeyShape, type WorkflowStepKey } from "./step/record.js";
import {
  WORKFLOW_RUN_MODES,
  WorkflowRunModeSchema,
  WorkflowStartedBySchema,
  type WorkflowRunMode,
  type WorkflowStartedBy,
} from "./trigger.js";

/**
 * The most bytes a cancellation reason may take, counted as UTF-8 bytes of its JSON encoding
 * (quotes and escapes included) rather than its length, so the same sentence is not refused sooner
 * in one script than in another.
 */
export const WORKFLOW_CANCEL_REASON_BYTE_CAP: number = 8 * 1024;

/**
 * A cancellation's reason as the person typed it, within the byte cap. It is recorded
 * on the run and its canceled event and never reaches a step's output or anything an
 * agent reads.
 */
export const WorkflowCancelReasonSchema: z.ZodType<string, string> = z
  .string()
  .min(1)
  .refine((reason) => jsonUtf8ByteLength(reason) <= WORKFLOW_CANCEL_REASON_BYTE_CAP, {
    message: `reason must be at most ${WORKFLOW_CANCEL_REASON_BYTE_CAP} bytes as JSON.`,
  });

/**
 * A re-pin as a resume's reply and its `workflow.resumed` event record it: on an accepted re-pin
 * both the version the run left and the one it joined, and otherwise neither.
 */
export type WorkflowVersionRepin =
  | { repinnedFromWorkflowVersionId?: undefined; repinnedToWorkflowVersionId?: undefined }
  | { repinnedFromWorkflowVersionId: string; repinnedToWorkflowVersionId: string };
const workflowVersionRepinFields = {
  repinnedFromWorkflowVersionId: WorkflowVersionIdSchema,
  repinnedToWorkflowVersionId: WorkflowVersionIdSchema,
};

// workflow.runStart

/** The start modes a caller may ask for; `retry` and `sub-workflow` come from their own methods. */
type RequestableRunMode = Exclude<WorkflowRunMode, "retry" | "sub-workflow">;

/**
 * The `workflow.runStart` input: the version to run, the session it is started in, the
 * repository it works in, the items it starts on and how the start was made.
 */
export interface WorkflowRunStartRequest {
  /** Taken verbatim from a definition or version read. */
  workflowVersionId: string;
  /** The session the start was made in; absent, the run lives in the workflow's own session. */
  sessionId?: SessionId | undefined;
  /**
   * The project whose folder the run works in: the Run now panel's `Repository`, or the one a
   * chat's start names. A project session's run works in that session's repository, and the
   * daemon refuses a project named on it with {@link WORKFLOW_PROJECT_ON_PROJECT_SESSION_CODE}.
   * Absent on a chat's run, it works in the chat's folder; absent on a start in no session
   * (`None`), the run gets no checkout and works in its own empty folder, and a version holding a
   * Git, Read a repo diff or Run tests step is refused.
   */
  projectId?: ProjectId | undefined;
  /**
   * The items the run starts on, where the workflow declares inputs: the one item's `json` object
   * holds the filled values by input name, and a start leaving a required one unfilled is refused
   * with {@link WORKFLOW_INPUT_REQUIRED_CODE}.
   */
  input?: WorkflowItem[] | undefined;
  mode?: RequestableRunMode | undefined;
}
/** Wire schema for {@link WorkflowRunStartRequest}. */
export const WorkflowRunStartRequestSchema: z.ZodType<
  WorkflowRunStartRequest,
  WorkflowRunStartRequest
> = z
  .object({
    workflowVersionId: WorkflowVersionIdSchema,
    sessionId: SessionIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    input: z.array(WorkflowItemSchema).optional(),
    mode: z.enum(WORKFLOW_RUN_MODES).exclude(["retry", "sub-workflow"]).optional(),
  })
  .strict();

/**
 * The `workflow.runStart` result. A start can only leave the run admitted but not yet
 * dispatched (`new`) or already `running`, so `status` allows only those two. `sessionId`
 * is the session the run lives in.
 */
export interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
  status: Extract<WorkflowRunStatus, "new" | "running">;
}
/** Wire schema for {@link WorkflowRunStartResponse}. */
export const WorkflowRunStartResponseSchema: z.ZodType<WorkflowRunStartResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    sessionId: SessionIdSchema,
    status: WorkflowRunStatusSchema.extract(["new", "running"]),
  })
  .strict();

/** A value a start fills a declared input with: a `boolean` input's flag, any other's text. */
export type WorkflowTriggerInputValue = WorkflowTriggerInput["default"];

/**
 * A start's declared inputs as filled: every input's value by name, or the required inputs the
 * start left unfilled, which are the details of its {@link WORKFLOW_INPUT_REQUIRED_CODE} refusal.
 */
export type WorkflowTriggerInputFill =
  | { kind: "filled"; values: Record<string, WorkflowTriggerInputValue> }
  | { kind: "missing"; details: WorkflowInputRequiredDetails };

/**
 * Fills a workflow's declared inputs from a start's `input`, whose one item's `json` object holds
 * the values by input name. A value counts as filled only where it fits its input: a flag for
 * `boolean`, non-empty text for `string` and `path`, one of the options for `select`. An optional
 * input left out or left as empty text takes its `default`; a required input left unfilled, and any
 * input given a value that does not fit it, is named in the refusal.
 */
export function fillWorkflowTriggerInputs(
  declared: readonly WorkflowTriggerInput[] | undefined,
  input: readonly WorkflowItem[] | undefined,
): WorkflowTriggerInputFill {
  const given = input?.[0]?.json;
  const named =
    typeof given === "object" && given !== null && !Array.isArray(given)
      ? (given as Record<string, unknown>)
      : {};
  const values: [string, WorkflowTriggerInputValue][] = [];
  const missing: string[] = [];
  for (const declaredInput of declared ?? []) {
    // An own member only, so a name such as `constructor` never reads the prototype.
    const value = Object.hasOwn(named, declaredInput.name) ? named[declaredInput.name] : undefined;
    if (fitsTriggerInput(declaredInput, value)) {
      values.push([declaredInput.name, value]);
    } else if (declaredInput.required !== true && (value === undefined || value === "")) {
      values.push([declaredInput.name, declaredInput.default]);
    } else {
      missing.push(declaredInput.name);
    }
  }
  const [firstMissing, ...restMissing] = missing;
  return firstMissing === undefined
    ? { kind: "filled", values: Object.fromEntries(values) }
    : { kind: "missing", details: { inputNames: [firstMissing, ...restMissing] } };
}

function fitsTriggerInput(
  input: WorkflowTriggerInput,
  value: unknown,
): value is WorkflowTriggerInputValue {
  switch (input.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && value !== "";
    case "path":
      return typeof value === "string" && value !== "" && value.length <= FILE_PATH_MAX_LEN;
    case "select":
      return typeof value === "string" && input.options.includes(value);
  }
}

// workflow.runCancel

/**
 * The `workflow.runCancel` input. `reason` is recorded on the run and carried on its
 * canceled event. It never reaches a step's output or anything an agent reads.
 */
export interface WorkflowRunCancelRequest {
  workflowRunId: WorkflowRunId;
  reason?: string | undefined;
}
/** Wire schema for {@link WorkflowRunCancelRequest}. */
export const WorkflowRunCancelRequestSchema: z.ZodType<
  WorkflowRunCancelRequest,
  WorkflowRunCancelRequest
> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    reason: WorkflowCancelReasonSchema.optional(),
  })
  .strict();

/**
 * The `workflow.runCancel` result. Cancel is offered on a new, running or waiting run, and on a
 * failed run parked on its failed step waiting to be resumed; every branch still going is canceled
 * with it. `status` has one value because a successful cancel has one outcome. `alreadyCanceled` is
 * true when the run was already canceled and this call returned the first cancel's saved result: no
 * second event is written, and `canceledEventId` names the original.
 */
export interface WorkflowRunCancelResponse {
  workflowRunId: WorkflowRunId;
  status: Extract<WorkflowRunStatus, "canceled">;
  canceledEventId: string;
  alreadyCanceled: boolean;
}
/** Wire schema for {@link WorkflowRunCancelResponse}. */
export const WorkflowRunCancelResponseSchema: z.ZodType<WorkflowRunCancelResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    status: WorkflowRunStatusSchema.extract(["canceled"]),
    canceledEventId: z.string().min(1),
    alreadyCanceled: z.boolean(),
  })
  .strict();

// workflow.runResume

/**
 * The `workflow.runResume` input. An ordinary resume omits `versionRepin` and continues
 * on the run's pinned version. Only an explicit `versionRepin` moves the run, and it
 * names the target version instead of asking for the latest, so the recorded
 * from-and-to pair is the one the person saw.
 */
export interface WorkflowRunResumeRequest {
  workflowRunId: WorkflowRunId;
  versionRepin?: { targetWorkflowVersionId: string } | undefined;
}
/** Wire schema for {@link WorkflowRunResumeRequest}. */
export const WorkflowRunResumeRequestSchema: z.ZodType<
  WorkflowRunResumeRequest,
  WorkflowRunResumeRequest
> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    versionRepin: z
      .object({ targetWorkflowVersionId: WorkflowVersionIdSchema })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The `workflow.runResume` result. `waiting` is a legal outcome, not a refusal: a resume
 * that reaches a provider account still out of quota waits again, and that new wait is
 * what the person sees. The two repinned ids are present only on an accepted re-pin.
 */
export type WorkflowRunResumeResponse = {
  workflowRunId: WorkflowRunId;
  status: Extract<WorkflowRunStatus, "running" | "waiting">;
} & WorkflowVersionRepin;
const workflowRunResumeResponseFields = {
  workflowRunId: WorkflowRunIdSchema,
  status: WorkflowRunStatusSchema.extract(["running", "waiting"]),
};
/** Wire schema for {@link WorkflowRunResumeResponse}; a re-pin names both versions or neither. */
export const WorkflowRunResumeResponseSchema: z.ZodType<WorkflowRunResumeResponse> = z.union([
  z.object(workflowRunResumeResponseFields).strict(),
  z.object({ ...workflowRunResumeResponseFields, ...workflowVersionRepinFields }).strict(),
]);

// workflow.runRetry

/**
 * The `workflow.runRetry` input: re-run from a named step, which runs again with its
 * descendants while the source run's data stays pinned upstream.
 */
export interface WorkflowRunRetryRequest {
  workflowRunId: WorkflowRunId;
  fromNodeId: WorkflowNodeId;
}
/** Wire schema for {@link WorkflowRunRetryRequest}. */
export const WorkflowRunRetryRequestSchema: z.ZodType<
  WorkflowRunRetryRequest,
  WorkflowRunRetryRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema, fromNodeId: WorkflowNodeIdSchema }).strict();

/** The `workflow.runRetry` result: a new run in `retry` mode; the source run stays readable. */
export interface WorkflowRunRetryResponse {
  workflowRunId: WorkflowRunId;
  sourceWorkflowRunId: WorkflowRunId;
  status: Extract<WorkflowRunStatus, "new" | "running">;
}
/** Wire schema for {@link WorkflowRunRetryResponse}; the new run is never its own source. */
export const WorkflowRunRetryResponseSchema: z.ZodType<WorkflowRunRetryResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    sourceWorkflowRunId: WorkflowRunIdSchema,
    status: WorkflowRunStatusSchema.extract(["new", "running"]),
  })
  .strict()
  .refine((reply) => reply.workflowRunId !== reply.sourceWorkflowRunId, {
    path: ["workflowRunId"],
    message: "A retry is a new run.",
  });

// workflow.runRerun

/**
 * The `workflow.runRerun` input: start a new run of the named run's own pinned version, with the
 * input and mode that run was started with, in the session it lives in. The daemon reads all
 * three from the source run, so the caller names only the run.
 */
export interface WorkflowRunRerunRequest {
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowRunRerunRequest}. */
export const WorkflowRunRerunRequestSchema: z.ZodType<
  WorkflowRunRerunRequest,
  WorkflowRunRerunRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema }).strict();

// workflow.nodeExecute

/**
 * What a node run covers: the node alone (`Run this node`), or the node and its ancestors
 * (`Run from here`).
 */
export const WORKFLOW_NODE_EXECUTE_SCOPES = ["node", "fromHere"] as const;
/** One of {@link WORKFLOW_NODE_EXECUTE_SCOPES}. */
export type WorkflowNodeExecuteScope = (typeof WORKFLOW_NODE_EXECUTE_SCOPES)[number];

/**
 * The `workflow.nodeExecute` input: `Run this node` (`node`) or `Run from here`
 * (`fromHere`, the node and its ancestors) on a saved version, never unsaved bytes.
 * `projectId` is the project the builder's `Repository` panel names for a node run on a `chat` or
 * `sub-workflow` trigger, which carries no `Repository` of its own; it is absent for `None` and on
 * every other trigger, whose `Repository` the daemon reads. `dirtyNodeIds` is the builder's hint;
 * the daemon decides what it runs and reuses.
 */
export interface WorkflowNodeExecuteRequest {
  workflowVersionId: string;
  sessionId?: SessionId | undefined;
  projectId?: ProjectId | undefined;
  nodeId: WorkflowNodeId;
  scope: WorkflowNodeExecuteScope;
  dirtyNodeIds?: WorkflowNodeId[] | undefined;
}
/** Wire schema for {@link WorkflowNodeExecuteRequest}. */
export const WorkflowNodeExecuteRequestSchema: z.ZodType<
  WorkflowNodeExecuteRequest,
  WorkflowNodeExecuteRequest
> = z
  .object({
    workflowVersionId: WorkflowVersionIdSchema,
    sessionId: SessionIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    nodeId: WorkflowNodeIdSchema,
    scope: z.enum(WORKFLOW_NODE_EXECUTE_SCOPES),
    dirtyNodeIds: z.array(WorkflowNodeIdSchema).optional(),
  })
  .strict();

/** The `workflow.nodeExecute` result: the nodes the daemon ran, in order, and those it reused. */
export interface WorkflowNodeExecuteResponse {
  workflowRunId: WorkflowRunId;
  executedNodeIds: WorkflowNodeId[];
  reusedNodeIds: WorkflowNodeId[];
}
/** Wire schema for {@link WorkflowNodeExecuteResponse}. */
export const WorkflowNodeExecuteResponseSchema: z.ZodType<WorkflowNodeExecuteResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    executedNodeIds: z.array(WorkflowNodeIdSchema),
    reusedNodeIds: z.array(WorkflowNodeIdSchema),
  })
  .strict();

// workflow.resultsPost

/**
 * The `workflow.resultsPost` input: pull a finished run's results into the session the
 * `/workflow results` verb was typed in, which the daemon checks is the caller's own.
 * The agent tool takes no session; the daemon derives it from the invoking turn.
 */
export interface WorkflowResultsPostRequest {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
}
/** Wire schema for {@link WorkflowResultsPostRequest}. */
export const WorkflowResultsPostRequestSchema: z.ZodType<
  WorkflowResultsPostRequest,
  WorkflowResultsPostRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema, sessionId: SessionIdSchema }).strict();

/** The `workflow.resultsPost` result. */
export interface WorkflowResultsPostResponse {
  workflowRunId: WorkflowRunId;
  posted: true;
}
/** Wire schema for {@link WorkflowResultsPostResponse}. */
export const WorkflowResultsPostResponseSchema: z.ZodType<WorkflowResultsPostResponse> = z
  .object({ workflowRunId: WorkflowRunIdSchema, posted: z.literal(true) })
  .strict();

// Refusals

// A refusal that names the nodes it is about names at least one.
const refusedNodeIdsSchema = z.tuple([WorkflowNodeIdSchema], WorkflowNodeIdSchema);

/**
 * A start the policy check denied, or whose principal could not be resolved.
 *
 * @consumedBy the handler that returns the `workflow.start_denied` error
 */
export const WORKFLOW_START_DENIED_CODE = "workflow.start_denied" as const;

/**
 * A start in a project session that names a project: the run works in that session's repository,
 * so it names no other. Nothing runs.
 *
 * @consumedBy the start handler that refuses a project on a project session's run
 */
export const WORKFLOW_PROJECT_ON_PROJECT_SESSION_CODE =
  "workflow.project_on_project_session" as const;

/**
 * A start or a node run that works in no project's repository, a `None` run or a chat's run that
 * names none, of a version holding a Git, Read a repo diff or Run tests step. Nothing runs.
 *
 * @consumedBy the start and node-run handlers that refuse a run needing a repository
 */
export const WORKFLOW_REPOSITORY_REQUIRED_CODE = "workflow.repository_required" as const;
/** The repository refusal's details: the nodes that need a repository. */
export interface WorkflowRepositoryRequiredDetails {
  nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
}
/** Wire schema for {@link WorkflowRepositoryRequiredDetails}. */
export const WorkflowRepositoryRequiredDetailsSchema: z.ZodType<WorkflowRepositoryRequiredDetails> =
  z.object({ nodeIds: refusedNodeIdsSchema }).strict();

/**
 * A start that leaves a required input of the workflow unfilled. Nothing runs.
 *
 * @consumedBy the start handler that refuses a start missing a required input
 */
export const WORKFLOW_INPUT_REQUIRED_CODE = "workflow.input_required" as const;
/** The missing-input refusal's details: the required inputs the start left unfilled, by name. */
export interface WorkflowInputRequiredDetails {
  inputNames: [string, ...string[]];
}
/** Wire schema for {@link WorkflowInputRequiredDetails}. */
export const WorkflowInputRequiredDetailsSchema: z.ZodType<
  WorkflowInputRequiredDetails,
  WorkflowInputRequiredDetails
> = z.object({ inputNames: z.tuple([z.string().min(1)], z.string().min(1)) }).strict();

/**
 * A start of a version whose Code steps' packages are not locked; a later save that locks them
 * makes the version runnable. Nothing runs.
 *
 * @consumedBy the start handler that refuses a version whose Code packages are not locked
 */
export const WORKFLOW_CODE_PACKAGES_NOT_LOCKED_CODE = "workflow.code_packages_not_locked" as const;
/** The unlocked-packages refusal's details: the Code nodes whose packages are not locked. */
export interface WorkflowCodePackagesNotLockedDetails {
  nodeIds: [WorkflowNodeId, ...WorkflowNodeId[]];
}
/**
 * Wire schema for {@link WorkflowCodePackagesNotLockedDetails}.
 *
 * @consumedBy the start handler that refuses a version whose Code packages are not locked
 */
export const WorkflowCodePackagesNotLockedDetailsSchema: z.ZodType<WorkflowCodePackagesNotLockedDetails> =
  z.object({ nodeIds: refusedNodeIdsSchema }).strict();

/**
 * A cancel on a run that has ended: there is nothing left to cancel. A failed run waiting on Resume
 * has not ended and is canceled; a run already `canceled` is not refused, the cancel returns the
 * first's outcome.
 */
export const WORKFLOW_RUN_NOT_CANCELABLE_CODE = "workflow.run_not_cancelable" as const;

/** A resume on a run that is not waiting: there is no wait to lift. */
export const WORKFLOW_RESUME_NOT_PARKED_CODE = "workflow.resume_not_parked" as const;

/**
 * A version re-pin on a run that is not waiting; a going run is never re-pinned.
 *
 * @consumedBy the handler that returns the `workflow.repair_not_parked` error
 */
export const WORKFLOW_REPAIR_NOT_PARKED_CODE = "workflow.repair_not_parked" as const;

/**
 * A version re-pin while one of the run's steps is still in flight.
 *
 * @consumedBy the handler that returns the `workflow.repair_attempt_in_flight` error
 */
export const WORKFLOW_REPAIR_ATTEMPT_IN_FLIGHT_CODE = "workflow.repair_attempt_in_flight" as const;

/**
 * A version re-pin whose target cannot account for the steps the run already finished:
 * it drops a node whose output the run holds, or leaves a finished node unreachable.
 *
 * @consumedBy the handler that returns the `workflow.repair_version_unaccountable` error
 */
export const WORKFLOW_REPAIR_VERSION_UNACCOUNTABLE_CODE =
  "workflow.repair_version_unaccountable" as const;

/**
 * A run or step move its status does not allow: retrying from a step that did not fail,
 * posting the results of an unfinished run, or opening a fix session on a step that did
 * not fail.
 */
export const WORKFLOW_INVALID_TRANSITION_CODE = "workflow.invalid_transition" as const;

/** A retry the daemon cannot make now; the reason says why. */
export const WORKFLOW_RETRY_UNAVAILABLE_CODE = "workflow.retry_unavailable" as const;
/** Why a retry cannot be made: the source run is still going. */
export const WORKFLOW_RETRY_UNAVAILABLE_REASONS = ["source_running"] as const;
/** One of {@link WORKFLOW_RETRY_UNAVAILABLE_REASONS}. */
export type WorkflowRetryUnavailableReason = (typeof WORKFLOW_RETRY_UNAVAILABLE_REASONS)[number];
/** The retry refusal's details. */
export interface WorkflowRetryUnavailableDetails {
  reason: WorkflowRetryUnavailableReason;
}
/**
 * Wire schema for {@link WorkflowRetryUnavailableDetails}.
 *
 * @consumedBy the handler that returns the `workflow.retry_unavailable` error
 */
export const WorkflowRetryUnavailableDetailsSchema: z.ZodType<WorkflowRetryUnavailableDetails> = z
  .object({ reason: z.enum(WORKFLOW_RETRY_UNAVAILABLE_REASONS) })
  .strict();

// Run events

/** The run a run event names: its session, its id, and the definition and version it pins. */
export interface WorkflowRunEventPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
}
/** The members of {@link WorkflowRunEventPayload}, spread into each run event's schema. */
export const workflowRunEventFields: {
  sessionId: z.ZodType<SessionId, SessionId>;
  workflowRunId: z.ZodType<WorkflowRunId, WorkflowRunId>;
  definitionId: z.ZodType<WorkflowDefinitionId, WorkflowDefinitionId>;
  workflowVersionId: z.ZodType<string, string>;
} = {
  sessionId: SessionIdSchema,
  workflowRunId: WorkflowRunIdSchema,
  definitionId: WorkflowDefinitionIdSchema,
  workflowVersionId: WorkflowVersionIdSchema,
};

/** `workflow.started`: how the run was started and by whom, so the run row rebuilds from events. */
export interface WorkflowStartedPayload extends WorkflowRunEventPayload {
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
}
/** Wire schema for {@link WorkflowStartedPayload}. */
export const WorkflowStartedPayloadSchema: z.ZodType<WorkflowStartedPayload> = z
  .object({
    ...workflowRunEventFields,
    mode: WorkflowRunModeSchema,
    startedBy: WorkflowStartedBySchema,
  })
  .strict();

/**
 * `workflow.canceled`, written with the status in one step, so rebuilding the run from
 * the log cannot bring a canceled run back. `reason` is the person's, when one was
 * given; a chain's `Stop them all` cancels with none.
 */
export interface WorkflowCanceledPayload extends WorkflowRunEventPayload {
  reason?: string | undefined;
}
/** Wire schema for {@link WorkflowCanceledPayload}. */
export const WorkflowCanceledPayloadSchema: z.ZodType<WorkflowCanceledPayload> = z
  .object({
    ...workflowRunEventFields,
    reason: WorkflowCancelReasonSchema.optional(),
  })
  .strict();

/** One step a resumed run picks up, by its node, its attempt and which execution of the node. */
export type WorkflowResumedStep = Omit<WorkflowStepKey, "workflowRunId">;

/**
 * Where a resumed run picks up, so a reader rebuilds it without replaying the run's whole history:
 * the steps going on and the approval steps still waiting for an answer.
 */
export interface WorkflowResumptionPoint {
  activeSteps: WorkflowResumedStep[];
  pendingGates: WorkflowNodeId[];
}

/**
 * `workflow.resumed`: a person or an armed schedule resumed a waiting or failed run, with where it
 * picks up and, only on an accepted re-pin, the version it left and the one it joined.
 */
export type WorkflowResumedPayload = WorkflowRunEventPayload & {
  resumptionPoint: WorkflowResumptionPoint;
} & WorkflowVersionRepin;
const workflowResumedFields = {
  ...workflowRunEventFields,
  resumptionPoint: z
    .object({
      activeSteps: z.array(
        z
          .object({
            nodeId: workflowStepKeyShape.nodeId,
            attempt: workflowStepKeyShape.attempt,
            executionIndex: workflowStepKeyShape.executionIndex,
          })
          .strict(),
      ),
      pendingGates: z.array(WorkflowNodeIdSchema),
    })
    .strict(),
};
/** Wire schema for {@link WorkflowResumedPayload}; a re-pin names both versions or neither. */
export const WorkflowResumedPayloadSchema: z.ZodType<WorkflowResumedPayload> = z.union([
  z.object(workflowResumedFields).strict(),
  z.object({ ...workflowResumedFields, ...workflowVersionRepinFields }).strict(),
]);

/**
 * `workflow.results_posted`: a finished run's results landed as the results row in
 * `sessionId`, the session that asked. It follows the run's final status.
 */
export interface WorkflowResultsPostedPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowResultsPostedPayload}. */
export const WorkflowResultsPostedPayloadSchema: z.ZodType<WorkflowResultsPostedPayload> = z
  .object({ sessionId: SessionIdSchema, workflowRunId: WorkflowRunIdSchema })
  .strict();

// The workflow run control method table

/** The `workflow.*` methods that act on a run, keyed by name. */
export interface WorkflowRunControlMethodDescriptors {
  readonly "workflow.runStart": MethodDescriptor<
    "workflow.runStart",
    WorkflowRunStartRequest,
    WorkflowRunStartResponse
  >;
  readonly "workflow.runCancel": MethodDescriptor<
    "workflow.runCancel",
    WorkflowRunCancelRequest,
    WorkflowRunCancelResponse
  >;
  readonly "workflow.runResume": MethodDescriptor<
    "workflow.runResume",
    WorkflowRunResumeRequest,
    WorkflowRunResumeResponse
  >;
  readonly "workflow.runRetry": MethodDescriptor<
    "workflow.runRetry",
    WorkflowRunRetryRequest,
    WorkflowRunRetryResponse
  >;
  readonly "workflow.runRerun": MethodDescriptor<
    "workflow.runRerun",
    WorkflowRunRerunRequest,
    WorkflowRunStartResponse
  >;
  readonly "workflow.nodeExecute": MethodDescriptor<
    "workflow.nodeExecute",
    WorkflowNodeExecuteRequest,
    WorkflowNodeExecuteResponse
  >;
  readonly "workflow.resultsPost": MethodDescriptor<
    "workflow.resultsPost",
    WorkflowResultsPostRequest,
    WorkflowResultsPostResponse
  >;
}

/**
 * The `workflow.*` methods that act on a run.
 */
export const WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS: WorkflowRunControlMethodDescriptors =
  defineMethodDescriptors({
    "workflow.runStart": {
      method: "workflow.runStart",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunStartRequestSchema,
      responseSchema: WorkflowRunStartResponseSchema,
    },
    "workflow.runCancel": {
      method: "workflow.runCancel",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunCancelRequestSchema,
      responseSchema: WorkflowRunCancelResponseSchema,
    },
    "workflow.runResume": {
      method: "workflow.runResume",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunResumeRequestSchema,
      responseSchema: WorkflowRunResumeResponseSchema,
    },
    "workflow.runRetry": {
      method: "workflow.runRetry",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunRetryRequestSchema,
      responseSchema: WorkflowRunRetryResponseSchema,
    },
    "workflow.runRerun": {
      method: "workflow.runRerun",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunRerunRequestSchema,
      responseSchema: WorkflowRunStartResponseSchema,
    },
    "workflow.nodeExecute": {
      method: "workflow.nodeExecute",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowNodeExecuteRequestSchema,
      responseSchema: WorkflowNodeExecuteResponseSchema,
    },
    "workflow.resultsPost": {
      method: "workflow.resultsPost",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowResultsPostRequestSchema,
      responseSchema: WorkflowResultsPostResponseSchema,
    },
  });
