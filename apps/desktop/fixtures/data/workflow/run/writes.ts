// The writes the playback has answered, applied over the fixture daemon's runs: approvals, forms
// and questions answered, resumes, cancels, Keep, fix sessions, deletes, and the runs a start, a
// retry or a re-run mints. A run that was answered or acted on reads back that way on its next
// read, its answered steps carrying the record of how and when.

import type { ApprovalDecision } from "@ai-sidekicks/contracts/approval";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { RequestStampReader } from "#renderer/services/daemon/scenario/reply.fixture.js";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/status";
import type {
  WorkflowStep,
  WorkflowStepResolutionKind,
} from "@ai-sidekicks/contracts/workflow/run/step";
import type {
  WorkflowRunMode,
  WorkflowTriggerKind,
} from "@ai-sidekicks/contracts/workflow/run/trigger";

import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_FIXTURE_NOW_MS,
  WORKFLOW_FIX_SESSION,
  WORKFLOW_OWN_SESSION,
  WORKFLOW_RUN_RECORDS,
  minutesAgo,
  type WorkflowRunRecord,
} from "./records.js";

/** What the playback has answered so far, per call. */
export type AnsweredRequests = (call: string) => readonly unknown[];

/** What a workflow reply reads the playback through: its answered writes and a request's stamp. */
export interface WorkflowPlayback {
  readonly answered: AnsweredRequests;
  readonly readStamp: RequestStampReader;
}

/** The instant the playback calls now. */
export const NOW: string = minutesAgo(0);

/** The runs as the playback's answered writes have left them, newest first. */
export function currentRuns(playback: WorkflowPlayback): readonly WorkflowRunRecord[] {
  const bulkCutoffs = playback
    .answered("workflow.runsDelete")
    .map((call) => playback.readStamp(readString(call, "olderThan")));
  return runsBeforeBulkDeletes(playback.answered).filter(
    (run) => !bulkCutoffs.some((cutoff) => isBulkDeletable(run, cutoff)),
  );
}

/** The runs with every answered write applied except the bulk deletes, newest first. */
export function runsBeforeBulkDeletes(answered: AnsweredRequests): readonly WorkflowRunRecord[] {
  const deleted = answered("workflow.runDelete").map((call) => readMember(call, "workflowRunId"));
  const minted = [
    ...answered("workflow.runStart").map((call, index) =>
      mintedRun(mintedRunId("start", index), readString(call, "workflowVersionId"), {
        mode: "manual",
        triggerKind: "trigger.manual",
      }),
    ),
    ...answered("workflow.runRetry").map((call, index) => {
      // A retry runs its source's version and keeps the trigger kind its source started on.
      const source = WORKFLOW_RUN_RECORDS.find(
        (run) => run.read.workflowRunId === readString(call, "workflowRunId"),
      )?.read;
      return mintedRun(mintedRunId("retry", index), source?.workflowVersionId ?? "", {
        mode: "retry",
        triggerKind: source?.triggerKind ?? "trigger.manual",
      });
    }),
    ...answered("workflow.runRerun").map((call, index) => {
      // A re-run runs its source's version again, in the mode and trigger kind it started on.
      const source = WORKFLOW_RUN_RECORDS.find(
        (run) => run.read.workflowRunId === readString(call, "workflowRunId"),
      )?.read;
      return mintedRun(mintedRunId("rerun", index), source?.workflowVersionId ?? "", {
        mode: source?.mode ?? "manual",
        triggerKind: source?.triggerKind ?? "trigger.manual",
        ...(source === undefined ? {} : { sessionId: source.sessionId }),
      });
    }),
  ].reverse();
  return [...minted, ...WORKFLOW_RUN_RECORDS]
    .map((run) => applyWrites(run, answered))
    .filter((run) => !deleted.includes(run.read.workflowRunId));
}

function applyWrites(run: WorkflowRunRecord, answered: AnsweredRequests): WorkflowRunRecord {
  const id = run.read.workflowRunId;
  const forRun = (call: string): readonly unknown[] =>
    answered(call).filter((request) => readMember(request, "workflowRunId") === id);
  let applied = run;
  for (const answer of forRun("workflow.gateResolve")) {
    const decision = readMember(answer, "decision") === "approved" ? "approved" : "rejected";
    const nodeId = readMember(answer, "nodeId");
    applied =
      typeof nodeId === "string"
        ? settleWait(applied, nodeId, decision)
        : decideChain(applied, decision);
  }
  for (const answer of forRun("workflow.humanFormSubmit")) {
    applied = settleWait(applied, readString(answer, "nodeId"), "answered");
  }
  for (const answer of answered("question.resolve")) {
    applied = answerQuestion(applied, answer);
  }
  if (forRun("workflow.runResume").length > 0 && !isEnded(applied)) {
    applied = resumed(applied);
  }
  if (forRun("workflow.runCancel").length > 0 && applied.read.state !== "succeeded") {
    applied = canceled(applied);
  }
  const keep = forRun("workflow.runKeepSet").at(-1);
  const fixed = forRun("workflow.fixSessionCreate").length > 0;
  return {
    ...applied,
    read: {
      ...applied.read,
      ...(keep === undefined ? {} : { keep: readMember(keep, "keep") === true }),
      ...(fixed ? { fixSessionId: WORKFLOW_FIX_SESSION } : {}),
    },
  };
}

function settleWait(
  run: WorkflowRunRecord,
  nodeId: string,
  resolution: WorkflowStepResolutionKind,
): WorkflowRunRecord {
  const steps = run.read.steps.map((step): WorkflowStep => {
    if (step.nodeId !== nodeId || step.status !== "waiting") {
      return step;
    }
    return {
      ...withoutWait(step),
      status: "succeeded",
      finishedAt: NOW,
      resolution: { kind: resolution, at: NOW },
    };
  });
  return { ...run, read: { ...run.read, state: "running", steps } };
}

/**
 * The chain's question on its first run decided through a node-less `workflow.gateResolve`:
 * `approved` starts the held step's child, so the step runs on, and `rejected` cancels the run,
 * with the decision kept for the question's receipt.
 */
function decideChain(run: WorkflowRunRecord, decision: ApprovalDecision): WorkflowRunRecord {
  const decided: WorkflowRunRecord = {
    ...run,
    read: {
      ...run.read,
      chainQuestion: {
        state: "answered",
        decision,
        runCount: run.read.chainRoot.runCount,
        answeredAt: NOW,
      },
    },
  };
  if (decision === "rejected") {
    return canceled(decided);
  }
  const steps = decided.read.steps.map(
    (step): WorkflowStep =>
      step.waitCause === "chain" ? { ...withoutWait(step), status: "running" } : step,
  );
  return { ...decided, read: { ...decided.read, state: "running", steps } };
}

/** One `question.resolve` applied to a run: the reply wait holding that question is answered. */
function answerQuestion(run: WorkflowRunRecord, answer: unknown): WorkflowRunRecord {
  const questionId = readMember(answer, "questionId");
  const replyStep = run.read.steps.find(
    (step) => step.status === "waiting" && step.question?.questionId === questionId,
  );
  return replyStep === undefined ? run : settleWait(run, replyStep.nodeId, "answered");
}

/** A step with its wait taken off: no cause, instants or question. */
function withoutWait(step: WorkflowStep): WorkflowStep {
  const {
    waitCause: _cause,
    resumeAt: _resume,
    waitDeadlineAt: _deadline,
    question: _question,
    ...rest
  } = step;
  return rest;
}

function resumed(run: WorkflowRunRecord): WorkflowRunRecord {
  const steps = run.read.steps.map((step): WorkflowStep => {
    if (step.status !== "waiting") {
      return step;
    }
    return { ...withoutWait(step), status: "running" };
  });
  const failed = steps.findLast((step) => step.status === "failed");
  const rerun: WorkflowStep[] =
    run.read.state === "failed" && failed !== undefined
      ? [
          {
            ...failed,
            attempt: failed.attempt + 1,
            executionIndex: steps.length,
            status: "running",
            startedAt: NOW,
            finishedAt: undefined,
            error: undefined,
          },
        ]
      : [];
  const { endedAt: _ended, ...read } = run.read;
  const { durationMs: _duration, ...rest } = run;
  return { ...rest, read: { ...read, state: "running", steps: [...steps, ...rerun] } };
}

function canceled(run: WorkflowRunRecord): WorkflowRunRecord {
  if (run.read.state === "canceled") {
    return run;
  }
  const steps = run.read.steps.map((step): WorkflowStep => {
    if (step.status !== "running" && step.status !== "waiting") {
      return step;
    }
    return { ...withoutWait(step), status: "canceled", finishedAt: NOW };
  });
  const { liveStep: _live, ...read } = run.read;
  return {
    ...run,
    durationMs: run.startedMinutesAgo * 60_000,
    read: {
      ...read,
      state: "canceled",
      steps,
      endedAt: NOW,
      ...(read.executionContextCaptured ? { review: { state: "pinned", epoch: 1 } as const } : {}),
    },
  };
}

function mintedRun(
  workflowRunId: WorkflowRunId,
  workflowVersionId: string,
  started: {
    readonly mode: WorkflowRunMode;
    readonly triggerKind: WorkflowTriggerKind;
    /** The session the run lives in; the workflow's own unless the act names another. */
    readonly sessionId?: SessionId;
  },
): WorkflowRunRecord {
  const definition = WORKFLOW_DEFINITION_RECORDS.find((candidate) =>
    candidate.versions.some((version) => version.versionId === workflowVersionId),
  );
  const definitionId = definition?.summary.id ?? WORKFLOW_DEFINITION_RECORDS[0]!.summary.id;
  const workflowName = definition?.summary.name ?? "Unnamed workflow";
  return {
    definitionName: workflowName,
    startedMinutesAgo: 0,
    read: {
      workflowRunId,
      sessionId: started.sessionId ?? WORKFLOW_OWN_SESSION,
      definitionId,
      workflowVersionId,
      state: "new",
      mode: started.mode,
      triggerKind: started.triggerKind,
      startedBy: { kind: "user", deviceId: "device-0001" as never },
      chainRoot: { runId: workflowRunId, definitionId, workflowName, startedAt: NOW, runCount: 1 },
      executionContextCaptured: true,
      keep: false,
      steps: [],
      startedAt: NOW,
      edgeItemCounts: [],
    },
  };
}

/** Whether a bulk delete with this cutoff takes the run: older, not kept and not going. */
export function isBulkDeletable(run: WorkflowRunRecord, cutoffMs: number): boolean {
  return startedAtMs(run) < cutoffMs && !run.read.keep && !isGoing(run);
}

/** When the run started, as epoch milliseconds on the playback's clock. */
export function startedAtMs(run: WorkflowRunRecord): number {
  return WORKFLOW_FIXTURE_NOW_MS - run.startedMinutesAgo * 60_000;
}

/** Whether the run is still going: new, running or waiting. */
export function isGoing(run: WorkflowRunRecord): boolean {
  return run.read.state === "new" || run.read.state === "running" || run.read.state === "waiting";
}

/** Whether the run has ended for good: succeeded, crashed or canceled. */
export function isEnded(run: WorkflowRunRecord): boolean {
  return (
    run.read.state === "succeeded" || run.read.state === "crashed" || run.read.state === "canceled"
  );
}

/** The digit that tells apart the runs a start, a retry and a re-run mint. */
const MINTED_RUN_STEMS = { start: "6", retry: "7", rerun: "8" } as const;

/** The id the fixture daemon gives the run a start, a retry or a re-run mints, by its order. */
export function mintedRunId(kind: keyof typeof MINTED_RUN_STEMS, index: number): WorkflowRunId {
  const stem = MINTED_RUN_STEMS[kind];
  const serial = String(index).padStart(3, "0");
  return `019b7a30-0280-75e5-8510-ada11a5a${stem}${serial}` as WorkflowRunId;
}

/** A request read as a record, or an empty one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** One member of a request. */
export function readMember(value: unknown, key: string): unknown {
  return asRecord(value)[key];
}

/** One string member of a request, or an empty string. */
export function readString(value: unknown, key: string): string {
  const member = readMember(value, key);
  return typeof member === "string" ? member : "";
}
