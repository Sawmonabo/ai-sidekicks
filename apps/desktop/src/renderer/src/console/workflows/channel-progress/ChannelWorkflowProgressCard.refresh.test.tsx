// The pinned card, while the run it names goes on running.
//
// THE DEFECT THESE CASES EXIST FOR. The card is chrome above a channel's timeline, so
// it is mounted for exactly as long as somebody is reading that conversation — which is
// the whole time the workflow it names is advancing, parking, completing, or failing.
// It held the enumeration it read on the frame the timeline opened, so the card sat
// above the conversation naming a phase count and a state that had stopped being true,
// and the longer somebody stayed the more wrong it got.
//
// WHAT IT REFRESHES ON, AND WHY IT IS NOT A WORKFLOW EVENT. No `workflow.*` type is
// registered in the session-event census — the console's own growth slate carries the
// registration as an unmet prerequisite — so there is no kind the store folds and no
// name `daemon.subscribe` would be served for. The reading therefore declares no
// triggering event kinds and takes the window-scoped triggers, which is what the
// refresh substrate offers a reading no registered signal bears on.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider } from "../../bridge/BridgeProvider.js";
import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  unscriptedScenario,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { ConsoleBridge, WorkflowRunListEntry } from "../../bridge/index.js";
import { WORKFLOWS_CHANNEL_ID } from "../../bridge/scenarios/workflow-fixture-ids.js";
import { WORKFLOWS_PARKED_RUN } from "../../bridge/scenarios/workflow-fixture-runs.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../../core/settle.test-support.js";
import { ChannelWorkflowProgressCard } from "./ChannelWorkflowProgressCard.js";

/** One channel-scoped run entry, named so a case can tell two reads apart. */
function entryNamed(definitionName: string): WorkflowRunListEntry {
  return { ...WORKFLOWS_PARKED_RUN, channelId: WORKFLOWS_CHANNEL_ID, definitionName };
}

/**
 * The enumeration as a session whose run list changes between reads.
 *
 * A class rather than a captured `let`, per this package's state rule. Each read takes
 * the next scripted answer and the last one stands for every read after it.
 */
class ScriptedRunLists {
  readonly #names: readonly string[];
  #readCount = 0;

  public constructor(names: readonly string[]) {
    this.#names = names;
  }

  /** How many times the enumeration actually reached the port. */
  public get readCount(): number {
    return this.#readCount;
  }

  public next(): { readonly runs: readonly WorkflowRunListEntry[] } {
    const name = this.#names[Math.min(this.#readCount, this.#names.length - 1)] ?? "Ship pipeline";
    this.#readCount += 1;
    return { runs: [entryNamed(name)] };
  }
}

function bridgeAnsweringRunLists(lists: ScriptedRunLists): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("channel-progress-refresh"), {
    workflowRunList: growthAnswering<{ readonly runs: readonly WorkflowRunListEntry[] }>(async () =>
      Promise.resolve(lists.next()),
    ),
  });
}

/** The card under a bridge this case owns, scoped to the channel that started the run. */
function renderCard(bridge: ConsoleBridge): void {
  render(
    <SidekicksBridgeProvider bridge={bridge}>
      <ChannelWorkflowProgressCard
        sessionId={WORKFLOWS_PARKED_RUN.sessionId}
        channelId={WORKFLOWS_CHANNEL_ID}
      />
    </SidekicksBridgeProvider>,
  );
}

/** Carry any debounced re-read past its window on the fixture's own frozen clock. */
async function settleCardRead(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
  });
  await settle();
}

/** The window coming back after time passed somewhere else. */
async function returnToTheWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

describe("ChannelWorkflowProgressCard — staying current while it is pinned", () => {
  it("re-reads the enumeration when the window comes back, and names what it says now", async () => {
    const lists = new ScriptedRunLists(["Ship pipeline", "Ship pipeline, amended"]);
    const bridge = bridgeAnsweringRunLists(lists);
    renderCard(bridge);
    await settleCardRead(bridge);

    expect(await screen.findByText("Ship pipeline")).toBeTruthy();

    await returnToTheWindow();
    await settleCardRead(bridge);

    expect(lists.readCount).toBe(2);
    expect(await screen.findByText("Ship pipeline, amended")).toBeTruthy();
  });

  it("negative control: asks once while nothing has told it anything changed", async () => {
    // Without this the case above would hold over a card that re-read on a timer or on
    // every render, which is the poll the refresh chokepoint exists to keep out.
    const lists = new ScriptedRunLists(["Ship pipeline", "Ship pipeline, amended"]);
    const bridge = bridgeAnsweringRunLists(lists);
    renderCard(bridge);
    await settleCardRead(bridge);
    await settleCardRead(bridge);
    await settleCardRead(bridge);

    expect(lists.readCount).toBe(1);
    expect(screen.getByText("Ship pipeline")).toBeTruthy();
  });
});
