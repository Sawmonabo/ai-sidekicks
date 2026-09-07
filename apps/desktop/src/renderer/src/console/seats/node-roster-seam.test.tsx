// One read, two readers — and which answer the second reader is allowed to see.
//
// Driven through the seam itself rather than through a page, because every claim here is
// about the seam: that what a console surface reads beside the absorbed roster is what
// that view's own read answered, including when two reads settle out of order. A page in
// the middle would prove the page's wiring and leave the record free to be wrong.
//
// WHEN that roster is asked to read again is `node-roster-triggers.test.tsx`, beside the
// module that owns it.

import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { RuntimeNodeRosterResponse } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { unscriptedScenario } from "../bridge/fixture/fixture-bridge.test-support.js";
import { SETTINGS_SCENARIO } from "../bridge/scenarios/settings.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import {
  nodeRosterReadsFor,
  useNodeRosterObservation,
  type NodeRosterObservation,
} from "./node-roster-seam.js";
import { bridgeWithRoster, sessionIdOf } from "./node-roster.test-support.js";

/** One line a case can assert on, so an arm change is a text change. */
function readingOf(observation: NodeRosterObservation): string {
  if (observation.kind === "unread") {
    return "unread";
  }
  if (observation.kind === "unreadable") {
    return `unreadable:${observation.refusal.code}`;
  }
  return `read:${observation.response.nodes.length}`;
}

/** A private probe: the observation hook under test, and nothing else. */
function ObservationProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
}): ReactNode {
  const observation = useNodeRosterObservation(props.bridge, props.sessionId);
  return <span data-testid="observation">{readingOf(observation)}</span>;
}

/**
 * One roster reply, told apart from another by the lease holder it names.
 *
 * The holder rather than the node set, because it is one branded scalar the reply
 * genuinely carries — building two node arrays would mean inventing nine members per
 * entry to distinguish two replies by their length.
 */
function rosterHeldBy(participantId: string): RuntimeNodeRosterResponse {
  return {
    nodes: [],
    controlHolder: participantId as RuntimeNodeRosterResponse["controlHolder"],
  };
}

/** A second private probe: which reply the observation is holding, by its lease line. */
function HolderProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}): ReactNode {
  const observation = useNodeRosterObservation(props.bridge, props.sessionId);
  return (
    <span data-testid="holder">
      {observation.kind === "read" ? (observation.response.controlHolder ?? "none") : "unread"}
    </span>
  );
}

/**
 * A bridge whose roster read settles when the case says so, and never before.
 *
 * A stand-in for the TRANSPORT, never for the module under test: the seam is the real
 * one, and what this replaces is the wire behind it — which is the only way to hold
 * two reads open at once and settle them in the order that produced the defect.
 */
function bridgeWithHeldReads(): {
  readonly bridge: ConsoleBridge;
  readonly settleRead: (index: number, response: RuntimeNodeRosterResponse) => void;
} {
  const pendingResolvers: ((response: RuntimeNodeRosterResponse) => void)[] = [];
  const bridge = {
    runtimeNodeRosterRead: async () =>
      await new Promise<{ status: "served"; value: RuntimeNodeRosterResponse }>((resolve) => {
        pendingResolvers.push((response) => {
          resolve({ status: "served", value: response });
        });
      }),
  } as unknown as ConsoleBridge;
  return {
    bridge,
    settleRead: (index, response) => {
      pendingResolvers[index]?.(response);
    },
  };
}

describe("the seam the absorbed roster reads through", () => {
  it("hands one bridge the same read pair every time it is asked", () => {
    // The property the absorbed view's effect depends on: a fresh pair per render
    // would tear its subscription down and re-open it on every render above it.
    const bridge = bridgeWithRoster();
    expect(nodeRosterReadsFor(bridge)).toBe(nodeRosterReadsFor(bridge));
  });

  it("hands a different bridge a different pair, so a transport swap is noticed", () => {
    expect(nodeRosterReadsFor(bridgeWithRoster())).not.toBe(nodeRosterReadsFor(bridgeWithRoster()));
  });
});

describe("what a console surface reads beside the roster", () => {
  it("is the response the roster's own read answered", async () => {
    const bridge = bridgeWithRoster();
    render(<ObservationProbe bridge={bridge} sessionId={SETTINGS_SCENARIO.sessionId} />);
    expect(screen.getByTestId("observation").textContent).toBe("unread");

    await act(async () => {
      await nodeRosterReadsFor(bridge).readRoster({
        sessionId: sessionIdOf(SETTINGS_SCENARIO.sessionId),
      });
    });

    expect(screen.getByTestId("observation").textContent).toBe("read:2");
  });

  it("is the refusal, in the refuser's own code, when the read declined", async () => {
    const scenario = unscriptedScenario("seam-no-roster");
    const bridge = createFixtureBridge({ scenario });
    render(<ObservationProbe bridge={bridge} sessionId={scenario.sessionId} />);

    await act(async () => {
      await nodeRosterReadsFor(bridge)
        .readRoster({ sessionId: sessionIdOf(scenario.sessionId) })
        .catch(() => undefined);
    });

    expect(screen.getByTestId("observation").textContent).toBe("unreadable:roster-unscripted");
  });

  it("negative control: a session nobody read stays unread beside one that was", async () => {
    // Without this, an observation held per BRIDGE rather than per session would pass
    // every case above while answering a new session out of the old session's read.
    const bridge = bridgeWithRoster();
    render(<ObservationProbe bridge={bridge} sessionId="019b7892-1c00-75e5-8510-000000000000" />);

    await act(async () => {
      await nodeRosterReadsFor(bridge).readRoster({
        sessionId: sessionIdOf(SETTINGS_SCENARIO.sessionId),
      });
    });

    expect(screen.getByTestId("observation").textContent).toBe("unread");
  });
});

describe("two roster reads in flight at once", () => {
  it("records the newest-issued read even when the older one settles last", async () => {
    // THE DEFECT IN TERMS. The wrapper recorded every completion as it arrived, while
    // the absorbed view applied its own request-sequence guard only after `readRoster`
    // returned — so an older reply settling last was rejected by the roster and
    // recorded here, and the capability and control-holder blocks then disagreed with
    // the rows beside them. One generation, taken at dispatch, is what makes the two
    // admit the same read.
    const held = bridgeWithHeldReads();
    const reads = nodeRosterReadsFor(held.bridge);
    const sessionId = sessionIdOf("session-overlapping-reads");
    render(<HolderProbe bridge={held.bridge} sessionId={sessionId} />);

    const olderRead = reads.readRoster({ sessionId });
    const newerRead = reads.readRoster({ sessionId });

    await act(async () => {
      held.settleRead(1, rosterHeldBy("participant-newer"));
      held.settleRead(0, rosterHeldBy("participant-older"));
      await Promise.all([olderRead, newerRead]);
      await crossMacrotaskBoundary();
    });

    expect(screen.getByTestId("holder").textContent).toBe("participant-newer");
  });

  it("negative control: one read on its own is still recorded", async () => {
    // Without this the case above would hold for a guard that admitted NOTHING —
    // an observation frozen at `unread` disagrees with the roster just as loudly.
    const held = bridgeWithHeldReads();
    const reads = nodeRosterReadsFor(held.bridge);
    const sessionId = sessionIdOf("session-single-read");
    render(<HolderProbe bridge={held.bridge} sessionId={sessionId} />);

    await act(async () => {
      const onlyRead = reads.readRoster({ sessionId });
      held.settleRead(0, rosterHeldBy("participant-only"));
      await onlyRead;
      await crossMacrotaskBoundary();
    });

    expect(screen.getByTestId("holder").textContent).toBe("participant-only");
  });
});
