// A recovery request belongs to the run it was addressed to, and settles into no other.
//
// A SECOND SUITE BESIDE `RecoveryPrompt.test.tsx` RATHER THAN CASES INSIDE IT, because
// the two drive different things. That one mounts the whole diagnostics page and asserts
// what a person reads after a press; these mount the prompt alone so the run it is
// addressed to can be MOVED under it — which is what the page does when a terminal event
// makes a different run the newest live candidate, and which no page-level harness can
// stage because the candidate is derived from the session store rather than passed.
//
// AND THE REPLIES ARE HELD RATHER THAN DELAYED. The defect is an ORDER — a request put
// for run A answering after run B's has been put — so the case has to decide when each
// one lands. A scripted latency would make the ordering a property of two numbers, and
// the case would go green the day either of them moved.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RunState } from "@ai-sidekicks/contracts";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
  type GrowthOutcome,
  type GrowthRecoveryReceipt,
} from "../../../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../../../core/macrotask-boundary.test-support.js";
import { LiveAnnouncerProvider } from "../../../../primitives/index.js";
import {
  EMPTY_SCENARIO,
  STALLED_RUN_ID,
  answerRecoveryConfirmation,
} from "../diagnostics-page.test-support.js";
import { RecoveryPrompt } from "./RecoveryPrompt.js";

afterEach(() => {
  cleanup();
});

/** The run that becomes the newest live candidate while the first request is out. */
const SUCCEEDING_RUN_ID = "run-stalled-successor";

/** A bridge whose recovery replies wait until a case answers them, by run. */
interface HeldRecoveryRequests {
  readonly bridge: ConsoleBridge;
  /** Answer the request outstanding for one run with the receipt the node sends back. */
  readonly answer: (runId: string, newState: RunState) => Promise<void>;
}

function bridgeHoldingRecoveryRequests(): HeldRecoveryRequests {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  const outstandingByRunId = new Map<
    string,
    (outcome: GrowthOutcome<GrowthRecoveryReceipt>) => void
  >();
  return {
    bridge: {
      ...fixture,
      growth: {
        ...fixture.growth,
        healthRecoveryActionRequest: async (request) =>
          await new Promise<GrowthOutcome<GrowthRecoveryReceipt>>((answerRequest) => {
            outstandingByRunId.set(request.runId, answerRequest);
          }),
      },
    },
    answer: async (runId: string, newState: RunState): Promise<void> => {
      const answerRequest = outstandingByRunId.get(runId);
      if (answerRequest === undefined) {
        throw new Error(`no recovery request is outstanding for ${runId}`);
      }
      outstandingByRunId.delete(runId);
      await act(async () => {
        answerRequest({
          status: "served",
          value: { runId, previousState: "running", newState, actionTaken: "interrupt" },
        });
        await crossMacrotaskBoundary();
      });
    },
  };
}

/** Mount the prompt alone, addressed at one run, and hand back the re-address. */
function renderPromptFor(
  bridge: ConsoleBridge,
  runId: string,
): {
  readonly container: HTMLElement;
  readonly readdressTo: (nextRunId: string) => void;
} {
  const view = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <RecoveryPrompt bridge={bridge} runId={runId} />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  return {
    container: view.container,
    readdressTo: (nextRunId: string): void => {
      view.rerender(
        <SidekicksBridgeProvider bridge={bridge}>
          <LiveAnnouncerProvider>
            <RecoveryPrompt bridge={bridge} runId={nextRunId} />
          </LiveAnnouncerProvider>
        </SidekicksBridgeProvider>,
      );
    },
  };
}

describe("the recovery prompt, when the run under it moves", () => {
  it("installs a retired run's receipt nowhere, leaving the live run's request in flight", async () => {
    // The whole defect in one order: interrupt run A, let a terminal event make run B
    // the candidate, abandon run B, and let A answer last. A's receipt has nothing on
    // this surface to be about, and installing it would report A's transition under B's
    // name AND clear the pending state that is disabling B's own destructive controls.
    const plane = bridgeHoldingRecoveryRequests();
    const prompt = renderPromptFor(plane.bridge, STALLED_RUN_ID);
    await answerRecoveryConfirmation(prompt.container, "Interrupt", "confirm");

    prompt.readdressTo(SUCCEEDING_RUN_ID);
    await answerRecoveryConfirmation(prompt.container, "Abandon", "confirm");
    await plane.answer(STALLED_RUN_ID, "interrupted");

    const outcome = prompt.container.querySelector(".meridian-recovery-prompt__outcome");
    expect(outcome?.textContent).toContain("abandon");
    expect(outcome?.getAttribute("aria-busy")).toBe("true");
  });

  it("leaves the live run's controls disabled while its own request is out", async () => {
    // The second half of the same installation, and the one that matters most: the
    // pending arm is what disables three irreversible controls, so a retired run's
    // settlement clearing it re-offers them while B's own request is still travelling.
    const plane = bridgeHoldingRecoveryRequests();
    const prompt = renderPromptFor(plane.bridge, STALLED_RUN_ID);
    await answerRecoveryConfirmation(prompt.container, "Interrupt", "confirm");

    prompt.readdressTo(SUCCEEDING_RUN_ID);
    await answerRecoveryConfirmation(prompt.container, "Abandon", "confirm");
    await plane.answer(STALLED_RUN_ID, "interrupted");

    const triggers = [
      ...prompt.container.querySelectorAll<HTMLButtonElement>(
        ".meridian-recovery-prompt__actions button",
      ),
    ];
    expect(triggers).toHaveLength(3);
    expect(triggers.every((trigger) => trigger.disabled)).toBe(true);
  });

  // THE NEGATIVE CONTROL for both cases above. The prompt is not simply deaf to every
  // settlement: the run it is addressed to now answers, and that receipt renders. A
  // guard that dropped everything would pass the two cases above and leave the surface
  // unable to report the one request a person is actually waiting on.
  it("installs the receipt for the run it is addressed to now", async () => {
    const plane = bridgeHoldingRecoveryRequests();
    const prompt = renderPromptFor(plane.bridge, STALLED_RUN_ID);
    await answerRecoveryConfirmation(prompt.container, "Interrupt", "confirm");

    prompt.readdressTo(SUCCEEDING_RUN_ID);
    await answerRecoveryConfirmation(prompt.container, "Abandon", "confirm");
    await plane.answer(SUCCEEDING_RUN_ID, "interrupted");

    const outcome = prompt.container.querySelector(".meridian-recovery-prompt__outcome");
    expect(outcome?.textContent).toContain("went from");
    expect(outcome?.getAttribute("role")).toBe("status");
  });

  // And the re-address itself carries nothing forward: the pass that first sees the new
  // run already reads that run's own idle seed, so no frame paints the previous run's
  // receipt under the new run's name.
  it("shows the new run nothing the previous run's request had produced", async () => {
    const plane = bridgeHoldingRecoveryRequests();
    const prompt = renderPromptFor(plane.bridge, STALLED_RUN_ID);
    await answerRecoveryConfirmation(prompt.container, "Interrupt", "confirm");
    await plane.answer(STALLED_RUN_ID, "interrupted");
    expect(prompt.container.textContent).toContain("went from");

    prompt.readdressTo(SUCCEEDING_RUN_ID);

    expect(prompt.container.querySelector(".meridian-recovery-prompt__outcome")).toBeNull();
  });
});
