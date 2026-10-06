// A run's page under the window's route: a failed run opens on its failed step's error, Escape
// closes the step panel before it leaves for the list and leaves a text field's Escape alone,
// `Answer this run` refuses on a run that waits on no one here, and a reply wait answered on this
// page or through its session's card gives way to its receipt, since both answer one question.

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/status";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { WORKFLOW_REPLY_QUESTION, WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { advanceScenarioUntil } from "#test/helpers/scenario-manual-clock.js";
import { workflowRunsRoute } from "#renderer/routing/readers.js";
import {
  mountWorkflowsScreen,
  navigate,
  openRunId,
  press,
} from "../../WorkflowsScreen.test-support.js";

afterEach(cleanup);

/** The chain-held run as one of the runs its chain started, which holds no question of its own. */
function heldBehindChain(run: WorkflowRunReadResponse): WorkflowRunReadResponse {
  const { chainQuestion: _chainQuestion, ...withoutQuestion } = run;
  return {
    ...withoutQuestion,
    chainRoot: { ...run.chainRoot, runId: WORKFLOW_RUN_IDS.chained as WorkflowRunId },
  };
}

/** The step panel, while one is open. */
function stepPanel(): HTMLElement | null {
  return screen.queryByRole("complementary", { name: /^Step / });
}

async function pressEscape(target: Element): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, { key: "Escape" });
    await crossMacrotaskBoundary();
  });
}

describe("a run's page", () => {
  it("opens a failed run on its error, and Escape closes the panel before leaving for the list", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.failed),
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("tab", { name: "Error" }).getAttribute("aria-selected")).toBe("true");
    });

    await pressEscape(screen.getByRole("tab", { name: "Error" }));
    expect(stepPanel()).toBeNull();
    expect(openRunId(mounted)).toBe(WORKFLOW_RUN_IDS.failed);

    // The page kept focus when the panel went, so the next Escape reaches it.
    if (document.activeElement === null) {
      throw new Error("nothing on the page holds focus");
    }
    await pressEscape(document.activeElement);
    expect(openRunId(mounted)).toBeUndefined();
  });

  it("leaves Escape to a text field, and `Answer this run` refuses where no one here is waited on", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingForm),
      answer: async (call, passThrough) => {
        const reply = await passThrough();
        return call.method === "workflow.runRead" &&
          (call.params as { workflowRunId: string }).workflowRunId === WORKFLOW_RUN_IDS.chainHeld
          ? heldBehindChain(reply as WorkflowRunReadResponse)
          : reply;
      },
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("textbox", { name: /^Version/u })).toBeDefined();
    });

    await pressEscape(screen.getByRole("textbox", { name: /^Version/u }));
    expect(stepPanel()).not.toBeNull();

    await pressEscape(screen.getByRole("tab", { name: "Output" }));
    expect(stepPanel()).toBeNull();

    await navigate(mounted, workflowRunsRoute(WORKFLOW_RUN_IDS.succeeded));
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("heading", { level: 2 })).toBeDefined();
    });
    expect(mounted.commandTargets.answerThisRun.press(document)).toMatchObject({
      code: "workflows.nothing_to_answer",
    });
    expect(stepPanel()).toBeNull();

    // A run held behind another run's chain question is answered there, not here.
    await navigate(mounted, workflowRunsRoute(WORKFLOW_RUN_IDS.chainHeld));
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText(/holding its next run behind the chain's question/u)).toBeDefined();
    });
    expect(mounted.commandTargets.answerThisRun.press(document)).toMatchObject({
      code: "workflows.nothing_to_answer",
    });
    mounted.unmount();
  });

  it("settles a reply wait with its receipt through either answer: this page's or its session card's", async () => {
    // Answered here: the reply goes to the session's question, and the receipt stands in its place.
    const answeredHere = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingReply),
    });
    await advanceScenarioUntil(answeredHere.engine, () => {
      expect(screen.getByLabelText(WORKFLOW_REPLY_QUESTION.prompt)).toBeDefined();
    });
    fireEvent.change(screen.getByLabelText(WORKFLOW_REPLY_QUESTION.prompt), {
      target: { value: "needs-triage" },
    });
    await press("Answer");
    await advanceScenarioUntil(answeredHere.engine, () => {
      expect(screen.getByText(/^Answered at /u)).toBeDefined();
    });
    expect(answeredHere.calls.filter((call) => call.method === "question.resolve")).toStrictEqual([
      {
        method: "question.resolve",
        params: {
          questionId: WORKFLOW_REPLY_QUESTION.questionId,
          answers: [{ kind: "typed", text: "needs-triage" }],
        },
      },
    ]);
    expect(screen.queryByLabelText(WORKFLOW_REPLY_QUESTION.prompt)).toBeNull();
    answeredHere.unmount();

    // Answered on the session's card: the same question record, through the same daemon.
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingReply),
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByLabelText(WORKFLOW_REPLY_QUESTION.prompt)).toBeDefined();
    });
    await act(async () => {
      void mounted.bridge.daemon.call("question.resolve", {
        questionId: WORKFLOW_REPLY_QUESTION.questionId,
        answers: [{ kind: "typed", text: "needs-triage" }],
      });
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText(/^Answered at /u)).toBeDefined();
    });
    expect(screen.queryByLabelText(WORKFLOW_REPLY_QUESTION.prompt)).toBeNull();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    mounted.unmount();
  });
});
