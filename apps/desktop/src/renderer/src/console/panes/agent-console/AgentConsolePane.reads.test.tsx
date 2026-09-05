// What the agent console asks the daemon for, and what arrives after the mount.
//
// Both subjects here are about a projection ARRIVING after the pane is on screen —
// the peer-invocation grant a re-read fetches, and the run a beat projects — so every
// case drives a store this file owns rather than the played scenario's. A scenario
// that already carried both would assert nothing about either.
//
// What the pane DRAWS is `AgentConsolePane.render.test.tsx`; how long a linkage read
// lives once it is keyed is `AgentConsolePane.linkage-lifetime.test.tsx`.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  growthRefusing,
  growthServing,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import {
  OWNED_AGENT_ID,
  projectingStore,
  renderOwnedPane,
} from "./agent-console-pane.test-support.js";
import {
  PROJECTION_SESSION_ID,
  bridgeReadingProjection,
  settleReads,
  snapshotEnabling,
} from "./agent-console.test-support.js";

// --- The peers-and-linkage column ---------------------------------------------
//
// Both cases below drive a store this file owns rather than the played scenario's,
// because what they are about is a projection ARRIVING after the mount: the grant
// a re-read fetches, and the run a beat projects. A scenario that already carried
// both would assert nothing about either.

describe("agent console — asking the daemon again for the peer-invocation grant", () => {
  it("makes a served grant appear, which is what the offered recovery promises", async () => {
    // The shipped session read carries no `peerInvocationEnabled`, so the control
    // opens unknown. Pressing its recovery has to ASK: a re-derivation over the
    // same synchronous snapshot would answer unknown forever.
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const container = renderOwnedPane(bridge, projectingStore());
    await settleReads(bridge);
    expect(container.textContent ?? "").toContain("did not report");

    const reRead = container.querySelector(".meridian-peer__action");
    expect(reRead).not.toBeNull();
    await act(async () => {
      fireEvent.click(reRead as HTMLElement);
    });
    await settleReads(bridge);

    expect(container.querySelector(".meridian-peer__switch")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("did not report");
  });

  it("negative control: without the press the grant never appears", async () => {
    // Without this, the case above would pass over a pane that read the projection
    // on mount — and the press would be proving nothing.
    const bridge = bridgeReadingProjection(growthServing(snapshotEnabling(true)));
    const container = renderOwnedPane(bridge, projectingStore());
    await settleReads(bridge);
    await settleReads(bridge);

    expect(container.querySelector(".meridian-peer__switch")).toBeNull();
    expect(container.textContent ?? "").toContain("did not report");
  });

  it("renders the port's own refusal when the re-read is refused", async () => {
    const bridge = bridgeReadingProjection(growthRefusing("sessionRead"));
    const container = renderOwnedPane(bridge, projectingStore());
    await settleReads(bridge);
    await act(async () => {
      fireEvent.click(container.querySelector(".meridian-peer__action") as HTMLElement);
    });
    await settleReads(bridge);

    expect(container.textContent ?? "").toContain("wire-unregistered");
    expect(container.querySelector(".meridian-peer__switch")).toBeNull();
  });

  it("says nothing was asked when the pane holds no session to read through", async () => {
    // A press that did nothing at all would read exactly like a read that came
    // back with the same answer, and only one of those is a fact about a daemon.
    const bridge = bridgeReadingProjection(growthRefusing("sessionRead"));
    const container = renderOwnedPane(bridge);
    await settleReads(bridge);
    await act(async () => {
      fireEvent.click(container.querySelector(".meridian-peer__action") as HTMLElement);
    });

    expect(container.textContent ?? "").toContain("was not handed a session");
  });
});

describe("agent console — the run this agent's linkage is keyed by", () => {
  it("picks up a run that started after the mount", async () => {
    // The pane subscribes to the agent roster, and a run starting emits none of the
    // three agent-lifecycle kinds that signal it — so a one-off snapshot read kept
    // saying the agent had no run for as long as the pane stayed open.
    const bridge = bridgeReadingProjection(growthRefusing("sessionRead"));
    const sessionStore = projectingStore();
    const container = renderOwnedPane(bridge, sessionStore);
    await settleReads(bridge);
    expect(container.textContent ?? "").toContain("No run of this agent is on the timeline yet");

    await act(async () => {
      sessionStore.apply({
        id: "event-1",
        sessionId: PROJECTION_SESSION_ID,
        sequence: 1,
        kind: "run.queued",
        occurredAt: "2026-01-01T10:06:00.000Z",
        payload: {
          sessionId: PROJECTION_SESSION_ID,
          runId: "run-7",
          newState: "queued",
          agentId: OWNED_AGENT_ID,
        },
      });
    });

    expect(container.textContent ?? "").toContain("Reading what this run started");
    expect(container.textContent ?? "").not.toContain(
      "No run of this agent is on the timeline yet",
    );
  });

  it("negative control: a run belonging to another agent leaves the linkage unkeyed", async () => {
    // Without this, the case above would pass over a mount that keyed its linkage
    // to whichever run moved last, whoever it belonged to.
    const bridge = bridgeReadingProjection(growthRefusing("sessionRead"));
    const sessionStore = projectingStore();
    const container = renderOwnedPane(bridge, sessionStore);
    await settleReads(bridge);

    await act(async () => {
      sessionStore.apply({
        id: "event-1",
        sessionId: PROJECTION_SESSION_ID,
        sequence: 1,
        kind: "run.queued",
        occurredAt: "2026-01-01T10:06:00.000Z",
        payload: {
          sessionId: PROJECTION_SESSION_ID,
          runId: "run-8",
          newState: "queued",
          agentId: "agent-other",
        },
      });
    });

    expect(container.textContent ?? "").toContain("No run of this agent is on the timeline yet");
  });
});
