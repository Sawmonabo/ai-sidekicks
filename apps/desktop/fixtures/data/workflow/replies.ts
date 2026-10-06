// What the workflows screens are answered with: the runs table and its attention section, one
// run's page and its steps, the step form, and every act the run page and the Runs tab send. The
// runs are the machine's, not a session's, so a scenario that plays a session spreads these into
// its own replies, beside the provider-account registry the paying account is named from.
//
// The acts behave as the daemon's do: an approval or a form answered elsewhere leaves the
// attention section and moves its run on, a cancel ends a run that has not ended and replays on a
// canceled one, a resume lifts a wait, a delete refuses a run that is still going, Keep sticks, a
// started, retried or re-run run reads back as new, and the start hold opens the live stream with
// its current state. Each act pushes a run change on `workflow.subscribe`, as the daemon's
// projector does.

import type { WORKFLOW_NOTICE_STREAM } from "#shared/daemon/streams.js";
import type {
  WorkflowNodeId,
  WorkflowPinnedItem,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type {
  WorkflowDefinitionListResponse,
  WorkflowVersionChainReadResponse,
  WorkflowVersionReadResponse,
} from "@ai-sidekicks/contracts/workflow/definition/methods";
import type { WorkflowPinDataSetResponse } from "@ai-sidekicks/contracts/workflow/definition/builder";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step";
import type {
  WorkflowRunCancelResponse,
  WorkflowRunResumeResponse,
  WorkflowRunRetryResponse,
  WorkflowRunStartResponse,
} from "@ai-sidekicks/contracts/workflow/run/control";
import type {
  WorkflowRunAttentionEntry,
  WorkflowRunAttentionListResponse,
  WorkflowRunListResponse,
  WorkflowRunsDeletePreviewResponse,
  WorkflowRunsPauseState,
  WorkflowSubscribeNotification,
} from "@ai-sidekicks/contracts/workflow/run/records";
import type {
  WorkflowGateResolveResponse,
  WorkflowHumanFormDraftSaveResponse,
  WorkflowHumanFormReadResponse,
  WorkflowStepReadResponse,
} from "@ai-sidekicks/contracts/workflow/run/step";
import type { QuestionId, QuestionResolveResponse } from "@ai-sidekicks/contracts/question";
import type {
  ScenarioNotice,
  ScenarioOpeningNotice,
  ScenarioReply,
} from "#renderer/services/daemon/scenario/reply.fixture.js";
import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_FIX_SESSION,
  WORKFLOW_OWN_SESSION,
  WORKFLOW_SPENT_ACCOUNT,
  WORKFLOW_RUN_RECORDS,
  minutesAgo,
  summaryOfRun,
  type WorkflowRunRecord,
} from "./run/records.js";
import {
  NOW,
  asRecord,
  currentRuns,
  isBulkDeletable,
  isGoing,
  mintedRunId,
  readMember,
  readString,
  runsBeforeBulkDeletes,
  startedAtMs,
  type WorkflowPlayback,
} from "./run/writes.js";

/** The stream every run change is pushed on, typed by its one name so a rename fails the build. */
const WORKFLOW_STREAM: typeof WORKFLOW_NOTICE_STREAM = "workflow.subscribe";

/** How many starts wait behind the hold while it is on. */
const STARTS_WAITING_WHILE_PAUSED = 3;

/** How long the fixture daemon takes to read a run list, a run or a step's form. */
export const WORKFLOW_READ_LATENCY_MS = 120;

/** Every call the workflows screens make, and what each is answered with. */
export const WORKFLOW_REPLIES: readonly ScenarioReply[] = [
  { call: "workflow.definitionList", result: definitionList() },
  { call: "workflow.versionChainRead", resultFor: answerVersionChain },
  { call: "workflow.versionRead", resultFor: answerVersionRead },
  {
    call: "workflow.runList",
    afterMs: WORKFLOW_READ_LATENCY_MS,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerRunList(request, { answered, readStamp }),
  },
  {
    call: "workflow.runRead",
    afterMs: WORKFLOW_READ_LATENCY_MS,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerRunRead(request, { answered, readStamp }),
  },
  {
    call: "workflow.runAttentionList",
    resultFor: (_request, _at, _ordinal, answered, readStamp) =>
      answerAttention({ answered, readStamp }),
  },
  {
    call: "workflow.stepRead",
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerStepRead(request, { answered, readStamp }),
  },
  {
    call: "workflow.humanFormRead",
    afterMs: WORKFLOW_READ_LATENCY_MS,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerFormRead(request, { answered, readStamp }),
  },
  {
    call: "workflow.humanFormDraftSave",
    resultFor: (_request, _at, _ordinal, answered): WorkflowHumanFormDraftSaveResponse => ({
      revision: answered("workflow.humanFormDraftSave").length + 1,
      savedAt: NOW,
    }),
  },
  {
    call: "workflow.humanFormSubmit",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerFormSubmit(request, { answered, readStamp }),
    noticesFor: stepAnswered,
  },
  {
    call: "workflow.gateResolve",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerGate(request, { answered, readStamp }),
    noticesFor: stepAnswered,
  },
  {
    call: "workflow.runCancel",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerCancel(request, { answered, readStamp }),
    noticesFor: runChanged,
  },
  {
    call: "workflow.runResume",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerResume(request, { answered, readStamp }),
    noticesFor: runChanged,
  },
  {
    call: "workflow.runStart",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered): WorkflowRunStartResponse => ({
      workflowRunId: mintedRunId("start", answered("workflow.runStart").length),
      sessionId: WORKFLOW_OWN_SESSION,
      state: "new",
    }),
    noticesFor: runChanged,
  },
  {
    call: "workflow.runRetry",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerRetry(request, { answered, readStamp }),
    noticesFor: runChanged,
  },
  {
    call: "workflow.runRerun",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerRerun(request, { answered, readStamp }),
    // The change pushed is the new run's; the run re-run is left as it was.
    noticesFor: (_request, answer) => runChanged(answer),
  },
  {
    call: "workflow.runKeepSet",
    resultFor: (request) => ({
      workflowRunId: readString(request, "workflowRunId"),
      keep: readMember(request, "keep") === true,
    }),
    noticesFor: runChanged,
  },
  {
    call: "workflow.runDelete",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerRunDelete(request, { answered, readStamp }),
    noticesFor: (request) => runsRemoved([readString(request, "workflowRunId")]),
  },
  {
    call: "workflow.runsDeletePreview",
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerDeletePreview(request, { answered, readStamp }),
  },
  {
    call: "workflow.runsDelete",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) => ({
      deletedCount: runsOlderThan(request, { answered, readStamp }).length,
    }),
    noticesFor: (request, answer) =>
      readMember(answer, "deletedCount") === 0 ? [] : bulkRunsRemoved(request),
  },
  {
    call: "workflow.runsPauseSet",
    resultFor: (request): WorkflowRunsPauseState => pauseState(readMember(request, "paused")),
    noticesFor: (_request, answer) => [
      { stream: WORKFLOW_STREAM, afterMs: 0, payloadAtDelivery: () => runsPauseFrame(answer) },
    ],
  },
  {
    call: "workflow.fixSessionCreate",
    afterMs: 200,
    resultFor: (request, _at, _ordinal, answered, readStamp) =>
      answerFixSession(request, { answered, readStamp }),
    noticesFor: runChanged,
  },
  {
    call: "question.resolve",
    afterMs: 200,
    resultFor: (request): QuestionResolveResponse => ({
      questionId: readString(request, "questionId") as QuestionId,
      state: "answered",
    }),
    noticesFor: questionAnswered,
  },
  {
    call: "workflow.pinDataSet",
    resultFor: (request): WorkflowPinDataSetResponse => ({
      definitionId: readString(
        request,
        "definitionId",
      ) as WorkflowPinDataSetResponse["definitionId"],
      nodeId: readString(request, "nodeId") as WorkflowNodeId,
      pinned: Array.isArray(readMember(request, "items") as WorkflowPinnedItem[] | null),
    }),
  },
];

/** The frame `workflow.subscribe` opens with: the start hold as the last answered write left it. */
export const WORKFLOW_OPENING_NOTICES: readonly ScenarioOpeningNotice[] = [
  {
    stream: WORKFLOW_STREAM,
    payloadAtOpen: (answered) => {
      const lastHold = answered("workflow.runsPauseSet").at(-1);
      return runsPauseFrame(pauseState(readMember(lastHold, "paused")));
    },
  },
];

function definitionList(): WorkflowDefinitionListResponse {
  return { definitions: WORKFLOW_DEFINITION_RECORDS.map((definition) => definition.summary) };
}

function answerVersionChain(request: unknown): WorkflowVersionChainReadResponse | undefined {
  const versionId = readString(request, "workflowVersionId");
  const definition = WORKFLOW_DEFINITION_RECORDS.find((candidate) =>
    candidate.versions.some((version) => version.versionId === versionId),
  );
  if (definition === undefined) {
    return undefined;
  }
  return {
    definitionId: definition.summary.id,
    versions: definition.versions.map((version, index) => ({
      workflowVersionId: version.versionId,
      versionNumber: index + 1,
      contentHash: `b3:${String(index + 1).padStart(8, "0")}`,
      createdAt: minutesAgo(60 * 24 * (definition.versions.length - index)),
      savedBy: { kind: "user" },
      ...(index === 0
        ? {}
        : {
            changesFromPrevious: {
              nodesAdded: 0,
              nodesRemoved: 0,
              nodesChanged: 1,
              edgesAdded: 0,
              edgesRemoved: 0,
            },
          }),
    })),
  };
}

function answerVersionRead(request: unknown): WorkflowVersionReadResponse | undefined {
  const definition = WORKFLOW_DEFINITION_RECORDS.find(
    (candidate) => candidate.summary.id === readString(request, "definitionId"),
  );
  const versionNumber = readMember(request, "versionNumber");
  const version =
    typeof versionNumber === "number" ? definition?.versions[versionNumber - 1] : undefined;
  if (definition === undefined || version === undefined || typeof versionNumber !== "number") {
    return undefined;
  }
  return {
    definitionId: definition.summary.id,
    versionNumber,
    workflowVersionId: version.versionId,
    contentHash: `b3:${String(versionNumber).padStart(8, "0")}`,
    document: version.document,
    createdAt: minutesAgo(60 * 24),
  };
}

function answerRunList(request: unknown, playback: WorkflowPlayback): WorkflowRunListResponse {
  const statuses = readMember(request, "status");
  const triggerKinds = readMember(request, "triggerKind");
  const definitionId = readMember(request, "definitionId");
  const versionId = readMember(request, "workflowVersionId");
  const after = readMember(request, "startedAfter");
  const runs = currentRuns(playback)
    .filter(
      (run) =>
        (!Array.isArray(statuses) || statuses.includes(run.read.state)) &&
        (!Array.isArray(triggerKinds) || triggerKinds.includes(run.read.triggerKind)) &&
        (definitionId === undefined || run.read.definitionId === definitionId) &&
        (versionId === undefined || run.read.workflowVersionId === versionId) &&
        (typeof after !== "string" || startedAtMs(run) >= playback.readStamp(after)),
    )
    // Newest first, as the daemon lists them.
    .toSorted((left, right) => left.startedMinutesAgo - right.startedMinutesAgo)
    .map(summaryOfRun);
  // The cursor names the last run of the page before, opaque to the screen as the daemon's is, so
  // a run that starts while the screen pages through shifts no page.
  const cursor = readMember(request, "cursor");
  const limit = readMember(request, "limit");
  const start =
    typeof cursor === "string" ? runs.findIndex((run) => run.workflowRunId === cursor) + 1 : 0;
  const end = typeof limit === "number" ? start + limit : runs.length;
  const page = runs.slice(start, end);
  const last = page.at(-1);
  return {
    runs: page,
    ...(end < runs.length && last !== undefined ? { nextCursor: last.workflowRunId } : {}),
    totalCount: runs.length,
  };
}

function answerRunRead(request: unknown, playback: WorkflowPlayback): unknown {
  return requireRun(request, playback).read;
}

function answerAttention(playback: WorkflowPlayback): WorkflowRunAttentionListResponse {
  const waiting = currentRuns(playback)
    .flatMap((run) => {
      const step = run.read.steps.find((candidate) => candidate.status === "waiting");
      return step?.waitCause === undefined ? [] : [{ run, step, cause: step.waitCause }];
    })
    .sort((left, right) => right.run.startedMinutesAgo - left.run.startedMinutesAgo);
  const accountWaits = waiting.filter((entry) => entry.cause === "account");
  const accountLines: WorkflowRunAttentionEntry[] =
    accountWaits.length === 0
      ? []
      : [
          {
            kind: "account",
            account: WORKFLOW_SPENT_ACCOUNT,
            affectedRunCount: accountWaits.length,
            waitingSince: accountWaits[0]?.step.startedAt ?? NOW,
            ...(accountWaits[0]?.step.resumeAt === undefined
              ? {}
              : { resumeAt: accountWaits[0].step.resumeAt }),
          },
        ];
  const runLines = waiting.flatMap((entry): WorkflowRunAttentionEntry[] =>
    entry.cause === "account"
      ? []
      : [
          {
            kind: "run",
            workflowRunId: entry.run.read.workflowRunId,
            workflowName: entry.run.definitionName,
            waitCause: entry.cause,
            waitingStepName: nodeNameOf(entry.run, entry.step.nodeId),
            waitingSince: entry.step.startedAt,
          },
        ],
  );
  return { entries: [...accountLines, ...runLines], waitingOnPersonCount: runLines.length };
}

/** The name the run's pinned version gives a node; a node it lacks is a broken fixture. */
function nodeNameOf(run: WorkflowRunRecord, nodeId: string): string {
  const document = WORKFLOW_DEFINITION_RECORDS.find(
    (definition) => definition.summary.id === run.read.definitionId,
  )?.versions.find((version) => version.versionId === run.read.workflowVersionId)?.document;
  const node = [document?.trigger, ...(document?.nodes ?? [])].find(
    (candidate) => candidate?.id === nodeId,
  );
  if (node === undefined) {
    throw new Error(`${run.read.workflowVersionId} has no node ${nodeId}`);
  }
  return node.name;
}

function answerStepRead(request: unknown, playback: WorkflowPlayback): WorkflowStepReadResponse {
  const step = requireStep(request, playback);
  const which = readString(request, "which") as WorkflowStepReadResponse["which"];
  const payload =
    which === "input" ? step.inputRef : which === "output" ? step.outputRef : step.logRef;
  return { nodeId: step.nodeId, executionIndex: step.executionIndex, which, payload };
}

function answerFormRead(
  request: unknown,
  playback: WorkflowPlayback,
): WorkflowHumanFormReadResponse {
  requireWaitingStep(request, playback);
  const lastDraft = playback.answered("workflow.humanFormDraftSave").at(-1);
  const formState = readMember(lastDraft, "formState");
  return {
    prompt: "Write the release notes for this version.",
    fields: [
      { id: "version", label: "Version", type: "string", required: true },
      {
        id: "channel",
        label: "Channel",
        type: "select",
        required: true,
        options: [
          { value: "stable", label: "Stable" },
          { value: "beta", label: "Beta" },
        ],
      },
      { id: "notes", label: "Notes", type: "text", required: true },
      {
        id: "highlights",
        label: "Highlight",
        type: "collection",
        multiple: true,
        fields: [{ id: "summary", label: "Summary", type: "string", required: true }],
      },
      { id: "rollout", label: "Rollout percent", type: "number", help: "From 1 to 100." },
      { id: "announce", label: "Announce in chat", type: "boolean", default: false },
      {
        id: "announcement",
        label: "Announcement",
        type: "text",
        showWhen: { announce: [true] },
      },
    ],
    formRevision: 0,
    ...(typeof formState === "object" && formState !== null
      ? {
          draft: {
            formState: formState as Record<string, unknown>,
            revision: playback.answered("workflow.humanFormDraftSave").length,
            savedAt: NOW,
          },
        }
      : {}),
  };
}

function answerFormSubmit(request: unknown, playback: WorkflowPlayback): unknown {
  requireWaitingStep(request, playback);
  if (readMember(request, "expectedRevision") !== 0) {
    throw refusal("workflow.revision_stale", "This form was answered from somewhere else first.");
  }
  return { submittedAt: NOW };
}

function answerGate(request: unknown, playback: WorkflowPlayback): WorkflowGateResolveResponse {
  if (readMember(request, "nodeId") === undefined) {
    if (requireRun(request, playback).read.chainQuestion?.state !== "open") {
      throw refusal("workflow.step_not_waiting", "This chain's question is already answered.");
    }
  } else {
    requireWaitingStep({ ...asRecord(request), executionIndex: undefined }, playback);
  }
  return {
    gateResolutionId: `gate-${String(playback.answered("workflow.gateResolve").length + 1)}`,
    decidedAt: NOW,
  };
}

function answerCancel(request: unknown, playback: WorkflowPlayback): WorkflowRunCancelResponse {
  const run = requireRun(request, playback);
  const state = run.read.state;
  if (state !== "canceled" && run.read.endedAt !== undefined) {
    throw refusal("workflow.run_not_cancelable", "This run has already ended.");
  }
  return {
    workflowRunId: run.read.workflowRunId,
    state: "canceled",
    canceledEventId: `cancel-${run.read.workflowRunId}`,
    alreadyCanceled: state === "canceled",
  };
}

function answerResume(request: unknown, playback: WorkflowPlayback): WorkflowRunResumeResponse {
  const run = requireRun(request, playback);
  const isParked =
    run.read.state === "waiting" || (run.read.state === "failed" && run.read.endedAt === undefined);
  if (!isParked) {
    throw refusal("workflow.resume_not_parked", "This run is not waiting on anything.");
  }
  return { workflowRunId: run.read.workflowRunId, state: "running" };
}

function answerRetry(request: unknown, playback: WorkflowPlayback): WorkflowRunRetryResponse {
  const run = requireRun(request, playback);
  const fromNodeId = readString(request, "fromNodeId");
  if (run.read.state === "new" || run.read.state === "running" || run.read.state === "waiting") {
    throw Object.assign(refusal("workflow.retry_unavailable", "This run is still going."), {
      details: { reason: "source_running" },
    });
  }
  const latest = run.read.steps.filter((step) => step.nodeId === fromNodeId).at(-1);
  if (latest?.status !== "failed") {
    throw refusal("workflow.invalid_transition", "Only a step that failed can be retried.");
  }
  return {
    workflowRunId: mintedRunId("retry", playback.answered("workflow.runRetry").length),
    sourceWorkflowRunId: run.read.workflowRunId,
    state: "new",
  };
}

function answerRerun(request: unknown, playback: WorkflowPlayback): WorkflowRunStartResponse {
  const run = requireRun(request, playback);
  return {
    workflowRunId: mintedRunId("rerun", playback.answered("workflow.runRerun").length),
    sessionId: run.read.sessionId,
    state: "new",
  };
}

function answerRunDelete(request: unknown, playback: WorkflowPlayback): unknown {
  const run = requireRun(request, playback);
  if (isGoing(run)) {
    throw refusal("workflow.run_not_deletable", "Cancel it first.");
  }
  return { workflowRunId: run.read.workflowRunId, deleted: true };
}

function answerDeletePreview(
  request: unknown,
  playback: WorkflowPlayback,
): WorkflowRunsDeletePreviewResponse {
  const cutoffMs = playback.readStamp(readString(request, "olderThan"));
  const older = currentRuns(playback).filter((run) => startedAtMs(run) < cutoffMs);
  return {
    deleteCount: runsOlderThan(request, playback).length,
    keptCount: older.filter((run) => run.read.keep).length,
    waitingCount: older.filter((run) => run.read.state === "waiting").length,
  };
}

function answerFixSession(request: unknown, playback: WorkflowPlayback): unknown {
  const step = requireStep(request, playback);
  if (step.status !== "failed") {
    throw refusal("workflow.invalid_transition", "Only a step that failed can be fixed.");
  }
  return { sessionId: WORKFLOW_FIX_SESSION };
}

function runsOlderThan(request: unknown, playback: WorkflowPlayback): readonly WorkflowRunRecord[] {
  const cutoffMs = playback.readStamp(readString(request, "olderThan"));
  return currentRuns(playback).filter((run) => isBulkDeletable(run, cutoffMs));
}

function requireRun(request: unknown, playback: WorkflowPlayback): WorkflowRunRecord {
  const run = currentRuns(playback).find(
    (candidate) => candidate.read.workflowRunId === readMember(request, "workflowRunId"),
  );
  if (run === undefined) {
    throw refusal("workflow.not_found", "No run has that id.");
  }
  return run;
}

function requireStep(request: unknown, playback: WorkflowPlayback): WorkflowStep {
  const step = requireRun(request, playback).read.steps.find(
    (candidate) =>
      candidate.nodeId === readMember(request, "nodeId") &&
      candidate.executionIndex === readMember(request, "executionIndex"),
  );
  if (step === undefined) {
    throw refusal("workflow.not_found", "No step has that address in this run.");
  }
  return step;
}

/** The step a person answers, by node, refusing one no longer waiting as the daemon does. */
function requireWaitingStep(request: unknown, playback: WorkflowPlayback): void {
  const waiting = requireRun(request, playback).read.steps.some(
    (step) => step.nodeId === readMember(request, "nodeId") && step.status === "waiting",
  );
  if (!waiting) {
    throw refusal("workflow.step_not_waiting", "This step is no longer waiting.");
  }
}

function runChanged(request: unknown): readonly ScenarioNotice[] {
  const runId = readMember(request, "workflowRunId");
  return [
    {
      stream: WORKFLOW_STREAM,
      afterMs: 0,
      payloadAtDelivery: (answered, readStamp): WorkflowSubscribeNotification | undefined => {
        const run = currentRuns({ answered, readStamp }).find(
          (candidate) => candidate.read.workflowRunId === runId,
        );
        return run === undefined ? undefined : { kind: "run", run: summaryOfRun(run) };
      },
    },
  ];
}

/** The run change a `question.resolve` pushes, for the run whose wait held that question. */
function questionAnswered(request: unknown): readonly ScenarioNotice[] {
  const questionId = readMember(request, "questionId");
  const holder = WORKFLOW_RUN_RECORDS.find((run) =>
    run.read.steps.some((step) => step.question?.questionId === questionId),
  );
  return holder === undefined ? [] : stepAnswered({ workflowRunId: holder.read.workflowRunId });
}

/**
 * What an answer pushes, as the daemon's stream does: the answered step, carrying when it was
 * answered, then the run it moved.
 */
function stepAnswered(request: unknown): readonly ScenarioNotice[] {
  const runId = readMember(request, "workflowRunId");
  return [
    {
      stream: WORKFLOW_STREAM,
      afterMs: 0,
      payloadAtDelivery: (answered, readStamp): WorkflowSubscribeNotification | undefined => {
        const run = currentRuns({ answered, readStamp }).find(
          (candidate) => candidate.read.workflowRunId === runId,
        );
        const step = run?.read.steps.findLast((candidate) => candidate.resolution !== undefined);
        return run === undefined || step === undefined
          ? undefined
          : { kind: "step", workflowRunId: run.read.workflowRunId, step };
      },
    },
    ...runChanged(request),
  ];
}

function runsRemoved(workflowRunIds: readonly string[]): readonly ScenarioNotice[] {
  return [
    {
      stream: WORKFLOW_STREAM,
      afterMs: 0,
      payloadAtDelivery: (): WorkflowSubscribeNotification => ({
        kind: "runsRemoved",
        workflowRunIds: workflowRunIds.map((id) => id as WorkflowRunId),
      }),
    },
  ];
}

/**
 * The removal a bulk delete pushes, naming each run it took: the runs older than its cutoff that
 * were neither kept nor going once every other write had landed.
 */
function bulkRunsRemoved(request: unknown): readonly ScenarioNotice[] {
  return [
    {
      stream: WORKFLOW_STREAM,
      afterMs: 0,
      payloadAtDelivery: (answered, readStamp): WorkflowSubscribeNotification | undefined => {
        const cutoffMs = readStamp(readString(request, "olderThan"));
        const removed = runsBeforeBulkDeletes(answered)
          .filter((run) => isBulkDeletable(run, cutoffMs))
          .map((run) => run.read.workflowRunId);
        return removed.length === 0 ? undefined : { kind: "runsRemoved", workflowRunIds: removed };
      },
    },
  ];
}

function pauseState(paused: unknown): WorkflowRunsPauseState {
  const isPaused = paused === true;
  return { paused: isPaused, waitingStartCount: isPaused ? STARTS_WAITING_WHILE_PAUSED : 0 };
}

function runsPauseFrame(state: unknown): WorkflowSubscribeNotification {
  return { kind: "runsPause", ...pauseState(readMember(state, "paused")) };
}

function refusal(code: string, message: string): { code: string; message: string } {
  return { code, message };
}
