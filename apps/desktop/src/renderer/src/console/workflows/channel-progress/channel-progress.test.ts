// Which run a channel pins, and the two figures the card states about it.
//
// The picking rule is the whole subject: a channel pins the run a person most needs to
// see, and pins nothing at all in three different situations that render identically.
// Driven as a value rather than through a DOM, because every one of these claims is
// about the projection and none of them is about an element.

import { describe, expect, it } from "vitest";

import type { WorkflowRunListEntry } from "../../bridge/index.js";
import { channelWorkflowProgress } from "./channel-progress.js";

const CHANNEL = "019b7a10-0280-7c41-8510-cf1a11e10001";
const OTHER_CHANNEL = "019b7a10-0280-7c41-8510-cf1a11e10002";

/** One enumeration entry, with only what the projection reads varied. */
function entry(overrides: Partial<WorkflowRunListEntry> = {}): WorkflowRunListEntry {
  return {
    workflowRunId: "run-1",
    sessionId: "session-1",
    workflowVersionId: "version-1",
    definitionName: "Ship pipeline",
    state: "running",
    startedAt: "2026-01-01T09:00:00.000Z",
    phaseStates: [
      { phaseId: "draft", state: "completed", gateState: "open" },
      { phaseId: "build", state: "running", gateState: "closed" },
    ],
    ...overrides,
  };
}

describe("channelWorkflowProgress — which run a channel pins", () => {
  it("pins the run that named this channel", () => {
    const progress = channelWorkflowProgress(
      [
        entry({ workflowRunId: "run-elsewhere", channelId: OTHER_CHANNEL }),
        entry({ workflowRunId: "run-here", channelId: CHANNEL }),
      ],
      CHANNEL,
    );

    expect(progress?.row.run.workflowRunId).toBe("run-here");
  });

  it("counts phases completed of phases the run read carried", () => {
    const progress = channelWorkflowProgress(
      [
        entry({
          channelId: CHANNEL,
          phaseStates: [
            { phaseId: "draft", state: "completed", gateState: "open" },
            { phaseId: "build", state: "completed", gateState: "open" },
            { phaseId: "review", state: "running", gateState: "closed" },
            { phaseId: "ship", state: "pending", gateState: "closed" },
          ],
        }),
      ],
      CHANNEL,
    );

    expect(progress).toMatchObject({ completedPhaseCount: 2, totalPhaseCount: 4 });
  });

  it("pins the parked run ahead of a running one, as the run list orders them", () => {
    // The order is `RunListProjection`'s and is not re-decided here — which is the
    // claim: a channel that started two workflows shows the one waiting on somebody.
    const progress = channelWorkflowProgress(
      [
        entry({ workflowRunId: "run-running", channelId: CHANNEL }),
        entry({
          workflowRunId: "run-parked",
          channelId: CHANNEL,
          state: "suspended",
          phaseStates: [
            {
              phaseId: "build",
              state: "running",
              gateState: "closed",
              parkReason: "waiting-human",
              parkCause: "A sign-off is outstanding.",
            },
          ],
        }),
      ],
      CHANNEL,
    );

    expect(progress?.row.run.workflowRunId).toBe("run-parked");
    expect(progress?.row.parkedPhases).toHaveLength(1);
  });
});

describe("channelWorkflowProgress — the three ways of pinning nothing", () => {
  it("pins nothing when the pane names no channel", () => {
    expect(channelWorkflowProgress([entry({ channelId: CHANNEL })], undefined)).toBeUndefined();
  });

  it("pins nothing when no run named this channel", () => {
    // Including a run with no channel at all, which is every run not started from a
    // conversation — absent must not read as "this one".
    expect(
      channelWorkflowProgress(
        [entry({ channelId: OTHER_CHANNEL }), entry({ workflowRunId: "run-2" })],
        CHANNEL,
      ),
    ).toBeUndefined();
  });

  it("pins nothing when every run this channel started has settled", () => {
    expect(
      channelWorkflowProgress(
        [
          entry({ workflowRunId: "run-done", channelId: CHANNEL, state: "completed" }),
          entry({ workflowRunId: "run-cancelled", channelId: CHANNEL, state: "cancelled" }),
          entry({ workflowRunId: "run-failed", channelId: CHANNEL, state: "failed" }),
        ],
        CHANNEL,
      ),
    ).toBeUndefined();
  });

  it("negative control: the same table with one live run does pin it", () => {
    // Without this the three absences above are equally satisfied by a projection that
    // returns `undefined` whatever it is handed.
    expect(
      channelWorkflowProgress(
        [
          entry({ workflowRunId: "run-done", channelId: CHANNEL, state: "completed" }),
          entry({ workflowRunId: "run-live", channelId: CHANNEL }),
        ],
        CHANNEL,
      )?.row.run.workflowRunId,
    ).toBe("run-live");
  });
});
