// The blocker over a step's data, on contract-shaped runs from the fixture daemon: an answered
// step reads its receipt from the run's own record, so it survives a reload, and a wait on a
// person that timed out says when, which a step that waited on nobody never does; an approval
// opens Review from the run's start to its pause, or says why it cannot, and `Answer this run`
// presses its `Approve`; and a reply wait answers the question record its session's card shares,
// its receipt standing at once.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import { WORKFLOW_STEP_TIMED_OUT_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import {
  type WorkflowStep,
  type WorkflowStepResolution,
} from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering, type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import { WORKFLOW_FIXTURE_NOW_MS } from "#fixtures/data/workflow/clock.js";
import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_REPLY_QUESTION,
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
} from "#fixtures/data/workflow/run/records.js";
import { withoutWait } from "#fixtures/data/workflow/run/writes.js";
import { MILLISECONDS_PER_DAY } from "#renderer/lib/instant.js";
import { clockLocaleFor, formatDayClock, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { FIXTURE_APP_META } from "#renderer/services/platform/bridge.fixture.js";
import {
  createWorkflowCommandTargets,
  type WorkflowCommandTargets,
} from "#renderer/features/workflows/command-target.js";
import { withCommandTargets } from "#renderer/features/workflows/command-target.test-support.js";
import { StepBlocker } from "./StepBlocker.js";

/** The clock locale the fixture bridge carries, which the screen writes its figures in. */
const CLOCK_LOCALE = clockLocaleFor(FIXTURE_APP_META);

/** How long the fixture daemon takes to answer `question.resolve`. */
const QUESTION_RESOLVE_DELAY_MS = 200;

function fixtureStep(
  workflowRunId: string,
  nodeId: string,
): { readonly run: WorkflowRunReadResponse; readonly step: WorkflowStep } {
  const run = WORKFLOW_RUN_RECORDS.find((record) => record.read.workflowRunId === workflowRunId);
  const step = run?.read.steps.find((candidate) => candidate.nodeId === nodeId);
  if (run === undefined || step === undefined) {
    throw new Error(`the fixture daemon holds no step ${nodeId} in run ${workflowRunId}`);
  }
  return { run: run.read, step };
}

/** What a rendered blocker was asked to do. */
interface BlockerRecord {
  readonly calls: readonly RecordedDaemonCall[];
  readonly answers: readonly WorkflowStepResolution[];
  /** The receipt's paragraph, once one is drawn. */
  readonly receipt: () => HTMLElement | null;
  /** Move the fixture daemon's clock, so a reply it delays settles. */
  readonly advance: (deltaMs: number) => Promise<void>;
  /** The keyed acts the blocker is drawn under, which a chord presses. */
  readonly commandTargets: WorkflowCommandTargets;
}

/** The kind of `nodeId` in the version the fixture run pinned. */
function fixtureNodeKind(run: WorkflowRunReadResponse, nodeId: string): string {
  const document = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions).find(
    (version) => version.versionId === run.workflowVersionId,
  )?.document;
  const node = document?.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new Error(`the fixture run's version holds no node ${nodeId}`);
  }
  return node.kind;
}

/** A day after the fixture's answers, so each receipt names the day it was left. */
const NEXT_DAY_MS = WORKFLOW_FIXTURE_NOW_MS + MILLISECONDS_PER_DAY;

/** The blocker over one fixture step, changed by `adjust`, with no receipt from this sitting. */
function renderBlocker(
  workflowRunId: string,
  nodeId: string,
  reviews: (readonly [WorkflowRunSnapshotPoint, WorkflowRunSnapshotPoint])[] = [],
  adjust: (step: WorkflowStep) => WorkflowStep = (step) => step,
): BlockerRecord {
  const { run, step } = fixtureStep(workflowRunId, nodeId);
  const nodeKind = fixtureNodeKind(run, nodeId);
  const { bridge, calls, engine } = bridgeAnswering(async (_call, passThrough) => passThrough());
  const answers: WorkflowStepResolution[] = [];
  const commandTargets = createWorkflowCommandTargets();
  render(
    <StepBlocker
      run={run}
      step={adjust(step)}
      nodeKind={nodeKind}
      answer={undefined}
      nowMs={NEXT_DAY_MS}
      bridge={bridge}
      onAnswered={(answer) => {
        answers.push(answer);
      }}
      onOpenReview={(from, to) => {
        reviews.push([from, to]);
      }}
    />,
    { wrapper: withCommandTargets(bridgeWrapper(bridge, engine.clock), commandTargets) },
  );
  const receipt = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(".meridian-workflow-step__receipt");
  const advance = async (deltaMs: number): Promise<void> => {
    await act(async () => {
      engine.advance(deltaMs);
      await Promise.resolve();
    });
  };
  return { calls, answers, receipt, advance, commandTargets };
}

describe("a step's blocker", () => {
  it("reads an answered step's receipt from the run's record, with no way back", () => {
    const { step } = fixtureStep(WORKFLOW_RUN_IDS.waitingApproval, "notes");
    if (step.resolution === undefined) {
      throw new Error("the fixture's answered form carries no record of its answer");
    }
    const { receipt } = renderBlocker(WORKFLOW_RUN_IDS.waitingApproval, "notes");

    expect(receipt()?.textContent).toBe(
      `Answered at ${formatDayClock(step.resolution.at, NEXT_DAY_MS, CLOCK_LOCALE)}`,
    );
    // Hovering the instant shows the time it stands for, with its zone.
    expect(receipt()?.querySelector("[title]")?.getAttribute("title")).toBe(
      formatZonedDateTime(step.resolution.at, CLOCK_LOCALE),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("replaces a wait on a person its time limit cut with when it timed out, and nothing else", () => {
    const finishedAt = "2026-01-01T14:12:00.000Z";
    const timedOut = (step: WorkflowStep): WorkflowStep => ({
      ...withoutWait(step, "failed"),
      finishedAt,
      error: {
        message: "No answer before the step's timeout.",
        code: WORKFLOW_STEP_TIMED_OUT_CODE,
      },
    });
    const { receipt } = renderBlocker(WORKFLOW_RUN_IDS.waitingApproval, "approve", [], timedOut);
    expect(receipt()?.textContent).toBe(
      `Timed out at ${formatDayClock(finishedAt, NEXT_DAY_MS, CLOCK_LOCALE)}`,
    );
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();

    // A build step cut by its own time limit waited on nobody, so it leaves no receipt.
    const build = renderBlocker(WORKFLOW_RUN_IDS.waitingApproval, "build", [], timedOut);
    expect(build.receipt()).toBeNull();
  });

  it("opens Review to the approval's pause, and Answer this run presses Approve", async () => {
    const reviews: (readonly [WorkflowRunSnapshotPoint, WorkflowRunSnapshotPoint])[] = [];
    const { calls, commandTargets } = renderBlocker(
      WORKFLOW_RUN_IDS.waitingApproval,
      "approve",
      reviews,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open in Review" }));
    expect(reviews).toStrictEqual([
      [
        { epoch: 1, point: "start" },
        { epoch: 1, point: "pause", pauseNumber: 1 },
      ],
    ]);

    expect(commandTargets.answerThisRun.unavailable(document)).toBeUndefined();
    act(() => {
      commandTargets.answerThisRun.press(document);
    });
    await waitFor(() => {
      expect(calls).toStrictEqual([
        {
          method: "workflow.gateResolve",
          params: {
            workflowRunId: WORKFLOW_RUN_IDS.waitingApproval,
            nodeId: "approve",
            decision: "approved",
          },
        },
      ]);
    });
  });

  it("keeps Open in Review in place, saying why, when the pause snapshot is missing", () => {
    const reviews: (readonly [WorkflowRunSnapshotPoint, WorkflowRunSnapshotPoint])[] = [];
    const reason = "The checkout could not be snapshotted at this pause.";
    renderBlocker(WORKFLOW_RUN_IDS.waitingApproval, "approve", reviews, (step) => ({
      ...step,
      reviewPause: { state: "missing", reason },
    }));

    const openInReview = screen.getByRole("button", { name: "Open in Review" });
    expect(openInReview.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(reason)).toBeDefined();
    fireEvent.click(openInReview);
    expect(reviews).toStrictEqual([]);
  });

  it("answers a reply through its question, saying why Answer this run cannot while empty", async () => {
    const { calls, answers, advance, commandTargets } = renderBlocker(
      WORKFLOW_RUN_IDS.waitingReply,
      "ask",
    );
    const field = screen.getByLabelText(WORKFLOW_REPLY_QUESTION.prompt);

    expect(commandTargets.answerThisRun.unavailable(document)).toBe(
      "This step waits for a reply. Type one, then answer.",
    );
    commandTargets.answerThisRun.press(document);
    // The reply's one control is `Answer`: a reply wait has no `Skip`.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toStrictEqual([
      "Answer",
    ]);
    fireEvent.change(field, { target: { value: "  needs-triage " } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => {
      expect(calls).toStrictEqual([
        {
          method: "question.resolve",
          params: {
            questionId: WORKFLOW_REPLY_QUESTION.questionId,
            answers: [{ kind: "typed", text: "needs-triage" }],
          },
        },
      ]);
    });
    // The receipt stands as soon as the daemon takes the answer, before the run reads back.
    await advance(QUESTION_RESOLVE_DELAY_MS);
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect(answers[0]?.kind).toBe("answered");
  });
});
