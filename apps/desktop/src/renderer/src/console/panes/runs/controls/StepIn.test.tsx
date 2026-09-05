// Step in settles before it moves anybody's focus.
//
// Two claims are worth a unit here, and each is a different bug if it is missed.
// The floor is taken only AFTER the daemon acknowledges the pause — a callback
// fired on dispatch would put the cursor in a composer addressed to a run that is
// still running, and the person would type into a conversation an agent is still
// holding. And a pause that did not happen renders a refusal rather than a
// receipt, because a receipt for a transition the daemon never made is the console
// asserting a state it was never told.
//
// The fixture bridge is the collaborator rather than a hand-rolled double, for the
// reason `compaction-dispatch.test.ts` gives: a double answers whatever this file
// taught it and would prove nothing about the shape the wire actually admits.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { drainMicrotasks, withDaemonCall } from "../../../bridge/fixture-bridge.test-support.js";
import type { ConsoleScenario } from "../../../bridge/scenario.js";
import { StepIn } from "./StepIn.js";

/** A real UUID, because the registered run identifier is a branded UUID. */
const TARGET_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const EXPECTED_RUN_VERSION = 7;
const AGENT_LABEL = "Codex";

/**
 * A scenario carrying at most one canned reply and no beats.
 *
 * Deliberately not one of the registered console scenarios: those belong to the
 * fixture picker, and a unit that needed a picker entry to run would couple this
 * claim to a list six other lanes are also editing.
 */
function scenarioReplying(replies: ConsoleScenario["replies"]): ConsoleScenario {
  return {
    id: "step-in-unit",
    label: "Step in unit",
    purpose: "One canned pause reply, so the control's settlement is observable.",
    sessionId: "session-step-in",
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    beats: [],
    replies,
  };
}

function renderStepIn(replies: ConsoleScenario["replies"]): {
  readonly container: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly onTakeTheFloor: ReturnType<typeof vi.fn>;
} {
  const onTakeTheFloor = vi.fn();
  const { container } = render(
    <StepIn
      bridge={createFixtureBridge({ scenario: scenarioReplying(replies) })}
      targetRunId={TARGET_RUN_ID}
      expectedRunVersion={EXPECTED_RUN_VERSION}
      agentLabel={AGENT_LABEL}
      onTakeTheFloor={onTakeTheFloor}
    />,
  );
  const trigger = container.querySelector(".meridian-step-in__action");
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error("step in rendered no action");
  }
  return { container, trigger, onTakeTheFloor };
}

const ACKNOWLEDGED_PAUSE = {
  call: "run.pause",
  result: { runId: TARGET_RUN_ID, currentState: "paused", runVersion: 8 },
};

describe("StepIn — the floor moves on the acknowledgment, never on the dispatch", () => {
  it("renders the daemon's own state and version once the pause is acknowledged", async () => {
    const { container, trigger, onTakeTheFloor } = renderStepIn([ACKNOWLEDGED_PAUSE]);
    fireEvent.click(trigger);

    // The dispatch is in flight and the floor has NOT moved. This assertion is the
    // ordering claim; without it the test would pass on a component that called
    // back synchronously and only happened to also render a receipt later.
    expect(onTakeTheFloor).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(container.querySelector(".meridian-step-in__receipt")).not.toBeNull();
    });
    const receipt = container.querySelector(".meridian-step-in__receipt")?.textContent ?? "";
    expect(receipt).toContain(AGENT_LABEL);
    expect(receipt).toContain("paused");
    expect(receipt).toContain("8");
    expect(onTakeTheFloor).toHaveBeenCalledTimes(1);
  });

  it("negative control: a reply the registered ack does not admit takes no floor", async () => {
    // `napping` is not a member of the registered run-state enumeration, so this
    // is a daemon composition bug rather than a transition. A component that
    // rendered the reply as received would report a pause that never happened.
    const { container, trigger, onTakeTheFloor } = renderStepIn([
      {
        call: "run.pause",
        result: { runId: TARGET_RUN_ID, currentState: "napping", runVersion: 8 },
      },
    ]);
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-step-in__receipt")).toBeNull();
    expect(onTakeTheFloor).not.toHaveBeenCalled();
  });

  it("settles a rejection as a refusal instead of leaving the control busy", async () => {
    // No reply is scripted for the method, so the fixture rejects — the shape a
    // caller meets when the run is gone or the version guard fails.
    const { container, trigger, onTakeTheFloor } = renderStepIn([]);
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    });
    expect(trigger.getAttribute("aria-busy")).toBe("false");
    expect(onTakeTheFloor).not.toHaveBeenCalled();
  });
});

/** One bridge whose `run.pause` never answers until this suite says so. */
function bridgeParkingThePause(): {
  readonly bridge: ConsoleBridge;
  readonly answerPause: () => void;
} {
  let release: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { bridge } = withDaemonCall(
    createFixtureBridge({ scenario: scenarioReplying([ACKNOWLEDGED_PAUSE]) }),
    async (call, forward) => {
      if (call.method !== "run.pause") {
        return forward();
      }
      await parked;
      return forward();
    },
  );
  return {
    bridge,
    answerPause: (): void => {
      release?.();
    },
  };
}

describe("StepIn — a pause a retired transport answers reaches no live render", () => {
  it("installs nothing and moves no floor when the bridge is replaced mid-pause", async () => {
    const onTakeTheFloor = vi.fn();
    const { bridge: retiring, answerPause } = bridgeParkingThePause();
    const { container, rerender } = render(
      <StepIn
        bridge={retiring}
        targetRunId={TARGET_RUN_ID}
        expectedRunVersion={EXPECTED_RUN_VERSION}
        agentLabel={AGENT_LABEL}
        onTakeTheFloor={onTakeTheFloor}
      />,
    );
    const trigger = container.querySelector(".meridian-step-in__action");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("step in rendered no action");
    }
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-busy")).toBe("true");

    // The reconnect: a REPLACEMENT bridge for the same run, so the component is not
    // remounted — `RunControls` keys its children by run and the run has not moved.
    const replacement = createFixtureBridge({ scenario: scenarioReplying([ACKNOWLEDGED_PAUSE]) });
    rerender(
      <StepIn
        bridge={replacement}
        targetRunId={TARGET_RUN_ID}
        expectedRunVersion={EXPECTED_RUN_VERSION}
        agentLabel={AGENT_LABEL}
        onTakeTheFloor={onTakeTheFloor}
      />,
    );
    // The render that first sees the new transport already reads that subject's own
    // seed, so the busy state of a call the new bridge never made is gone with it.
    expect(trigger.getAttribute("aria-busy")).toBe("false");

    answerPause();
    await drainMicrotasks();

    expect(container.querySelector(".meridian-step-in__receipt")).toBeNull();
    expect(container.querySelector(".meridian-refusal--inline")).toBeNull();
    expect(onTakeTheFloor).not.toHaveBeenCalled();
  });

  it("negative control: the same parked pause installs when the bridge is kept", async () => {
    // Without this the case above would pass over a control that never settles at
    // all, which is what an absence assertion cannot tell apart on its own.
    const onTakeTheFloor = vi.fn();
    const { bridge, answerPause } = bridgeParkingThePause();
    const { container } = render(
      <StepIn
        bridge={bridge}
        targetRunId={TARGET_RUN_ID}
        expectedRunVersion={EXPECTED_RUN_VERSION}
        agentLabel={AGENT_LABEL}
        onTakeTheFloor={onTakeTheFloor}
      />,
    );
    const trigger = container.querySelector(".meridian-step-in__action");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("step in rendered no action");
    }
    fireEvent.click(trigger);
    answerPause();

    await waitFor(() => {
      expect(container.querySelector(".meridian-step-in__receipt")).not.toBeNull();
    });
    expect(onTakeTheFloor).toHaveBeenCalledTimes(1);
  });

  it("refuses a second press while this run's pause is in flight", async () => {
    // The single-flight rule, which used to be a hand-rolled boolean no unmount or
    // re-address superseded: one claim per `(bridge, run)`, so a second press inside
    // the same round dispatches nothing.
    const onTakeTheFloor = vi.fn();
    const { bridge: parked, answerPause } = bridgeParkingThePause();
    const { bridge, calls } = withDaemonCall(parked, async (_call, forward) => forward());
    const { container } = render(
      <StepIn
        bridge={bridge}
        targetRunId={TARGET_RUN_ID}
        expectedRunVersion={EXPECTED_RUN_VERSION}
        agentLabel={AGENT_LABEL}
        onTakeTheFloor={onTakeTheFloor}
      />,
    );
    const trigger = container.querySelector(".meridian-step-in__action");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("step in rendered no action");
    }
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(calls.filter((call) => call.method === "run.pause")).toHaveLength(1);

    answerPause();
    await waitFor(() => {
      expect(container.querySelector(".meridian-step-in__receipt")).not.toBeNull();
    });
  });
});
