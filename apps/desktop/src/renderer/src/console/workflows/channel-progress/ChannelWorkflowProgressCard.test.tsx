// What the pinned card puts on screen, over the fixture that carries a channel-scoped
// run.
//
// The card reads through `useConsoleBridge`, so every case mounts it inside the real
// provider on the `workflows` scenario — the one scenario whose run table carries the
// chat-start provenance a channel-scoped surface needs. That is deliberate rather than
// convenient: a fake port here would prove the card renders a shape this repository
// hands it nowhere, and the absence arm below is only meaningful against a fixture that
// really does hold runs for a different channel.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider } from "../../bridge/BridgeProvider.js";
import { WORKFLOWS_SCENARIO_ID } from "../../bridge/scenarios/workflows.js";
import {
  WORKFLOWS_CHANNEL_ID,
  WORKFLOWS_SESSION_ID,
} from "../../bridge/scenarios/workflow-fixture-ids.js";
import { ChannelWorkflowProgressCard } from "./ChannelWorkflowProgressCard.js";

/** The card under the fixture bridge, scoped as a pane of that kind would scope it. */
function renderCard(channelId: string | undefined): HTMLElement {
  return render(
    <SidekicksBridgeProvider scenarioId={WORKFLOWS_SCENARIO_ID}>
      <ChannelWorkflowProgressCard sessionId={WORKFLOWS_SESSION_ID} channelId={channelId} />
    </SidekicksBridgeProvider>,
  ).container;
}

describe("ChannelWorkflowProgressCard — the channel that started a workflow", () => {
  it("names the definition, the run, its state and its phase progress", async () => {
    renderCard(WORKFLOWS_CHANNEL_ID);

    // The definition's name is the console's prose and the run id is the wire's own
    // figure; the card carries both, so a run read that carried no name still shows
    // something a person can search for.
    expect(await screen.findByText("Ship pipeline")).toBeTruthy();
    expect(screen.getByText(/of .* phases completed/u)).toBeTruthy();
    expect(screen.getByText("suspended")).toBeTruthy();
  });

  it("reads the park from the projection, not from a phase's state", async () => {
    renderCard(WORKFLOWS_CHANNEL_ID);

    // The fixture's parked run is parked `waiting-human` on a phase whose own `state`
    // is `running` — which is exactly the case a surface reading `state` gets wrong.
    expect(await screen.findByText("Waiting on a person")).toBeTruthy();
  });
});

describe("ChannelWorkflowProgressCard — the channel that started none", () => {
  it("renders no element for a channel no run named", async () => {
    const container = renderCard("019b7a10-0280-7c41-8510-cf1a11e10099");

    // Awaited on the sibling case's own subject so the read has settled before the
    // emptiness is claimed: without the wait this passes on the frame before any
    // answer arrived, which would be green over a card that renders everything.
    await expect(screen.findByText("Ship pipeline")).rejects.toThrow();
    expect(container.querySelector(".meridian-channel-progress")).toBeNull();
  });

  it("renders no element on a session-scoped pane", async () => {
    const container = renderCard(undefined);

    await expect(screen.findByText("Ship pipeline")).rejects.toThrow();
    expect(container.querySelector(".meridian-channel-progress")).toBeNull();
  });
});
