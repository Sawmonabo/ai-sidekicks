// The machine's workflow runs as the fixture daemon holds them: the runs the saved workflows of
// `../definitions.ts` made, in every status a run can stand in, a run waiting on a chat reply and a
// chain held behind its question among them. `writes.ts` applies the writes the playback has
// answered over them and `../replies.ts` answers the calls from that state.

import { accountLabel } from "@ai-sidekicks/contracts/provider/account/label";
import type {
  ProviderAccount,
  ProviderAccountId,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import type { QuestionId } from "@ai-sidekicks/contracts/question";
import { encodeEventCursor, type SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowItem,
  WorkflowNodeId,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import {
  GOING_RUN_STATUSES,
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
  WorkflowRunSummary,
} from "@ai-sidekicks/contracts/workflow/run/records";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

import { WORK_ACCOUNT } from "../../settings-replies.js";
import { minutesAgo, minutesAhead, WORKFLOW_FIXTURE_NOW_MS } from "../clock.js";
import {
  DIGEST,
  RELEASE,
  SAVED_WORKFLOWS,
  SUMMARIZE,
  SWEEP,
  SWEEP_CHILD,
  TRIAGE,
  type WorkflowDefinitionRecord,
} from "../definitions.js";

/** The session every unattended run of these workflows lives in. */
export const WORKFLOW_OWN_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3001" as SessionId;

/** The session a fix opens, as the daemon answers `workflow.fixSessionCreate`. */
export const WORKFLOW_FIX_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3002" as SessionId;

/** The chat session the triage workflow's runs live in, where its reply question is asked. */
export const WORKFLOW_CHAT_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3003" as SessionId;

/** The account that pays for the agent steps and is spent in the waiting run. */
export const WORKFLOW_PAYING_ACCOUNT: ProviderAccountId = WORK_ACCOUNT.accountId;

/** The paying account as a wait on it and the attention line it folds into name it. */
export const WORKFLOW_SPENT_ACCOUNT: WorkflowSpentAccount = {
  providerAccountId: WORK_ACCOUNT.accountId,
  provider: WORK_ACCOUNT.provider,
  label: labelOf(WORK_ACCOUNT),
};

/** One run as the fixture daemon holds it: its read and its definition's name. */
export interface WorkflowRunRecord {
  readonly read: WorkflowRunReadResponse;
  readonly definitionName: string;
  /** When it started, in whole minutes before now, so an act that ends it can time it. */
  readonly startedMinutesAgo: number;
  /** How long the run took, for its row; absent while it is going. */
  readonly durationMs?: number;
}

const DEVICE = "device-0001" as DeviceId;

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
  readonly outputRef?: WorkflowPayloadRef;
  readonly question?: WorkflowStepQuestion;
  readonly resolution?: WorkflowStepResolution;
  readonly reviewPause?: WorkflowStepReviewPause;
  readonly childWorkflowRunId?: string;
}

function steps(runId: WorkflowRunId, seeds: readonly StepSeed[]): WorkflowStep[] {
  return seeds.map((seed, index) => {
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
      status: seed.status,
      ...(seed.waitCause === undefined ? {} : { waitCause: seed.waitCause }),
      ...(seed.waitCause === "account" ? { waitAccount: WORKFLOW_SPENT_ACCOUNT } : {}),
      ...(seed.resumeAt === undefined ? {} : { resumeAt: seed.resumeAt }),
      ...(seed.waitDeadlineAt === undefined ? {} : { waitDeadlineAt: seed.waitDeadlineAt }),
      startedAt: minutesAgo(seed.startedMinutesAgo),
      ...(finished ? { finishedAt: minutesAgo(seed.finishedMinutesAgo ?? 0) } : {}),
      inputRef: inline({ from: previous?.nodeId ?? "trigger" }),
      outputRef: seed.outputRef ?? (finished ? inline({ ok: true, node: seed.nodeId }) : inline()),
      logRef: inline(`started ${seed.nodeId}`, ...(finished ? [`finished ${seed.nodeId}`] : [])),
      ...(seed.usdMicros === undefined ? {} : { cost: cost(seed.usdMicros) }),
      ...(seed.error === undefined ? {} : { error: seed.error }),
      ...(seed.question === undefined ? {} : { question: seed.question }),
      ...(seed.resolution === undefined ? {} : { resolution: seed.resolution }),
      ...(seed.reviewPause === undefined ? {} : { reviewPause: seed.reviewPause }),
      ...(seed.childWorkflowRunId === undefined
        ? {}
        : { childWorkflowRunId: seed.childWorkflowRunId as WorkflowRunId }),
    };
  });
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
  readonly state: WorkflowRunStatus;
  readonly mode: WorkflowRunMode;
  readonly startedBy: WorkflowStartedBy;
  readonly startedMinutesAgo: number;
  readonly endedMinutesAgo?: number;
  /** A failed run parked on its failed step, which has not ended: it carries no end. */
  readonly isParked?: boolean;
  readonly steps: readonly StepSeed[];
  readonly liveStep?: WorkflowLiveStep;
  readonly chainRoot?: WorkflowChainRoot;
  readonly chainQuestion?: WorkflowChainQuestion;
  readonly failureReason?: string;
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
  fileEvent: "trigger.file-watch",
  parentWorkflow: "trigger.sub-workflow",
};

function record(seed: RunSeed): WorkflowRunRecord {
  const workflowRunId = seed.id as WorkflowRunId;
  const definition = SAVED_WORKFLOWS.find(
    (candidate) => candidate.summary.id === seed.definitionId,
  );
  if (definition === undefined) {
    throw new RangeError(`run ${seed.id} names ${seed.definitionId}, which no saved workflow is`);
  }
  const definitionName = definition.summary.name;
  const workflowVersionId = `${seed.definitionId}-v${String(seed.versionNumber)}`;
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
  const isFinished = seed.endedMinutesAgo !== undefined && seed.isParked !== true;
  const isCaptured = seed.executionContextCaptured ?? true;
  return {
    definitionName,
    startedMinutesAgo: seed.startedMinutesAgo,
    ...(seed.endedMinutesAgo === undefined
      ? {}
      : { durationMs: (seed.startedMinutesAgo - seed.endedMinutesAgo) * 60_000 }),
    read: {
      workflowRunId,
      sessionId: seed.sessionId ?? WORKFLOW_OWN_SESSION,
      definitionId: seed.definitionId,
      workflowVersionId,
      state: seed.state,
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
      ...(seed.failureReason === undefined ? {} : { failureReason: seed.failureReason }),
      startedAt: minutesAgo(seed.startedMinutesAgo),
      ...(seed.endedMinutesAgo === undefined || !isFinished
        ? {}
        : { endedAt: minutesAgo(seed.endedMinutesAgo) }),
      ...(spent === 0 ? {} : { cost: cost(spent) }),
      ...(seed.liveStep === undefined || isFinished ? {} : { liveStep: seed.liveStep }),
      edgeItemCounts: edgeItemCounts(document, runSteps),
      ...(isFinished && isCaptured ? { review: { state: "pinned", epoch: 1 } as const } : {}),
      ...(seed.chainQuestion === undefined ? {} : { chainQuestion: seed.chainQuestion }),
    },
  };
}

/** The run ids, by the status each run starts the playback in. */
export const WORKFLOW_RUN_IDS = {
  running: "019b7a10-0280-75e5-8510-ada11a5a4001",
  waitingApproval: "019b7a10-0280-75e5-8510-ada11a5a4002",
  waitingForm: "019b7a10-0280-75e5-8510-ada11a5a4003",
  waitingAccount: "019b7a10-0280-75e5-8510-ada11a5a4004",
  failed: "019b7a10-0280-75e5-8510-ada11a5a4005",
  succeeded: "019b7a10-0280-75e5-8510-ada11a5a4006",
  canceled: "019b7a10-0280-75e5-8510-ada11a5a4007",
  crashed: "019b7a10-0280-75e5-8510-ada11a5a4008",
  chained: "019b7a10-0280-75e5-8510-ada11a5a4009",
  waitingReply: "019b7a10-0280-75e5-8510-ada11a5a4010",
  chainHeld: "019b7a10-0280-75e5-8510-ada11a5a4011",
  sweptParent: "019b7a10-0280-75e5-8510-ada11a5a4012",
  sweptChild: "019b7a10-0280-75e5-8510-ada11a5a4013",
} as const;

/** The question the fixture's reply wait holds, answered through `question.resolve`. */
export const WORKFLOW_REPLY_QUESTION: WorkflowStepQuestion = {
  questionId: "019b7a40-0280-75e5-8510-ada11a5a7001" as QuestionId,
  waitId: "019b7a40-0280-75e5-8510-ada11a5a7101",
  prompt: "Which label should these issues get?",
};

/** How many runs the held chain has started from its first run. */
const CHAIN_RUN_COUNT = 100;

/** When the held chain's first run started, in minutes before now. */
const CHAIN_STARTED_MINUTES_AGO = 260;

const SCHEDULE: WorkflowStartedBy = { kind: "schedule" };
/** How a run the person started records its starter. */
export const WORKFLOW_STARTED_BY_PERSON: WorkflowStartedBy = { kind: "user", deviceId: DEVICE };
const FILE_EVENT: WorkflowStartedBy = { kind: "fileEvent" };
const CHAT: WorkflowStartedBy = {
  kind: "chat",
  sessionId: WORKFLOW_CHAT_SESSION,
  messageAnchorCursor: encodeEventCursor(42),
};
const CHAIN_ROOT: WorkflowChainRoot = {
  runId: WORKFLOW_RUN_IDS.chainHeld as WorkflowRunId,
  definitionId: SWEEP,
  workflowName: "Folder sweep",
  startedAt: minutesAgo(CHAIN_STARTED_MINUTES_AGO),
  runCount: CHAIN_RUN_COUNT,
};

/** When the finished sweep and the child run its step called started, in minutes before now. */
const SWEPT_MINUTES_AGO = 2_900;

/** The finished sweep's chain, which the child run its step called joined. */
const SWEPT_CHAIN_ROOT: WorkflowChainRoot = {
  runId: WORKFLOW_RUN_IDS.sweptParent as WorkflowRunId,
  definitionId: SWEEP,
  workflowName: "Folder sweep",
  startedAt: minutesAgo(SWEPT_MINUTES_AGO),
  runCount: 2,
};

/** How many days of the morning digest's finished daily runs the playback holds. */
const DIGEST_HISTORY_DAYS = 60;

/** The daily digest run marked Keep, 45 days back, which `Delete runs older than…` leaves. */
const KEPT_DIGEST_DAYS_AGO = 45;

/** Minutes after midnight the morning digest's schedule fires, and minutes the fixture's now is. */
const DIGEST_FIRES_AT_MINUTE = 7 * 60;
const FIXTURE_NOW_MINUTE = (WORKFLOW_FIXTURE_NOW_MS % 86_400_000) / 60_000;

/**
 * The morning digest's finished daily runs before today, one a day, so the runs table holds more
 * than one page and `Load older runs` has older runs to reach.
 */
const DIGEST_HISTORY: readonly WorkflowRunRecord[] = Array.from(
  { length: DIGEST_HISTORY_DAYS },
  (_unused, index) => {
    const startedMinutesAgo = (index + 1) * 24 * 60 + FIXTURE_NOW_MINUTE - DIGEST_FIRES_AT_MINUTE;
    return record({
      id: `019b7a10-0280-75e5-8510-ada11a5a6${String(index + 1).padStart(3, "0")}`,
      definitionId: DIGEST,
      versionNumber: 2,
      state: "succeeded",
      mode: "trigger",
      startedBy: SCHEDULE,
      startedMinutesAgo,
      endedMinutesAgo: startedMinutesAgo - 4,
      keep: index + 1 === KEPT_DIGEST_DAYS_AGO,
      steps: [
        {
          nodeId: "schedule",
          status: "succeeded",
          startedMinutesAgo,
          finishedMinutesAgo: startedMinutesAgo,
        },
        {
          nodeId: "fetch",
          status: "succeeded",
          startedMinutesAgo,
          finishedMinutesAgo: startedMinutesAgo - 1,
        },
        {
          nodeId: "review",
          status: "succeeded",
          startedMinutesAgo: startedMinutesAgo - 1,
          finishedMinutesAgo: startedMinutesAgo - 3,
        },
        {
          nodeId: "summary",
          status: "succeeded",
          startedMinutesAgo: startedMinutesAgo - 3,
          finishedMinutesAgo: startedMinutesAgo - 4,
        },
      ],
    });
  },
);

/** Every run the playback starts with, before any write is applied. */
export const WORKFLOW_RUN_RECORDS: readonly WorkflowRunRecord[] = [
  record({
    id: WORKFLOW_RUN_IDS.running,
    definitionId: DIGEST,
    versionNumber: 3,
    state: "running",
    mode: "trigger",
    startedBy: SCHEDULE,
    startedMinutesAgo: 5,
    liveStep: { index: 3, total: 4, nodeName: "Review one PR" },
    steps: [
      { nodeId: "schedule", status: "succeeded", startedMinutesAgo: 5, finishedMinutesAgo: 5 },
      { nodeId: "fetch", status: "succeeded", startedMinutesAgo: 5, finishedMinutesAgo: 4 },
      { nodeId: "review", status: "running", startedMinutesAgo: 4, usdMicros: 186_500 },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.waitingApproval,
    definitionId: RELEASE,
    versionNumber: 2,
    state: "waiting",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: 30,
    liveStep: { index: 4, total: 5, nodeName: "Approve release" },
    steps: [
      { nodeId: "manual", status: "succeeded", startedMinutesAgo: 30, finishedMinutesAgo: 30 },
      { nodeId: "build", status: "succeeded", startedMinutesAgo: 30, finishedMinutesAgo: 20 },
      {
        nodeId: "notes",
        status: "succeeded",
        startedMinutesAgo: 20,
        finishedMinutesAgo: 16,
        resolution: { kind: "answered", at: minutesAgo(16) },
      },
      {
        nodeId: "approve",
        status: "waiting",
        startedMinutesAgo: 15,
        waitCause: "approval",
        waitDeadlineAt: minutesAhead(220),
        reviewPause: { state: "pinned", epoch: 1, pauseNumber: 1 },
      },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.waitingForm,
    definitionId: RELEASE,
    versionNumber: 1,
    state: "waiting",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: 130,
    liveStep: { index: 3, total: 5, nodeName: "Release notes" },
    steps: [
      { nodeId: "manual", status: "succeeded", startedMinutesAgo: 130, finishedMinutesAgo: 130 },
      { nodeId: "build", status: "succeeded", startedMinutesAgo: 130, finishedMinutesAgo: 115 },
      { nodeId: "notes", status: "waiting", startedMinutesAgo: 110, waitCause: "form" },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.waitingAccount,
    definitionId: DIGEST,
    versionNumber: 2,
    state: "waiting",
    mode: "trigger",
    startedBy: SCHEDULE,
    startedMinutesAgo: 140,
    liveStep: { index: 3, total: 4, nodeName: "Review one PR" },
    steps: [
      { nodeId: "schedule", status: "succeeded", startedMinutesAgo: 140, finishedMinutesAgo: 140 },
      { nodeId: "fetch", status: "succeeded", startedMinutesAgo: 140, finishedMinutesAgo: 139 },
      {
        nodeId: "review",
        status: "waiting",
        startedMinutesAgo: 138,
        waitCause: "account",
        resumeAt: minutesAhead(40),
        usdMicros: 1_800,
      },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.failed,
    definitionId: SUMMARIZE,
    versionNumber: 1,
    state: "failed",
    mode: "trigger",
    startedBy: FILE_EVENT,
    startedMinutesAgo: 200,
    endedMinutesAgo: 190,
    isParked: true,
    steps: [
      { nodeId: "watch", status: "succeeded", startedMinutesAgo: 200, finishedMinutesAgo: 200 },
      { nodeId: "read", status: "succeeded", startedMinutesAgo: 200, finishedMinutesAgo: 199 },
      {
        nodeId: "summary",
        status: "failed",
        attempt: 2,
        startedMinutesAgo: 199,
        finishedMinutesAgo: 190,
        usdMicros: 52_000,
        error: { message: "The summary came back empty twice.", itemIndex: 1 },
      },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.succeeded,
    definitionId: DIGEST,
    versionNumber: 2,
    state: "succeeded",
    mode: "trigger",
    startedBy: SCHEDULE,
    startedMinutesAgo: 380,
    endedMinutesAgo: 374,
    steps: [
      { nodeId: "schedule", status: "succeeded", startedMinutesAgo: 380, finishedMinutesAgo: 380 },
      { nodeId: "fetch", status: "succeeded", startedMinutesAgo: 380, finishedMinutesAgo: 379 },
      {
        nodeId: "review",
        status: "succeeded",
        startedMinutesAgo: 379,
        finishedMinutesAgo: 375,
        usdMicros: 11_598_200,
      },
      {
        nodeId: "summary",
        status: "succeeded",
        startedMinutesAgo: 375,
        finishedMinutesAgo: 374,
        outputRef: {
          kind: "artifact",
          artifactId: "019b7a20-0280-75e5-8510-ada11a5a5001" as ArtifactId,
          sizeBytes: 182_044,
          itemCount: 12,
        },
      },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.canceled,
    definitionId: RELEASE,
    versionNumber: 1,
    state: "canceled",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: 600,
    endedMinutesAgo: 590,
    failureReason: "Built from the wrong branch.",
    steps: [
      { nodeId: "manual", status: "succeeded", startedMinutesAgo: 600, finishedMinutesAgo: 600 },
      { nodeId: "build", status: "canceled", startedMinutesAgo: 600, finishedMinutesAgo: 590 },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.crashed,
    definitionId: SUMMARIZE,
    versionNumber: 1,
    state: "crashed",
    mode: "trigger",
    startedBy: FILE_EVENT,
    startedMinutesAgo: 740,
    endedMinutesAgo: 735,
    steps: [
      { nodeId: "watch", status: "succeeded", startedMinutesAgo: 740, finishedMinutesAgo: 740 },
      { nodeId: "read", status: "canceled", startedMinutesAgo: 740, finishedMinutesAgo: 735 },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.chained,
    definitionId: SUMMARIZE,
    versionNumber: 1,
    state: "succeeded",
    mode: "trigger",
    startedBy: FILE_EVENT,
    startedMinutesAgo: 720,
    endedMinutesAgo: 719,
    chainRoot: CHAIN_ROOT,
    steps: [
      { nodeId: "watch", status: "succeeded", startedMinutesAgo: 720, finishedMinutesAgo: 720 },
      { nodeId: "read", status: "succeeded", startedMinutesAgo: 720, finishedMinutesAgo: 719 },
      { nodeId: "summary", status: "skipped", startedMinutesAgo: 719, finishedMinutesAgo: 719 },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.waitingReply,
    definitionId: TRIAGE,
    versionNumber: 1,
    state: "waiting",
    mode: "chat",
    startedBy: CHAT,
    startedMinutesAgo: 45,
    sessionId: WORKFLOW_CHAT_SESSION,
    executionContextCaptured: false,
    liveStep: { index: 2, total: 3, nodeName: "Ask for the label" },
    steps: [
      { nodeId: "chat", status: "succeeded", startedMinutesAgo: 45, finishedMinutesAgo: 45 },
      {
        nodeId: "ask",
        status: "waiting",
        startedMinutesAgo: 44,
        waitCause: "reply",
        question: WORKFLOW_REPLY_QUESTION,
      },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.chainHeld,
    definitionId: SWEEP,
    versionNumber: 1,
    state: "waiting",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: CHAIN_STARTED_MINUTES_AGO,
    chainRoot: CHAIN_ROOT,
    chainQuestion: { state: "open" },
    liveStep: { index: 2, total: 2, nodeName: "Summarize each file" },
    steps: [
      {
        nodeId: "manual",
        status: "succeeded",
        startedMinutesAgo: CHAIN_STARTED_MINUTES_AGO,
        finishedMinutesAgo: CHAIN_STARTED_MINUTES_AGO,
      },
      {
        nodeId: "each",
        status: "waiting",
        startedMinutesAgo: CHAIN_STARTED_MINUTES_AGO - 1,
        waitCause: "chain",
      },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.sweptChild,
    definitionId: SWEEP_CHILD,
    versionNumber: 1,
    state: "succeeded",
    mode: "sub-workflow",
    startedBy: {
      kind: "parentWorkflow",
      parentWorkflowRunId: WORKFLOW_RUN_IDS.sweptParent as WorkflowRunId,
    },
    startedMinutesAgo: SWEPT_MINUTES_AGO - 1,
    endedMinutesAgo: SWEPT_MINUTES_AGO - 3,
    chainRoot: SWEPT_CHAIN_ROOT,
    steps: [
      {
        nodeId: "called",
        status: "succeeded",
        startedMinutesAgo: SWEPT_MINUTES_AGO - 1,
        finishedMinutesAgo: SWEPT_MINUTES_AGO - 1,
      },
      {
        nodeId: "summary",
        status: "succeeded",
        startedMinutesAgo: SWEPT_MINUTES_AGO - 1,
        finishedMinutesAgo: SWEPT_MINUTES_AGO - 3,
        usdMicros: 2_140,
      },
    ],
  }),
  record({
    id: WORKFLOW_RUN_IDS.sweptParent,
    definitionId: SWEEP,
    versionNumber: 1,
    state: "succeeded",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: SWEPT_MINUTES_AGO,
    endedMinutesAgo: SWEPT_MINUTES_AGO - 4,
    steps: [
      {
        nodeId: "manual",
        status: "succeeded",
        startedMinutesAgo: SWEPT_MINUTES_AGO,
        finishedMinutesAgo: SWEPT_MINUTES_AGO,
      },
      {
        nodeId: "each",
        status: "succeeded",
        startedMinutesAgo: SWEPT_MINUTES_AGO - 1,
        finishedMinutesAgo: SWEPT_MINUTES_AGO - 4,
        childWorkflowRunId: WORKFLOW_RUN_IDS.sweptChild,
      },
    ],
  }),
  ...DIGEST_HISTORY,
];

/** The saved workflows and their versions, each counting the runs it made. */
export const WORKFLOW_DEFINITION_RECORDS: readonly WorkflowDefinitionRecord[] = SAVED_WORKFLOWS.map(
  (saved) => ({
    ...saved,
    summary: {
      ...saved.summary,
      runCount: WORKFLOW_RUN_RECORDS.filter((run) => run.read.definitionId === saved.summary.id)
        .length,
    },
  }),
);

/** Whether the run is still going, by the contract's set of going statuses. */
export function isGoing(run: WorkflowRunRecord): boolean {
  return GOING_RUN_STATUSES.includes(run.read.state);
}

/** A run's row in the runs table, derived from its read the way the daemon's projection is. */
export function summaryOfRun(run: WorkflowRunRecord): WorkflowRunSummary {
  const { read } = run;
  const isRunGoing = isGoing(run);
  const waitingStep = read.steps.find((step) => step.status === "waiting");
  return {
    workflowRunId: read.workflowRunId,
    sessionId: read.sessionId,
    definitionId: read.definitionId,
    definitionName: run.definitionName,
    status: read.state,
    mode: read.mode,
    triggerKind: read.triggerKind,
    startedBy: read.startedBy,
    startedAt: read.startedAt,
    ...(isRunGoing ? {} : { durationMs: run.durationMs ?? 0 }),
    stepCount: read.steps.filter((step) => step.finishedAt !== undefined).length,
    ...(isRunGoing && read.liveStep !== undefined ? { liveStep: read.liveStep } : {}),
    ...(read.cost === undefined ? {} : { cost: read.cost }),
    ...(read.state === "waiting" && waitingStep?.waitCause !== undefined
      ? { waitCause: waitingStep.waitCause }
      : {}),
    ...(read.state === "waiting" && waitingStep?.resumeAt !== undefined
      ? { resumeAt: waitingStep.resumeAt }
      : {}),
    keep: read.keep,
  };
}

// The fixture's paying account carries its provider-reported identity, so it always has a label.
function labelOf(account: ProviderAccount): string {
  const label = accountLabel(account);
  if (label === undefined) {
    throw new Error("a paying account fixture must carry the identity its provider reported");
  }
  return label;
}
