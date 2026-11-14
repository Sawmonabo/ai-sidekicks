// The machine's workflow runs as the fixture daemon holds them: the runs the saved workflows of
// `../definitions.ts` made, in every status a run can stand in, a run waiting on a chat reply, a
// chain held behind its question and a release whose build exited printing errors among them.
// `writes.ts` applies the writes the playback has answered over them and `../replies.ts` answers
// the calls from that state.

import type { WorkflowRunSummary } from "@ai-sidekicks/contracts/workflow/run/list";
import type { QuestionId } from "@ai-sidekicks/contracts/question";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { GOING_RUN_STATUSES } from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type {
  WorkflowStep,
  WorkflowStepQuestion,
} from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowStartedBy } from "@ai-sidekicks/contracts/workflow/run/trigger";
import type { WorkflowChainRoot } from "@ai-sidekicks/contracts/workflow/run/records";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

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

import {
  buildRunRecord,
  WORKFLOW_CHAT_SESSION,
  WORKFLOW_DEVICE,
  type WorkflowRunRecord,
} from "./seeds.js";

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
  processExited: "019b7a10-0280-75e5-8510-ada11a5a4014",
} as const;

/** The question the fixture's reply wait holds, answered through `question.resolve`. */
export const WORKFLOW_REPLY_QUESTION: WorkflowStepQuestion = {
  questionId: "019b7a40-0280-75e5-8510-ada11a5a7001" as QuestionId,
  waitId: "019b7a40-0280-75e5-8510-ada11a5a7101",
  prompt: "Which label should these issues get?",
};

/**
 * The last lines the release build printed before it exited, as the failed build step carries
 * them: enough of a compiler's report that the step panel stands taller than the run graph.
 */
const RELEASE_BUILD_OUTPUT_TAIL = [
  "> release@2.4.0 build",
  "> tsc --build && node scripts/bundle.mjs",
  "",
  "src/notes/changelog.ts:41:7 - error TS2322: Type 'undefined' is not assignable to 'string'.",
  "",
  "41       title: entry.heading,",
  "         ~~~~~",
  "",
  "src/notes/changelog.ts:58:19 - error TS2345: 'Entry[]' is not assignable to 'Section[]'.",
  "",
  "58     return render(entries);",
  "                     ~~~~~~~",
  "",
  "src/publish/upload.ts:12:10 - error TS2305: './targets' has no exported member 'Mirror'.",
  "",
  "12 import { Mirror } from './targets';",
  "            ~~~~~~",
  "",
  "src/publish/upload.ts:88:5 - error TS7030: Not all code paths return a value.",
  "",
  "88     async function pushAsset(asset: Asset) {",
  "       ~~~~~",
  "",
  "Found 4 errors in 2 files.",
  "",
  "Errors  Files",
  "     2  src/notes/changelog.ts:41",
  "     2  src/publish/upload.ts:12",
].join("\n");

/** How many runs the held chain has started from its first run. */
const CHAIN_RUN_COUNT = 100;

/** When the held chain's first run started, in minutes before now. */
const CHAIN_STARTED_MINUTES_AGO = 260;

const SCHEDULE: WorkflowStartedBy = { kind: "schedule" };
/** How a run the person started records its starter. */
export const WORKFLOW_STARTED_BY_PERSON: WorkflowStartedBy = {
  kind: "user",
  deviceId: WORKFLOW_DEVICE,
};
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
    return buildRunRecord({
      id: `019b7a10-0280-75e5-8510-ada11a5a6${String(index + 1).padStart(3, "0")}`,
      definitionId: DIGEST,
      versionNumber: 2,
      status: "succeeded",
      mode: "trigger",
      startedBy: SCHEDULE,
      startedMinutesAgo,
      finishedMinutesAgo: startedMinutesAgo - 4,
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.running,
    definitionId: DIGEST,
    versionNumber: 3,
    status: "running",
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.waitingApproval,
    definitionId: RELEASE,
    versionNumber: 2,
    status: "waiting",
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.waitingForm,
    definitionId: RELEASE,
    versionNumber: 1,
    status: "waiting",
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.waitingAccount,
    definitionId: DIGEST,
    versionNumber: 2,
    status: "waiting",
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.failed,
    definitionId: SUMMARIZE,
    versionNumber: 1,
    status: "failed",
    mode: "trigger",
    startedBy: FILE_EVENT,
    startedMinutesAgo: 200,
    finishedMinutesAgo: 190,
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.processExited,
    definitionId: RELEASE,
    versionNumber: 2,
    status: "failed",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: 320,
    finishedMinutesAgo: 318,
    steps: [
      { nodeId: "manual", status: "succeeded", startedMinutesAgo: 320, finishedMinutesAgo: 320 },
      {
        nodeId: "build",
        status: "failed",
        startedMinutesAgo: 320,
        finishedMinutesAgo: 318,
        error: { message: "The release build exited with code 2." },
        processExit: { exitCode: 2, outputTail: RELEASE_BUILD_OUTPUT_TAIL },
      },
    ],
  }),
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.succeeded,
    definitionId: DIGEST,
    versionNumber: 2,
    status: "succeeded",
    mode: "trigger",
    startedBy: SCHEDULE,
    startedMinutesAgo: 380,
    finishedMinutesAgo: 374,
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.canceled,
    definitionId: RELEASE,
    versionNumber: 1,
    status: "canceled",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: 600,
    finishedMinutesAgo: 590,
    error: { message: "Built from the wrong branch." },
    steps: [
      { nodeId: "manual", status: "succeeded", startedMinutesAgo: 600, finishedMinutesAgo: 600 },
      { nodeId: "build", status: "canceled", startedMinutesAgo: 600, finishedMinutesAgo: 590 },
    ],
  }),
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.crashed,
    definitionId: SUMMARIZE,
    versionNumber: 1,
    status: "crashed",
    mode: "trigger",
    startedBy: FILE_EVENT,
    startedMinutesAgo: 740,
    finishedMinutesAgo: 735,
    steps: [
      { nodeId: "watch", status: "succeeded", startedMinutesAgo: 740, finishedMinutesAgo: 740 },
      { nodeId: "read", status: "canceled", startedMinutesAgo: 740, finishedMinutesAgo: 735 },
    ],
  }),
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.chained,
    definitionId: SUMMARIZE,
    versionNumber: 1,
    status: "succeeded",
    mode: "trigger",
    startedBy: FILE_EVENT,
    startedMinutesAgo: 720,
    finishedMinutesAgo: 719,
    chainRoot: CHAIN_ROOT,
    steps: [
      { nodeId: "watch", status: "succeeded", startedMinutesAgo: 720, finishedMinutesAgo: 720 },
      { nodeId: "read", status: "succeeded", startedMinutesAgo: 720, finishedMinutesAgo: 719 },
      { nodeId: "summary", status: "skipped", startedMinutesAgo: 719, finishedMinutesAgo: 719 },
    ],
  }),
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.waitingReply,
    definitionId: TRIAGE,
    versionNumber: 1,
    status: "waiting",
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.chainHeld,
    definitionId: SWEEP,
    versionNumber: 1,
    status: "waiting",
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.sweptChild,
    definitionId: SWEEP_CHILD,
    versionNumber: 1,
    status: "succeeded",
    mode: "subWorkflow",
    startedBy: {
      kind: "parentWorkflow",
      parentWorkflowRunId: WORKFLOW_RUN_IDS.sweptParent as WorkflowRunId,
    },
    startedMinutesAgo: SWEPT_MINUTES_AGO - 1,
    finishedMinutesAgo: SWEPT_MINUTES_AGO - 3,
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
  buildRunRecord({
    id: WORKFLOW_RUN_IDS.sweptParent,
    definitionId: SWEEP,
    versionNumber: 1,
    status: "succeeded",
    mode: "manual",
    startedBy: WORKFLOW_STARTED_BY_PERSON,
    startedMinutesAgo: SWEPT_MINUTES_AGO,
    finishedMinutesAgo: SWEPT_MINUTES_AGO - 4,
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
  return GOING_RUN_STATUSES.some((going) => going === run.read.status);
}

/** Whether the run is parked, waiting to be resumed: a waiting run, or a failed run not ended. */
export function isParked(run: WorkflowRunRecord): boolean {
  return (
    run.read.status === "waiting" ||
    (run.read.status === "failed" && run.read.finishedAt === undefined)
  );
}

/** A run's row in the runs table, derived from its read the way the daemon's projection is. */
export function summaryOfRun(run: WorkflowRunRecord): WorkflowRunSummary {
  const { read } = run;
  const waitingStep = read.steps.find((step) => step.status === "waiting");
  return {
    workflowRunId: read.workflowRunId,
    sessionId: read.sessionId,
    definitionId: read.definitionId,
    definitionName: run.definitionName,
    ...statusOfRun(run, waitingStep),
    mode: read.mode,
    triggerKind: read.triggerKind,
    startedBy: read.startedBy,
    startedAt: read.startedAt,
    stepCount: read.steps.filter((step) => step.finishedAt !== undefined).length,
    ...(read.cost === undefined ? {} : { cost: read.cost }),
    keep: read.keep,
  };
}

/** The members of a run's row that its status decides, one arm per status. */
type RunRowStatus = WorkflowRunSummary extends infer Row
  ? Row extends WorkflowRunSummary
    ? Pick<Row, "status" | "durationMs" | "liveStep" | "waitCause" | "resumeAt">
    : never
  : never;

// A going row carries the step it is on and an ended row how long it took; a waiting row names
// its step's cause, and only an account wait carries a resume instant onto it.
function statusOfRun(run: WorkflowRunRecord, waitingStep: WorkflowStep | undefined): RunRowStatus {
  const live = run.read.liveStep === undefined ? {} : { liveStep: run.read.liveStep };
  const took = isParked(run) ? {} : { durationMs: run.durationMs ?? 0 };
  switch (run.read.status) {
    case "new":
      return { status: "new", ...live };
    case "running":
      return { status: "running", ...live };
    case "waiting":
      return { status: "waiting", ...waitOfRow(waitingStep), ...live };
    case "succeeded":
      return { status: "succeeded", durationMs: run.durationMs ?? 0 };
    case "failed":
      return { status: "failed", ...took };
    case "canceled":
      return { status: "canceled", durationMs: run.durationMs ?? 0 };
    case "crashed":
      return { status: "crashed", durationMs: run.durationMs ?? 0 };
  }
}

// What a waiting row's step waits on, the resume instant only on an account wait.
function waitOfRow(waitingStep: WorkflowStep | undefined) {
  switch (waitingStep?.waitCause) {
    case "approval":
      return { waitCause: "approval" } as const;
    case "form":
      return { waitCause: "form" } as const;
    case "reply":
      return { waitCause: "reply" } as const;
    case "chain":
      return { waitCause: "chain" } as const;
    case "account":
      return waitingStep.resumeAt === undefined
        ? ({ waitCause: "account" } as const)
        : ({ waitCause: "account", resumeAt: waitingStep.resumeAt } as const);
    default:
      throw new RangeError("a waiting run carries the step that waits");
  }
}
