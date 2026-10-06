// The machine's workflow runs as the fixture daemon holds them: five saved workflows and the runs
// they made in every status a run can stand in, a run waiting on a chat reply and a chain held
// behind its question among them. `writes.ts` applies the writes the playback has answered over
// them and `replies.ts` answers the calls from that state.
//
// Every instant is a whole number of minutes before the scenario's start, built from the epoch
// rather than parsed, so no stamp depends on the host's zone.

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import type { QuestionId } from "@ai-sidekicks/contracts/question";
import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowItem,
  WorkflowNode,
  WorkflowNodeId,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type {
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow/run/status";
import type {
  WorkflowCost,
  WorkflowPayloadRef,
  WorkflowStep,
  WorkflowStepQuestion,
  WorkflowStepResolution,
  WorkflowStepReviewPause,
} from "@ai-sidekicks/contracts/workflow/run/step";
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
import type { ArtifactId } from "@ai-sidekicks/contracts/provider/driver/intervention";

/** The instant the playback calls now, matching the scenario these replies are spread into. */
export const WORKFLOW_FIXTURE_NOW_MS: number = Date.UTC(2026, 0, 1, 14, 20);

/** The session every unattended run of these workflows lives in. */
export const WORKFLOW_OWN_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3001" as SessionId;

/** The session a fix opens, as the daemon answers `workflow.fixSessionCreate`. */
export const WORKFLOW_FIX_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3002" as SessionId;

/** The chat session the triage workflow's runs live in, where its reply question is asked. */
export const WORKFLOW_CHAT_SESSION = "019b7a00-0280-75e5-8510-ada11a5a3003" as SessionId;

/** The account that pays for the agent steps and is spent in the waiting run. */
export const WORKFLOW_PAYING_ACCOUNT = "pa-0001" as ProviderAccountId;

/** The paying account as a step parked on it names it, by the label the account registry lists. */
const SPENT_ACCOUNT: NonNullable<WorkflowStep["waitAccount"]> = {
  providerAccountId: WORKFLOW_PAYING_ACCOUNT,
  provider: "claude",
  label: "Claude — work",
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

/** One saved workflow: its catalog row and its versions' documents, oldest first. */
export interface WorkflowDefinitionRecord {
  readonly summary: WorkflowDefinitionSummary;
  readonly versions: readonly { readonly versionId: string; readonly document: WorkflowDocument }[];
}

/** The ISO instant `minutesBefore` minutes before now. */
export function minutesAgo(minutesBefore: number): string {
  return new Date(WORKFLOW_FIXTURE_NOW_MS - minutesBefore * 60_000).toISOString();
}

/** The ISO instant `minutesAfter` minutes after now. */
export function minutesAhead(minutesAfter: number): string {
  return new Date(WORKFLOW_FIXTURE_NOW_MS + minutesAfter * 60_000).toISOString();
}

const DEVICE = "device-0001" as DeviceId;
const DIGEST = "wf-morning-digest" as WorkflowDefinitionId;
const RELEASE = "wf-release-review" as WorkflowDefinitionId;
const SUMMARIZE = "wf-summarize-folder" as WorkflowDefinitionId;
const TRIAGE = "wf-triage-issues" as WorkflowDefinitionId;
const SWEEP = "wf-folder-sweep" as WorkflowDefinitionId;
const SWEEP_CHILD = "wf-summarize-one-file" as WorkflowDefinitionId;

function node(id: string, kind: string, name: string, order: number): WorkflowNode {
  return { id: id as WorkflowNodeId, kind, kindVersion: 1, name, order, params: {} };
}

function chain(
  name: string,
  trigger: WorkflowNode,
  nodes: readonly WorkflowNode[],
  positions: readonly (readonly [number, number])[],
): WorkflowDocument {
  const ordered = [trigger, ...nodes];
  return {
    schemaVersion: "2",
    name,
    trigger,
    nodes: [...nodes],
    edges: nodes.map((target, index) => ({
      id: `edge-${String(index)}`,
      source: (ordered[index] ?? trigger).id,
      sourceHandle: "outputs/main/0",
      target: target.id,
      targetHandle: "inputs/main/0",
    })),
    layout: {
      nodes: Object.fromEntries(
        ordered.map((placed, index) => {
          const [x, y] = positions[index] ?? [index * 260, 0];
          return [placed.id, { x, y }];
        }),
      ),
    },
  };
}

const DIGEST_DOCUMENT = chain(
  "Daily change notes",
  node("schedule", "trigger.schedule", "Every weekday at 8:00", 0),
  [
    node("fetch", "developer.git", "Fetch PRs", 1),
    node("review", "agent.run", "Review one PR", 2),
    node("summary", "files.write", "Save the notes", 3),
  ],
  [
    [0, 0],
    [260, 0],
    [520, 0],
    [780, 0],
  ],
);

// No layout: the page lays this one out itself.
const RELEASE_DOCUMENT: WorkflowDocument = (() => {
  const { layout: _layout, ...withoutLayout } = chain(
    "Release review",
    node("manual", "trigger.manual", "Run now", 0),
    [
      node("build", "developer.shell", "Build the release", 1),
      node("notes", "human.form", "Release notes", 2),
      node("approve", "human.approval", "Approve release", 3),
      node("publish", "developer.shell", "Publish", 4),
    ],
    [],
  );
  return withoutLayout;
})();

const SUMMARIZE_DOCUMENT = chain(
  "Notes digest",
  node("watch", "trigger.file-watch", "When notes change", 0),
  [node("read", "files.read", "Read the notes", 1), node("summary", "agent.run", "Summarize", 2)],
  [
    [0, 0],
    [260, 80],
    [520, 0],
  ],
);

const TRIAGE_DOCUMENT = chain(
  "Triage issues",
  node("chat", "trigger.chat", "When asked in chat", 0),
  [
    node("ask", "human.wait-for-chat-reply", "Ask for the label", 1),
    node("label", "agent.run", "Label the issues", 2),
  ],
  [
    [0, 0],
    [260, 0],
    [520, 0],
  ],
);

const SWEEP_DOCUMENT = chain(
  "Folder sweep",
  node("manual", "trigger.manual", "Run now", 0),
  [node("each", "flow.execute-workflow", "Summarize each file", 1)],
  [
    [0, 0],
    [260, 0],
  ],
);

const SWEEP_CHILD_DOCUMENT = chain(
  "Summarize one file",
  node("called", "trigger.sub-workflow", "When Folder sweep calls it", 0),
  [node("summary", "agent.run", "Summarize the file", 1)],
  [
    [0, 0],
    [260, 0],
  ],
);

function summary(
  id: WorkflowDefinitionId,
  name: string,
  latestVersionNumber: number,
  triggerKind: string,
  runCount: number,
): WorkflowDefinitionSummary {
  return {
    id,
    name,
    latestVersionNumber,
    latestWorkflowVersionId: `${id}-v${String(latestVersionNumber)}`,
    contentHash: `b3:${id.slice(3, 11)}`,
    triggerKind,
    enabled: true,
    tags: [],
    runCount,
    createdAt: minutesAgo(60 * 24 * 30),
    updatedAt: minutesAgo(60 * 24),
  };
}

/** The saved workflows and their versions. */
export const WORKFLOW_DEFINITION_RECORDS: readonly WorkflowDefinitionRecord[] = [
  {
    summary: summary(DIGEST, "Daily change notes", 3, "trigger.schedule", 4),
    versions: [1, 2, 3].map((number) => ({
      versionId: `${DIGEST}-v${String(number)}`,
      document: DIGEST_DOCUMENT,
    })),
  },
  {
    summary: summary(RELEASE, "Release review", 2, "trigger.manual", 3),
    versions: [1, 2].map((number) => ({
      versionId: `${RELEASE}-v${String(number)}`,
      document: RELEASE_DOCUMENT,
    })),
  },
  {
    summary: summary(SUMMARIZE, "Notes digest", 1, "trigger.file-watch", 3),
    versions: [{ versionId: `${SUMMARIZE}-v1`, document: SUMMARIZE_DOCUMENT }],
  },
  {
    summary: summary(TRIAGE, "Triage issues", 1, "trigger.chat", 1),
    versions: [{ versionId: `${TRIAGE}-v1`, document: TRIAGE_DOCUMENT }],
  },
  {
    summary: summary(SWEEP, "Folder sweep", 1, "trigger.manual", 2),
    versions: [{ versionId: `${SWEEP}-v1`, document: SWEEP_DOCUMENT }],
  },
  {
    summary: summary(SWEEP_CHILD, "Summarize one file", 1, "trigger.sub-workflow", 1),
    versions: [{ versionId: `${SWEEP_CHILD}-v1`, document: SWEEP_CHILD_DOCUMENT }],
  },
];

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
      ...(seed.waitCause === "account" ? { waitAccount: SPENT_ACCOUNT } : {}),
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
  const definition = WORKFLOW_DEFINITION_RECORDS.find(
    (candidate) => candidate.summary.id === seed.definitionId,
  );
  const definitionName = definition?.summary.name ?? "Unnamed workflow";
  const workflowVersionId = `${seed.definitionId}-v${String(seed.versionNumber)}`;
  const document = definition?.versions.find(
    (version) => version.versionId === workflowVersionId,
  )?.document;
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
const PERSON: WorkflowStartedBy = { kind: "user", deviceId: DEVICE };
const FILE_EVENT: WorkflowStartedBy = { kind: "fileEvent" };
const CHAT: WorkflowStartedBy = {
  kind: "chat",
  sessionId: WORKFLOW_CHAT_SESSION,
  messageAnchorCursor: "cursor-0000000000000042" as EventCursor,
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
const FIXTURE_NOW_MINUTE = 14 * 60 + 20;

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
    startedBy: PERSON,
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
    startedBy: PERSON,
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
    startedBy: PERSON,
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
    startedBy: PERSON,
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
    startedBy: PERSON,
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

/** A run's row in the runs table, derived from its read the way the daemon's projection is. */
export function summaryOfRun(run: WorkflowRunRecord): WorkflowRunSummary {
  const { read } = run;
  const isGoing = read.state === "new" || read.state === "running" || read.state === "waiting";
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
    ...(isGoing ? {} : { durationMs: run.durationMs ?? 0 }),
    stepCount: read.steps.filter((step) => step.finishedAt !== undefined).length,
    ...(isGoing && read.liveStep !== undefined ? { liveStep: read.liveStep } : {}),
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
