// The seeds the fixture daemon's workflow runs are built from: the sessions and the paying account
// they name, and how a run's seed, its steps' among them, becomes the record `records.ts` holds.

import type {
  WorkflowItem,
  WorkflowStepError,
} from "@ai-sidekicks/contracts/workflow/definition/item";
import type {
  ProviderAccount,
  ProviderAccountId,
} from "@ai-sidekicks/contracts/provider/account/record";
import { accountLabel } from "@ai-sidekicks/contracts/provider/account/label";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import { type SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowNodeId,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import {
  type WorkflowRunStatus,
  type WorkflowStepStatus,
  type WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type {
  WorkflowCost,
  WorkflowPayloadRef,
  WorkflowSpentAccount,
  WorkflowStep,
  WorkflowStepProcessExit,
  WorkflowStepQuestion,
  WorkflowStepResolution,
  WorkflowStepReviewPause,
} from "@ai-sidekicks/contracts/workflow/run/step/record";
import type {
  WorkflowRunMode,
  WorkflowStartedBy,
  WorkflowTriggerKind,
} from "@ai-sidekicks/contracts/workflow/run/trigger";
import type {
  WorkflowChainQuestion,
  WorkflowChainRoot,
  WorkflowEdgeItemCount,
  WorkflowLiveStep,
  WorkflowRunReadResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { WORK_ACCOUNT } from "../../settings-replies.js";
import { minutesAgo } from "../clock.js";
import { SAVED_WORKFLOWS, workflowVersionIdOf } from "../definitions.js";

/** The session every unattended run of these workflows lives in. */
export const WORKFLOW_OWN_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3001" as SessionId;

/** The session a fix opens, as the daemon answers `workflow.fixSession.create`. */
export const WORKFLOW_FIX_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3002" as SessionId;

/** The chat session the triage workflow's runs live in, where its reply question is asked. */
export const WORKFLOW_CHAT_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3003" as SessionId;

/** The account that pays for the agent steps and is spent in the waiting run. */
export const WORKFLOW_PAYING_ACCOUNT: ProviderAccountId = WORK_ACCOUNT.accountId;

/**
 * The paying account as a wait on it and the attention line it folds into name it, with the label
 * the daemon words from the identity its provider reported.
 */
export const WORKFLOW_SPENT_ACCOUNT: WorkflowSpentAccount = {
  providerAccountId: WORK_ACCOUNT.accountId,
  provider: WORK_ACCOUNT.provider,
  label: labelOf(WORK_ACCOUNT),
};

// The paying account carries the identity its provider reported, so it always has a label; the
// provider's name only words a typed label, which the account has none of.
function labelOf(account: ProviderAccount): string {
  const label = accountLabel(account, "Claude Code", []);
  if (label === undefined) {
    throw new Error("a paying account fixture must carry the identity its provider reported");
  }
  return label;
}

/** One run as the fixture daemon holds it: its read and its definition's name. */
export interface WorkflowRunRecord {
  readonly read: WorkflowRunReadResponse;
  readonly definitionName: string;
  /** When it started, in whole minutes before now, so an act that ends it can time it. */
  readonly startedMinutesAgo: number;
  /** How long the run took, for its row; absent while it is going. */
  readonly durationMs?: number;
}

/** The device a person's runs in these fixtures were started from. */
export const WORKFLOW_DEVICE = "device-0001" as DeviceId;

function inline(...values: readonly unknown[]): WorkflowPayloadRef {
  return { kind: "inline", items: values.map((json): WorkflowItem => ({ json })) };
}

function cost(usdMicros: number): WorkflowCost {
  return { usdMicros, providerAccountId: WORKFLOW_PAYING_ACCOUNT };
}

interface StepSeed {
  readonly nodeId: string;
  readonly status: WorkflowStepStatus;
  readonly startedMinutesAgo: number;
  readonly finishedMinutesAgo?: number;
  readonly attempt?: number;
  readonly waitCause?: WorkflowWaitCause;
  readonly resumeAt?: string;
  readonly waitDeadlineAt?: string;
  readonly usdMicros?: number;
  readonly error?: WorkflowStep["error"];
  readonly processExit?: WorkflowStepProcessExit;
  readonly outputRef?: WorkflowPayloadRef;
  readonly question?: WorkflowStepQuestion;
  readonly resolution?: WorkflowStepResolution;
  readonly reviewPause?: WorkflowStepReviewPause;
  readonly childWorkflowRunId?: string;
}

function steps(runId: WorkflowRunId, seeds: readonly StepSeed[]): WorkflowStep[] {
  return seeds.map((seed, index): WorkflowStep => {
    const previous = seeds[index - 1];
    const finished = seed.finishedMinutesAgo !== undefined;
    return {
      workflowRunId: runId,
      nodeId: seed.nodeId as WorkflowNodeId,
      attempt: seed.attempt ?? 1,
      executionIndex: index,
      source:
        previous === undefined
          ? []
          : [
              {
                nodeId: previous.nodeId as WorkflowNodeId,
                outputIndex: 0,
                executionIndex: index - 1,
              },
            ],
      ...statusOfStep(seed),
      startedAt: minutesAgo(seed.startedMinutesAgo),
      ...(finished ? { finishedAt: minutesAgo(seed.finishedMinutesAgo ?? 0) } : {}),
      inputRef: inline({ from: previous?.nodeId ?? "trigger" }),
      outputRef: seed.outputRef ?? (finished ? inline({ ok: true, node: seed.nodeId }) : inline()),
      logRef: inline(`started ${seed.nodeId}`, ...(finished ? [`finished ${seed.nodeId}`] : [])),
      totalPoolWaitMs: 0,
      ...(seed.usdMicros === undefined ? {} : { cost: cost(seed.usdMicros) }),
      ...(seed.error === undefined ? {} : { error: seed.error }),
      ...(seed.reviewPause === undefined ? {} : { reviewPause: seed.reviewPause }),
      ...(seed.childWorkflowRunId === undefined
        ? {}
        : { childWorkflowRunId: seed.childWorkflowRunId as WorkflowRunId }),
    };
  });
}

/** The members of a step record that its status and wait decide, one arm per status and cause. */
type StepStatus = WorkflowStep extends infer Arm
  ? Arm extends WorkflowStep
    ? Pick<
        Arm,
        | "status"
        | "waitCause"
        | "waitAccount"
        | "resumeAt"
        | "waitDeadlineAt"
        | "question"
        | "processExit"
        | "resolution"
      >
    : never
  : never;

// A seeded step's status with what it waits on, or, once it waits no more, how a person answered
// it.
function statusOfStep(seed: StepSeed): StepStatus {
  const deadline = seed.waitDeadlineAt === undefined ? {} : { waitDeadlineAt: seed.waitDeadlineAt };
  const answered = seed.resolution === undefined ? {} : { resolution: seed.resolution };
  switch (seed.status) {
    case "pending":
      return { status: "pending", ...answered };
    case "running":
      return { status: "running", ...answered };
    case "waitingMemory":
      return { status: "waitingMemory", ...answered };
    case "succeeded":
      return { status: "succeeded", ...answered };
    case "skipped":
      return { status: "skipped", ...answered };
    case "canceled":
      return { status: "canceled", ...answered };
    case "failed":
      return seed.processExit === undefined
        ? { status: "failed", ...answered }
        : { status: "failed", processExit: seed.processExit, ...answered };
    case "waiting":
      break;
  }
  switch (seed.waitCause) {
    case "account":
      return seed.resumeAt === undefined
        ? { status: "waiting", waitCause: "account", waitAccount: WORKFLOW_SPENT_ACCOUNT }
        : {
            status: "waiting",
            waitCause: "account",
            waitAccount: WORKFLOW_SPENT_ACCOUNT,
            resumeAt: seed.resumeAt,
          };
    case "reply":
      if (seed.question === undefined) {
        throw new RangeError(`step ${seed.nodeId} waits for a reply, so it holds its question`);
      }
      return { status: "waiting", waitCause: "reply", question: seed.question, ...deadline };
    case "approval":
      return { status: "waiting", waitCause: "approval", ...deadline };
    case "form":
      return { status: "waiting", waitCause: "form", ...deadline };
    case "chain":
      return { status: "waiting", waitCause: "chain" };
    default:
      throw new RangeError(`step ${seed.nodeId} waits, so it names what it waits on`);
  }
}

/**
 * How many items went through each edge: a finished step's output, counted at the edges that
 * leave its node, the way the daemon sums every pass.
 */
function edgeItemCounts(
  document: WorkflowDocument | undefined,
  runSteps: readonly WorkflowStep[],
): WorkflowEdgeItemCount[] {
  return (document?.edges ?? []).flatMap((edge) => {
    const step = runSteps.find(
      (candidate) => candidate.nodeId === edge.source && candidate.finishedAt !== undefined,
    );
    if (step === undefined) {
      return [];
    }
    const itemCount =
      step.outputRef.kind === "inline" ? step.outputRef.items.length : step.outputRef.itemCount;
    return [{ edgeId: edge.id, itemCount }];
  });
}

interface RunSeed {
  readonly id: string;
  readonly definitionId: WorkflowDefinitionId;
  readonly versionNumber: number;
  readonly status: WorkflowRunStatus;
  readonly mode: WorkflowRunMode;
  readonly startedBy: WorkflowStartedBy;
  readonly startedMinutesAgo: number;
  readonly finishedMinutesAgo?: number;
  /** A failed run parked on its failed step, which has not ended: it carries no end. */
  readonly isParked?: boolean;
  readonly steps: readonly StepSeed[];
  readonly liveStep?: WorkflowLiveStep;
  readonly chainRoot?: WorkflowChainRoot;
  readonly chainQuestion?: WorkflowChainQuestion;
  readonly error?: WorkflowStepError;
  readonly keep?: boolean;
  readonly sessionId?: SessionId;
  /** False for a run in a chat session, which records no checkout and so offers no Review. */
  readonly executionContextCaptured?: boolean;
}

/** The trigger kind each starter's run records in these fixtures. */
const TRIGGER_KIND_BY_STARTER: Readonly<Record<WorkflowStartedBy["kind"], WorkflowTriggerKind>> = {
  user: "trigger.manual",
  schedule: "trigger.schedule",
  chat: "trigger.chat",
  agent: "trigger.manual",
  webhook: "trigger.webhook",
  fileEvent: "trigger.fileWatch",
  parentWorkflow: "trigger.subWorkflow",
};

/** One run's record, built from its seed against the saved workflow and version it names. */
export function buildRunRecord(seed: RunSeed): WorkflowRunRecord {
  const workflowRunId = seed.id as WorkflowRunId;
  const definition = SAVED_WORKFLOWS.find(
    (candidate) => candidate.summary.id === seed.definitionId,
  );
  if (definition === undefined) {
    throw new RangeError(`run ${seed.id} names ${seed.definitionId}, which no saved workflow is`);
  }
  const definitionName = definition.summary.name;
  const workflowVersionId = workflowVersionIdOf(seed.definitionId, seed.versionNumber);
  const document = definition.versions.find(
    (version) => version.versionId === workflowVersionId,
  )?.document;
  if (document === undefined) {
    throw new RangeError(
      `run ${seed.id} names ${workflowVersionId}, which ${definitionName} lacks`,
    );
  }
  const runSteps = steps(workflowRunId, seed.steps);
  const spent = runSteps.reduce((total, step) => total + (step.cost?.usdMicros ?? 0), 0);
  const isFinished = seed.finishedMinutesAgo !== undefined && seed.isParked !== true;
  const isCaptured = seed.executionContextCaptured ?? true;
  return {
    definitionName,
    startedMinutesAgo: seed.startedMinutesAgo,
    ...(seed.finishedMinutesAgo === undefined || !isFinished
      ? {}
      : { durationMs: (seed.startedMinutesAgo - seed.finishedMinutesAgo) * 60_000 }),
    read: {
      workflowRunId,
      sessionId: seed.sessionId ?? WORKFLOW_OWN_SESSION,
      definitionId: seed.definitionId,
      workflowVersionId,
      ...endOfRun(seed, isFinished, isCaptured),
      mode: seed.mode,
      triggerKind: TRIGGER_KIND_BY_STARTER[seed.startedBy.kind],
      startedBy: seed.startedBy,
      chainRoot: seed.chainRoot ?? {
        runId: workflowRunId,
        definitionId: seed.definitionId,
        workflowName: definitionName,
        startedAt: minutesAgo(seed.startedMinutesAgo),
        runCount: 1,
      },
      executionContextCaptured: isCaptured,
      keep: seed.keep ?? false,
      steps: runSteps,
      startedAt: minutesAgo(seed.startedMinutesAgo),
      ...(spent === 0 ? {} : { cost: cost(spent) }),
      edgeItemCounts: edgeItemCounts(document, runSteps),
      ...(seed.chainQuestion === undefined ? {} : { chainQuestion: seed.chainQuestion }),
    },
  };
}

/** The members of a run's read that its status decides, one arm per status. */
type RunEnd = WorkflowRunReadResponse extends infer Read
  ? Read extends WorkflowRunReadResponse
    ? Pick<Read, "status" | "finishedAt" | "error" | "liveStep" | "review">
    : never
  : never;

// A run's status with its end, its error and what only its status carries: a going run carries
// the step it is on and no end, a failed run parked on its failed step carries no end, an ended run
// carries its end and, where its checkout was recorded, the snapshot Review opens, and only a
// failed, canceled or crashed run says why.
function endOfRun(seed: RunSeed, isFinished: boolean, isCaptured: boolean): RunEnd {
  const finishedAt =
    seed.finishedMinutesAgo === undefined || !isFinished
      ? undefined
      : minutesAgo(seed.finishedMinutesAgo);
  const ended = (): string => {
    if (finishedAt === undefined) {
      throw new RangeError(`run ${seed.id} has ended, so it names when`);
    }
    return finishedAt;
  };
  const error = seed.error === undefined ? {} : { error: seed.error };
  const review = isFinished && isCaptured ? { review: { state: "pinned", epoch: 1 } as const } : {};
  const live = seed.liveStep === undefined ? {} : { liveStep: seed.liveStep };
  if (seed.error !== undefined && !["failed", "canceled", "crashed"].includes(seed.status)) {
    throw new RangeError(`run ${seed.id} did not fail, so it carries no error`);
  }
  switch (seed.status) {
    case "new":
      return { status: "new", ...live };
    case "running":
      return { status: "running", ...live };
    case "waiting":
      return { status: "waiting", ...live };
    case "succeeded":
      return { status: "succeeded", finishedAt: ended(), ...review };
    case "failed":
      return finishedAt === undefined
        ? { status: "failed", ...error }
        : { status: "failed", finishedAt, ...error, ...review };
    case "canceled":
      return { status: "canceled", finishedAt: ended(), ...error, ...review };
    case "crashed":
      return { status: "crashed", finishedAt: ended(), ...error, ...review };
  }
}
