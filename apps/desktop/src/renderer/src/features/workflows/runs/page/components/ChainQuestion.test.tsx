// The chain's question on its first run's page, over the fixture's held chain: it names the
// workflow, the count and the first run's start, `Keep going` answers the approval the engine
// raised on that run and leaves its receipt at once, and an answered question is a receipt with
// no way back.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { WORKFLOW_FIXTURE_NOW_MS } from "#fixtures/data/workflow/clock.js";
import { WORKFLOW_RUN_IDS, WORKFLOW_RUN_RECORDS } from "#fixtures/data/workflow/run/records.js";
import { MILLISECONDS_PER_DAY } from "#renderer/lib/instant.js";
import { formatDayClock } from "#renderer/lib/wire/figures.js";
import { createWorkflowCommandTargets } from "#renderer/features/workflows/command-target.js";
import { withCommandTargets } from "#renderer/features/workflows/command-target.test-support.js";
import { ChainQuestion } from "./ChainQuestion.js";

/** How long the fixture daemon takes to answer `workflow.gateResolve`. */
const GATE_RESOLVE_DELAY_MS = 200;

/** A day after the chain started, so its start names its day. */
const NEXT_DAY_MS = WORKFLOW_FIXTURE_NOW_MS + MILLISECONDS_PER_DAY;

function heldChainRun(): WorkflowRunReadResponse {
  const record = WORKFLOW_RUN_RECORDS.find(
    (run) => run.read.workflowRunId === WORKFLOW_RUN_IDS.chainHeld,
  );
  if (record?.read.chainQuestion === undefined) {
    throw new Error("the fixture's held chain carries no question");
  }
  return record.read;
}

describe("the chain's question", () => {
  it("answers Keep going as the first run's approval, naming no step, and counts it", async () => {
    const run = heldChainRun();
    const onAnswered = vi.fn();
    const { bridge, calls, engine } = bridgeAnswering(async (_call, passThrough) => passThrough());
    render(
      <ChainQuestion
        question={{ state: "open" }}
        chainRoot={run.chainRoot}
        bridge={bridge}
        nowMs={NEXT_DAY_MS}
        onAnswered={onAnswered}
      />,
      {
        wrapper: withCommandTargets(
          bridgeWrapper(bridge, engine.clock),
          createWorkflowCommandTargets(),
        ),
      },
    );

    expect(
      screen.getByText(
        `Folder sweep has started 100 runs from its ` +
          `${formatDayClock(run.chainRoot.startedAt, NEXT_DAY_MS)} start. Keep going?`,
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    await waitFor(() => {
      expect(calls).toStrictEqual([
        {
          method: "workflow.gateResolve",
          params: { workflowRunId: WORKFLOW_RUN_IDS.chainHeld, decision: "approved" },
        },
      ]);
    });
    // The receipt stands once the daemon takes the answer, before the run reads back answered,
    // and the answer is counted once.
    await act(async () => {
      engine.advance(GATE_RESOLVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(await screen.findByText("Kept going at 100 runs")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it("reads an answered question as its receipt, with no way back", () => {
    const run = heldChainRun();
    const { bridge } = bridgeAnswering(async (_call, passThrough) => passThrough());
    render(
      <ChainQuestion
        question={{
          state: "answered",
          decision: "rejected",
          runCount: 100,
          answeredAt: run.startedAt,
        }}
        chainRoot={run.chainRoot}
        bridge={bridge}
        nowMs={NEXT_DAY_MS}
        onAnswered={() => undefined}
      />,
      { wrapper: withCommandTargets(bridgeWrapper(bridge), createWorkflowCommandTargets()) },
    );

    expect(screen.getByText("Stopped at 100 runs")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
