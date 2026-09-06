// The roster read is re-taken, and the moments it is re-taken at are not this
// module's to choose.
//
// The claim worth a suite is the one the effect it replaced could not make. A read
// armed once per addressing is current at mount and stale from the next reconnect,
// and this chip is where that shows: `agent.list` is how a client that did not issue
// the mutation learns a provider switch is queued, so a collaborator queueing one
// after the composer mounted left the chip saying there was none — indefinitely, and
// beside a label half that did refresh.
//
// Driven through the hook rather than the class, because the wiring is the subject:
// a class with a `requestRead` nobody calls is the same defect wearing a better name.

import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import { settleScheduledRead } from "../../../console/bridge/scheduled-read.test-support.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { AGENT_IMPLEMENTER } from "../../../console/bridge/scenarios/composer.identifiers.js";
import { SessionStore, type ConsoleSessionEvent } from "../../../console/store/index.js";
import { useAgentBindingReading, type AgentBindingReading } from "./agent-binding-read.js";

/** A fixture bridge whose roster calls are counted, and the counter. */
function countingBridge(): { readonly bridge: ConsoleBridge; readonly rosterReads: () => number } {
  const fixture = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  let reads = 0;
  const bridge: ConsoleBridge = {
    ...fixture,
    growth: {
      ...fixture.growth,
      agentList: async (request) => {
        reads += 1;
        return fixture.growth.agentList(request);
      },
    },
  };
  return { bridge, rosterReads: () => reads };
}

/** One timeline event of whatever kind the case is about. */
function sessionEvent(kind: string, sequence: number): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: COMPOSER_SCENARIO.sessionId,
    sequence,
    kind,
    occurredAt: "2026-01-01T11:06:00.000Z",
  };
}

/** The scenario's session, opened empty so each case appends what it is about. */
function openStore(): SessionStore {
  const store = new SessionStore({ sessionId: COMPOSER_SCENARIO.sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

async function mountReading(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  agentId: string | undefined,
): Promise<void> {
  renderHook(() => useAgentBindingReading(bridge, sessionStore, agentId));
  await settleScheduledRead(bridge);
}

/**
 * The same mount, handing back what the chip reads.
 *
 * Separate from {@link mountReading} rather than widening it, because the cases above
 * assert on the CALL COUNT and would say nothing about a readout they never looked at.
 */
async function mountedReadout(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  agentId: string | undefined,
  wrapper?: React.ComponentType<{ readonly children: React.ReactNode }>,
): Promise<() => AgentBindingReading> {
  const rendered = renderHook(() => useAgentBindingReading(bridge, sessionStore, agentId), {
    wrapper,
  });
  await settleScheduledRead(bridge);
  return () => rendered.result.current;
}

/** A fixture bridge whose roster call rejects rather than answering. */
function rejectingBridge(rejection: unknown): ConsoleBridge {
  const fixture = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  return {
    ...fixture,
    growth: {
      ...fixture.growth,
      agentList: () => Promise.reject(rejection),
    },
  };
}

describe("the addressed agent's roster read is kept current", () => {
  it("reads again when the window comes back", async () => {
    const { bridge, rosterReads } = countingBridge();
    await mountReading(bridge, openStore(), AGENT_IMPLEMENTER);
    expect(rosterReads()).toBe(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(bridge);

    expect(rosterReads()).toBe(2);
  });

  it("reads again when the session says an agent's configuration moved", async () => {
    // The concrete failure this closes: a switch queued by a collaborator reaches
    // this window as `agent.config_updated`, and the roster read is the only thing
    // that can say what the switch IS.
    const { bridge, rosterReads } = countingBridge();
    const sessionStore = openStore();
    await mountReading(bridge, sessionStore, AGENT_IMPLEMENTER);
    expect(rosterReads()).toBe(1);

    act(() => {
      sessionStore.applyBatch([sessionEvent("agent.config_updated", 1)]);
    });
    await settleScheduledRead(bridge);

    expect(rosterReads()).toBe(2);
  });

  it("negative control: an unrelated event kind is not a reason to re-read", async () => {
    // Without this the case above would pass over a reading that re-read on every
    // event the timeline carried, which is the poll the scheduler exists to refuse.
    const { bridge, rosterReads } = countingBridge();
    const sessionStore = openStore();
    await mountReading(bridge, sessionStore, AGENT_IMPLEMENTER);

    act(() => {
      sessionStore.applyBatch([sessionEvent("run.started", 1)]);
    });
    await settleScheduledRead(bridge);

    expect(rosterReads()).toBe(1);
  });

  it("negative control: a composer addressed at a channel asks nothing at all", async () => {
    // Every trigger still fires; the reading names no agent, so there is no question
    // to put and none is put.
    const { bridge, rosterReads } = countingBridge();
    const sessionStore = openStore();
    await mountReading(bridge, sessionStore, undefined);

    act(() => {
      window.dispatchEvent(new Event("focus"));
      sessionStore.applyBatch([sessionEvent("agent.config_updated", 1)]);
    });
    await settleScheduledRead(bridge);

    expect(rosterReads()).toBe(0);
  });
});

describe("a roster call that rejects is a refusal and never a silence", () => {
  it("publishes the rejection as this reading's refused phase", async () => {
    // The fixture throws for a scripted reply it cannot read and a live transport
    // rejects when the call does not complete. Neither is one of the port's outcome
    // arms, so neither reached the chip: the rejection went to the scheduler's error
    // arm, which drops it, and the chip stayed on `loading` saying nothing at all.
    const readout = await mountedReadout(
      rejectingBridge(new Error("the preload is a stub")),
      openStore(),
      AGENT_IMPLEMENTER,
    );

    expect(readout().phase).toBe("refused");
    expect(readout().refusal?.detail).toContain("the preload is a stub");
  });

  it("carries a rejection nothing can read rather than throwing on it", async () => {
    // The normalizer owns totality, and the arm that matters is the one where the
    // value misbehaves: a refusal path that itself throws reports nothing twice.
    const readout = await mountedReadout(
      rejectingBridge(undefined),
      openStore(),
      AGENT_IMPLEMENTER,
    );

    expect(readout().phase).toBe("refused");
    expect(readout().refusal?.origin).toBe("agent-roster");
  });

  it("negative control: a served roster leaves no refusal behind", async () => {
    // Without this the cases above would pass over a reading that refused every read.
    const readout = await mountedReadout(
      createFixtureBridge({ scenario: COMPOSER_SCENARIO }),
      openStore(),
      AGENT_IMPLEMENTER,
    );

    expect(readout().phase).toBe("read");
    expect(readout().refusal).toBeUndefined();
  });
});

describe("the reading survives a remount that disposes it", () => {
  it("re-mints rather than holding the reading its own cleanup disposed", async () => {
    // React's double-mount runs the committed cleanup and re-runs the effect against
    // the value it just closed. Held in a memo whose dependencies had not moved, the
    // reading was never re-minted, so `requestRead` short-circuited on the disposed
    // flag and the chip sat on `not-checked` for the life of the window — with the
    // read count proving it: nothing was ever asked.
    const { bridge, rosterReads } = countingBridge();
    const readout = await mountedReadout(bridge, openStore(), AGENT_IMPLEMENTER, StrictMode);

    expect(rosterReads()).toBeGreaterThanOrEqual(1);
    expect(readout().phase).toBe("read");
  });

  it("keeps reading on later triggers after that remount", async () => {
    // The disposed reading refused every trigger too, so a read count that moved once
    // at mount would not tell the two apart.
    const { bridge, rosterReads } = countingBridge();
    const sessionStore = openStore();
    await mountedReadout(bridge, sessionStore, AGENT_IMPLEMENTER, StrictMode);
    const afterMount = rosterReads();

    act(() => {
      sessionStore.applyBatch([sessionEvent("agent.config_updated", 1)]);
    });
    await settleScheduledRead(bridge);

    expect(rosterReads()).toBeGreaterThan(afterMount);
  });
});
