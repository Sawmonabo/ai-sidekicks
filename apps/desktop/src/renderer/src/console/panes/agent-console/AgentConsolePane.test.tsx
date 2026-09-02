// The agent console says which agent it is about, or says it does not know.
//
// One body mounted twice — by the deck as a pane and by the frame as an auxiliary
// window — so the cases drive the COMPONENT rather than either mount, and the two
// registrars are covered where they are composed. What is checked here is the pair
// of absences a mount cannot rule out: an address that named a session and no
// agent, and a definition editor whose body belongs to another plan.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { RUN_LIFECYCLE_PROJECTORS } from "../../frame/run-lifecycle-projector.js";
import { SessionStore, type SessionSnapshot } from "../../store/index.js";
import { AgentConsolePane } from "./AgentConsolePane.js";

const SESSION_ID = "session-9";
const AGENT_ID = "agent-scout";

/** The real fixture bridge with the one growth operation this pane re-reads replaced. */
function bridgeReading(sessionRead: ConsoleBridge["growth"]["sessionRead"]): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("agent-console-pane"), { sessionRead });
}

/** A session read that reports the grant, which the shipped reply does not carry. */
function snapshotEnablingPeerInvocation(): SessionSnapshot {
  return {
    cursor: 4,
    entities: [{ kind: "session", id: SESSION_ID, body: { peerInvocationEnabled: true } }],
    participantJoinLog: [],
  };
}

/** A store with the window's own projectors, so a run beat projects a run row. */
function projectingStore(): SessionStore {
  const sessionStore = new SessionStore({
    sessionId: SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** Let the mount's effects, the frozen clock, and every settled reply land. */
async function settle(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(500);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
}

describe("agent console — the agent it is about", () => {
  it("renders the agent id as a wire figure, verbatim", () => {
    // A wire string wears the provenance signature. Rendered as prose it would be
    // indistinguishable from a name the console composed.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    const figure = container.querySelector(".meridian-figure--wire");
    expect(figure?.textContent).toBe("agent-scout");
  });

  it("says so when the address named a session and no agent", () => {
    // Reachable: the frame's context picker resolves a bare auxiliary address by
    // choosing a session, and the agent-console grammar carries its agent with its
    // session — so a picked session arrives here with no agent named.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId={undefined} bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").toContain("not yet on one of its agents");
  });

  it("negative control: the subject line is not the same in both cases", () => {
    // Without this, the two cases above would pass over a pane that rendered one
    // fixed sentence and never the id.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").not.toContain("not yet on one of its agents");
  });
});

describe("agent console — the machines column", () => {
  it("says the question was not put under the fixture", () => {
    // The node roster reads the installed bridge directly, so under the fixture the
    // console declines to ask on its behalf. Only this arm is mounted here; the
    // live arm is covered by inspecting the element the absorption helper returns
    // (`frame/legacy-surfaces.test.ts`).
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").toContain("running on the fixture");
  });
});

describe("agent console — the definition editor's seat", () => {
  it("states the absence rather than drawing an empty region", () => {
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").toContain("definition editor has not been built here yet");
  });

  it("names no governance work anywhere a person can read", () => {
    // The slot's contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("negative control: the pane does render text that could have carried one", () => {
    // Without this, the case above would pass over a pane that rendered nothing at
    // all, which is the failure it is meant to exclude.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect((container.textContent ?? "").length).toBeGreaterThan(80);
  });
});

describe("agent console — asking the daemon again for the peer-invocation grant", () => {
  it("makes a served grant appear, which is what the offered recovery promises", async () => {
    // The shipped session read carries no `peerInvocationEnabled`, so the control
    // opens unknown. Pressing its recovery has to ASK: a re-derivation over the
    // same synchronous snapshot would answer unknown forever.
    const bridge = bridgeReading(growthServing(snapshotEnablingPeerInvocation()));
    const sessionStore = projectingStore();
    const { container } = render(
      <AgentConsolePane
        sessionId={SESSION_ID}
        agentId={AGENT_ID}
        bridgeSource="fixture"
        bridge={bridge}
        sessionStore={sessionStore}
      />,
    );
    await settle(bridge);
    expect(container.textContent ?? "").toContain("did not report");

    const reRead = container.querySelector(".meridian-peer__action");
    expect(reRead).not.toBeNull();
    await act(async () => {
      fireEvent.click(reRead as HTMLElement);
    });
    await settle(bridge);

    expect(container.querySelector(".meridian-peer__switch")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("did not report");
  });

  it("negative control: without the press the grant never appears", async () => {
    // Without this, the case above would pass over a pane that read the projection
    // on mount — and the press would be proving nothing.
    const bridge = bridgeReading(growthServing(snapshotEnablingPeerInvocation()));
    const { container } = render(
      <AgentConsolePane
        sessionId={SESSION_ID}
        agentId={AGENT_ID}
        bridgeSource="fixture"
        bridge={bridge}
        sessionStore={projectingStore()}
      />,
    );
    await settle(bridge);
    await settle(bridge);

    expect(container.querySelector(".meridian-peer__switch")).toBeNull();
    expect(container.textContent ?? "").toContain("did not report");
  });

  it("renders the port's own refusal when the re-read is refused", async () => {
    const bridge = bridgeReading(growthRefusing("sessionRead"));
    const { container } = render(
      <AgentConsolePane
        sessionId={SESSION_ID}
        agentId={AGENT_ID}
        bridgeSource="fixture"
        bridge={bridge}
        sessionStore={projectingStore()}
      />,
    );
    await settle(bridge);
    await act(async () => {
      fireEvent.click(container.querySelector(".meridian-peer__action") as HTMLElement);
    });
    await settle(bridge);

    expect(container.textContent ?? "").toContain("wire-unregistered");
    expect(container.querySelector(".meridian-peer__switch")).toBeNull();
  });

  it("says nothing was asked when the pane holds no session to read through", async () => {
    // A press that did nothing at all would read exactly like a read that came
    // back with the same answer, and only one of those is a fact about a daemon.
    const { container } = render(
      <AgentConsolePane sessionId={undefined} agentId={AGENT_ID} bridgeSource="fixture" />,
    );
    await act(async () => {
      fireEvent.click(container.querySelector(".meridian-peer__action") as HTMLElement);
    });

    expect(container.textContent ?? "").toContain("was not handed a session");
  });
});
