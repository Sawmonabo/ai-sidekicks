// What the pinned card puts on screen, over the fixture that carries a channel-scoped
// run.
//
// The card reads through `useConsoleBridge`, so every case mounts it inside the real
// provider on the `workflows` scenario — the one scenario whose run table carries the
// chat-start provenance a channel-scoped surface needs. That is deliberate rather than
// convenient: a fake port here would prove the card renders a shape this repository
// hands it nowhere, and the absence arm below is only meaningful against a fixture that
// really does hold runs for a different channel.
//
// AND EVERY CASE ADVANCES THE SCENARIO'S OWN CLOCK BEFORE IT LOOKS. The card's read is
// live rather than one-shot, so its first answer is armed on the refresh chokepoint's
// debounce — and under the fixture the scenario's frozen clock is the only clock this
// renderer reads. A case that waited on real time would wait forever, and one that
// asserted an absence without advancing would be green over a card that never draws.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider } from "../../bridge/BridgeProvider.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../../bridge/scenario/workflows/workflows.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../../core/settle.test-support.js";
import { WORKFLOWS_CHANNEL_ID, WORKFLOWS_SESSION_ID } from "../../bridge/scenario/workflows/ids.js";
import { WORKFLOWS_PARKED_RUN } from "../../bridge/scenario/workflows/runs.js";
import type { ConsolePaneOpener } from "../../seats/index.js";
import { ChannelWorkflowProgressCard } from "./ChannelWorkflowProgressCard.js";

/** One mounted card, and the bridge whose frozen clock its read is armed on. */
interface MountedCard {
  readonly container: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/** The card under the fixture bridge, scoped as a pane of that kind would scope it. */
function renderCard(channelId: string | undefined, openPane?: ConsolePaneOpener): MountedCard {
  const bridge = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const { container } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <ChannelWorkflowProgressCard
        sessionId={WORKFLOWS_SESSION_ID}
        channelId={channelId}
        openPane={openPane}
      />
    </SidekicksBridgeProvider>,
  );
  return { container, bridge };
}

/** Mount the card and carry its debounced read past the chokepoint's window. */
async function cardWithItsReadSettled(
  channelId: string | undefined,
  openPane?: ConsolePaneOpener,
): Promise<MountedCard> {
  const mounted = renderCard(channelId, openPane);
  await act(async () => {
    mounted.bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
  });
  await settle();
  return mounted;
}

describe("ChannelWorkflowProgressCard — the channel that started a workflow", () => {
  it("names the definition, the run, its state and its phase progress", async () => {
    await cardWithItsReadSettled(WORKFLOWS_CHANNEL_ID);

    // The definition's name is the console's prose and the run id is the wire's own
    // figure; the card carries both, so a run read that carried no name still shows
    // something a person can search for.
    expect(await screen.findByText("Ship pipeline")).toBeTruthy();
    expect(screen.getByText(/of .* phases completed/u)).toBeTruthy();
    expect(screen.getByText("suspended")).toBeTruthy();
  });

  it("reads the park from the projection, not from a phase's state", async () => {
    await cardWithItsReadSettled(WORKFLOWS_CHANNEL_ID);

    // The fixture's parked run is parked `waiting-human` on a phase whose own `state`
    // is `running` — which is exactly the case a surface reading `state` gets wrong.
    expect(await screen.findByText("Waiting on a person")).toBeTruthy();
  });
});

describe("ChannelWorkflowProgressCard — the route to the run", () => {
  it("opens the run's own pane, at the address the runs list opens it with", async () => {
    const openPane = vi.fn();
    await cardWithItsReadSettled(WORKFLOWS_CHANNEL_ID, openPane);

    (await screen.findByRole("button", { name: "Open the run" })).click();

    // The whole address, not just the kind: a route that opened a bare
    // `workflow-run` pane would land on the pane picker rather than on the run this
    // card is about, and the entity is what carries the difference.
    expect(openPane).toHaveBeenCalledWith({
      kind: "workflow-run",
      entity: { kind: "workflow-run", id: WORKFLOWS_PARKED_RUN.workflowRunId },
    });
  });

  it("negative control: draws no route where the host supplied no opener", async () => {
    await cardWithItsReadSettled(WORKFLOWS_CHANNEL_ID);

    // Awaited on the card's own subject so the read has settled before the absence is
    // claimed — without it this passes on the frame before any answer arrived, which
    // is green over a card that never draws the control at all.
    expect(await screen.findByText("Ship pipeline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the run" })).toBeNull();
  });
});

describe("ChannelWorkflowProgressCard — the channel that started none", () => {
  it("renders no element for a channel no run named", async () => {
    const { container } = await cardWithItsReadSettled("019b7a10-0280-7c41-8510-cf1a11e10099");

    // Awaited on the sibling case's own subject so the read has settled before the
    // emptiness is claimed: without the wait this passes on the frame before any
    // answer arrived, which would be green over a card that renders everything.
    await expect(screen.findByText("Ship pipeline")).rejects.toThrow();
    expect(container.querySelector(".meridian-channel-progress")).toBeNull();
  });

  it("renders no element on a session-scoped pane", async () => {
    const { container } = await cardWithItsReadSettled(undefined);

    await expect(screen.findByText("Ship pipeline")).rejects.toThrow();
    expect(container.querySelector(".meridian-channel-progress")).toBeNull();
  });
});
