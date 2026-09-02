// The agent console says which agent it is about, or says it does not know.
//
// One body mounted twice — by the deck as a pane and by the frame as an auxiliary
// window — so the cases drive the COMPONENT rather than either mount, and the two
// registrars are covered where they are composed. What is checked here is the pair
// of absences a mount cannot rule out: an address that named a session and no
// agent, and a definition editor whose body belongs to another plan.
//
// Every case mounts against a REAL fixture bridge rather than a cast literal. The
// machines column hands the absorbed roster the reads that bridge serves, so a cast
// bridge would be a column reading `undefined` as a function — and the column's own
// case below is exactly the one that would not notice.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentConsolePane } from "./AgentConsolePane.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import { AgentConsoleModels } from "../../agents/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../bridge/scenarios/settings.js";
import { consoleTripwires } from "../../core/index.js";
import { SurfaceErrorBoundary } from "../../frame/ErrorBoundary.js";
import { RUN_LIFECYCLE_PROJECTORS } from "../../frame/run-lifecycle-projector.js";
import { SessionStore, type SessionSnapshot } from "../../store/index.js";

/** The tick this scenario's two machines are both attached at. */
const BOTH_MACHINES_ONLINE_MS = 200;

/** The session the fixture plays, so the roster read is answered rather than refused. */
const PLAYED_SESSION_ID = SETTINGS_SCENARIO.sessionId;

function fixtureBridge(): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(BOTH_MACHINES_ONLINE_MS);
  return bridge;
}

/**
 * Mount the pane and let its machines column settle.
 *
 * The roster reads on mount, so a case that asserted before it settled would leave
 * a state update landing outside `act` — a warning rather than the failure it
 * usually is, and one that would make every case here quietly unreliable.
 */
async function renderPane(agentId: string | undefined): Promise<HTMLElement> {
  const { container } = render(
    <AgentConsolePane sessionId={PLAYED_SESSION_ID} agentId={agentId} bridge={fixtureBridge()} />,
  );
  await screen.findByLabelText("node-roster-loaded");
  return container;
}

describe("agent console — the agent it is about", () => {
  it("renders the agent id as a wire figure, verbatim", async () => {
    // A wire string wears the provenance signature. Rendered as prose it would be
    // indistinguishable from a name the console composed.
    const container = await renderPane("agent-scout");
    const figure = container.querySelector(".meridian-figure--wire");
    expect(figure?.textContent).toBe("agent-scout");
  });

  it("says so when the address named a session and no agent", async () => {
    // Reachable: the frame's context picker resolves a bare auxiliary address by
    // choosing a session, and the agent-console grammar carries its agent with its
    // session — so a picked session arrives here with no agent named.
    const container = await renderPane(undefined);
    expect(container.textContent ?? "").toContain("not yet on one of its agents");
  });

  it("negative control: the subject line is not the same in both cases", async () => {
    // Without this, the two cases above would pass over a pane that rendered one
    // fixed sentence and never the id.
    const container = await renderPane("agent-scout");
    expect(container.textContent ?? "").not.toContain("not yet on one of its agents");
  });
});

describe("agent console — the machines column", () => {
  it("renders the roster the pane's own bridge serves", async () => {
    // Under the fixture this column used to say the question was not put. It asks
    // now, through the bridge this mount already holds, and both health axes render
    // side by side because the absorbed view was kept rather than rewritten.
    await renderPane("agent-scout");

    const roster = screen.getByLabelText("node-roster-loaded");
    expect(roster.querySelectorAll("li")).toHaveLength(2);
    expect(
      roster.querySelector('li[data-node-state="online"][data-health-state="degraded"]'),
    ).not.toBeNull();
  });

  it("says nothing was asked when the mount resolved no bridge", async () => {
    // The negative control for the case above, and a reachable state: this pane
    // types its bridge as possibly absent because a mount may resolve none.
    const { container } = render(
      <AgentConsolePane sessionId={PLAYED_SESSION_ID} agentId="agent-scout" bridge={undefined} />,
    );

    expect(screen.queryByLabelText("node-roster-loaded")).toBeNull();
    expect(container.textContent ?? "").toContain("not handed a bridge");
  });
});

describe("agent console — the definition editor's seat", () => {
  it("states the absence rather than drawing an empty region", async () => {
    const container = await renderPane("agent-scout");
    expect(container.textContent ?? "").toContain("definition editor has not been built here yet");
  });

  it("names no governance work anywhere a person can read", async () => {
    // The slot's contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const container = await renderPane("agent-scout");
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("negative control: the pane does render text that could have carried one", async () => {
    // Without this, the case above would pass over a pane that rendered nothing at
    // all, which is the failure it is meant to exclude.
    const container = await renderPane("agent-scout");
    expect((container.textContent ?? "").length).toBeGreaterThan(80);
  });
});

// --- The peers-and-linkage column ---------------------------------------------
//
// Both cases below drive a store this file owns rather than the played scenario's,
// because what they are about is a projection ARRIVING after the mount: the grant
// a re-read fetches, and the run a beat projects. A scenario that already carried
// both would assert nothing about either.

const OWNED_SESSION_ID = "session-9";
const OWNED_AGENT_ID = "agent-scout";

/** The real fixture bridge with the one growth operation this pane re-reads replaced. */
function bridgeReading(sessionRead: ConsoleBridge["growth"]["sessionRead"]): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("agent-console-pane"), { sessionRead });
}

/** A session read that reports the grant, which the shipped reply does not carry. */
function snapshotEnablingPeerInvocation(): SessionSnapshot {
  return {
    cursor: 4,
    entities: [{ kind: "session", id: OWNED_SESSION_ID, body: { peerInvocationEnabled: true } }],
    participantJoinLog: [],
  };
}

/** A store with the window's own projectors, so a run beat projects a run row. */
function projectingStore(): SessionStore {
  const sessionStore = new SessionStore({
    sessionId: OWNED_SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** Let the mount's effects, the frozen clock, and every settled reply land. */
async function settleReads(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(500);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
}

/** Mount the pane over a store and a bridge this file owns. */
function renderOwnedPane(bridge: ConsoleBridge, sessionStore?: SessionStore): HTMLElement {
  const { container } = render(
    <AgentConsolePane
      sessionId={OWNED_SESSION_ID}
      agentId={OWNED_AGENT_ID}
      bridge={bridge}
      sessionStore={sessionStore}
    />,
  );
  return container;
}

describe("agent console — asking the daemon again for the peer-invocation grant", () => {
  it("makes a served grant appear, which is what the offered recovery promises", async () => {
    // The shipped session read carries no `peerInvocationEnabled`, so the control
    // opens unknown. Pressing its recovery has to ASK: a re-derivation over the
    // same synchronous snapshot would answer unknown forever.
    const bridge = bridgeReading(growthServing(snapshotEnablingPeerInvocation()));
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
    const bridge = bridgeReading(growthServing(snapshotEnablingPeerInvocation()));
    const container = renderOwnedPane(bridge, projectingStore());
    await settleReads(bridge);
    await settleReads(bridge);

    expect(container.querySelector(".meridian-peer__switch")).toBeNull();
    expect(container.textContent ?? "").toContain("did not report");
  });

  it("renders the port's own refusal when the re-read is refused", async () => {
    const bridge = bridgeReading(growthRefusing("sessionRead"));
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
    const bridge = bridgeReading(growthRefusing("sessionRead"));
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
    const bridge = bridgeReading(growthRefusing("sessionRead"));
    const sessionStore = projectingStore();
    const container = renderOwnedPane(bridge, sessionStore);
    await settleReads(bridge);
    expect(container.textContent ?? "").toContain("No run of this agent is on the timeline yet");

    await act(async () => {
      sessionStore.apply({
        sessionId: OWNED_SESSION_ID,
        sequence: 1,
        kind: "run.queued",
        occurredAt: "2026-01-01T10:06:00.000Z",
        payload: { runId: "run-7", newState: "queued", agentId: OWNED_AGENT_ID },
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
    const bridge = bridgeReading(growthRefusing("sessionRead"));
    const sessionStore = projectingStore();
    const container = renderOwnedPane(bridge, sessionStore);
    await settleReads(bridge);

    await act(async () => {
      sessionStore.apply({
        sessionId: OWNED_SESSION_ID,
        sequence: 1,
        kind: "run.queued",
        occurredAt: "2026-01-01T10:06:00.000Z",
        payload: { runId: "run-8", newState: "queued", agentId: "agent-other" },
      });
    });

    expect(container.textContent ?? "").toContain("No run of this agent is on the timeline yet");
  });
});

// --- The linkage read's lifetime ----------------------------------------------
//
// Acquiring a linkage read opens a subscription and arms a scheduler, so it happens
// in a mount effect and never in a render body. What that buys is only visible in
// counts: how many reads one mount starts, whether re-keying the run leaves the
// previous read listening, and whether an unmounted pane can still be woken by a
// session event. Every case below counts the child-link calls the pane's own bridge
// received, per parent run.

/** The child-link method this column reads, so the counter matches nothing else. */
const CHILD_RUN_LINK_METHOD = "orchestration.childRunLinkRead";

/** A fixture bridge whose child-link reads are counted by the run they asked about. */
interface LinkageCountingBridge {
  readonly bridge: ConsoleBridge;
  /** Reads performed for one parent run. The lifetime instrument. */
  readonly readsFor: (parentRunId: string) => number;
}

function linkageCountingBridge(): LinkageCountingBridge {
  const fixture = bridgeReading(growthRefusing("sessionRead"));
  const readsByParentRunId = new Map<string, number>();
  const call = fixture.sidekicks.daemon.call as unknown as (
    method: string,
    params: { readonly parentRunId?: string },
  ) => Promise<unknown>;
  const counted = (method: string, params: { readonly parentRunId?: string }): Promise<unknown> => {
    const parentRunId = params?.parentRunId;
    if (method === CHILD_RUN_LINK_METHOD && parentRunId !== undefined) {
      readsByParentRunId.set(parentRunId, (readsByParentRunId.get(parentRunId) ?? 0) + 1);
    }
    return call(method, params);
  };
  return {
    bridge: {
      ...fixture,
      sidekicks: {
        ...fixture.sidekicks,
        daemon: {
          ...fixture.sidekicks.daemon,
          call: counted as unknown as ConsoleBridge["sidekicks"]["daemon"]["call"],
        },
      },
    },
    readsFor: (parentRunId) => readsByParentRunId.get(parentRunId) ?? 0,
  };
}

/** Project one run of this pane's agent, so the linkage has a run to be keyed by. */
async function projectRun(
  sessionStore: SessionStore,
  runId: string,
  sequence: number,
  occurredAt: string,
): Promise<void> {
  await act(async () => {
    sessionStore.apply({
      sessionId: OWNED_SESSION_ID,
      sequence,
      kind: "run.queued",
      occurredAt,
      payload: { runId, newState: "queued", agentId: OWNED_AGENT_ID },
    });
  });
}

/** A store that already holds one run of this agent, so the FIRST render is keyed. */
function storeHoldingRun(runId: string): SessionStore {
  const sessionStore = projectingStore();
  sessionStore.initialise({
    cursor: 1,
    entities: [
      {
        kind: "run",
        id: runId,
        touchedAt: "2026-01-01T10:06:00.000Z",
        body: { agentId: OWNED_AGENT_ID },
      },
    ],
    participantJoinLog: [],
  });
  return sessionStore;
}

/**
 * The shape this finding replaced: the linkage taken and started during a render.
 *
 * The negative control for the discarded-pass case, so the counter is shown to
 * REPORT a leak when there is one — without it that case would also pass over a
 * pane that started no read at all.
 */
function RenderTimeLinkageProbe(props: {
  readonly models: AgentConsoleModels;
  readonly parentRunId: string;
}): React.JSX.Element {
  props.models.acquireLinkage(props.parentRunId).read.start();
  throw new Error("this column could not render");
}

describe("agent console — the linkage read's lifetime", () => {
  it("starts exactly one read for the run the pane is keyed by", async () => {
    const counted = linkageCountingBridge();
    const sessionStore = projectingStore();
    renderOwnedPane(counted.bridge, sessionStore);
    await settleReads(counted.bridge);
    await projectRun(sessionStore, "run-7", 1, "2026-01-01T10:06:00.000Z");
    await settleReads(counted.bridge);

    expect(counted.readsFor("run-7")).toBe(1);
  });

  it("stops reading for the previous run once a newer one is keyed", async () => {
    const counted = linkageCountingBridge();
    const sessionStore = projectingStore();
    renderOwnedPane(counted.bridge, sessionStore);
    await settleReads(counted.bridge);
    await projectRun(sessionStore, "run-7", 1, "2026-01-01T10:06:00.000Z");
    await settleReads(counted.bridge);
    const readsForFirstRun = counted.readsFor("run-7");

    await projectRun(sessionStore, "run-9", 2, "2026-01-01T10:07:00.000Z");
    await settleReads(counted.bridge);
    // A refusal on the session stream is exactly what a live linkage re-reads for,
    // so it is the event that would wake a read the re-key should have disposed.
    await act(async () => {
      sessionStore.apply({
        sessionId: OWNED_SESSION_ID,
        sequence: 3,
        kind: "orchestration.rejected",
        occurredAt: "2026-01-01T10:08:00.000Z",
        payload: {},
      });
    });
    await settleReads(counted.bridge);

    expect(counted.readsFor("run-9")).toBeGreaterThan(0);
    expect(counted.readsFor("run-7")).toBe(readsForFirstRun);
  });

  it("reads nothing more once the pane has unmounted", async () => {
    const counted = linkageCountingBridge();
    const sessionStore = projectingStore();
    const view = render(
      <AgentConsolePane
        sessionId={OWNED_SESSION_ID}
        agentId={OWNED_AGENT_ID}
        bridge={counted.bridge}
        sessionStore={sessionStore}
      />,
    );
    await settleReads(counted.bridge);
    await projectRun(sessionStore, "run-7", 1, "2026-01-01T10:06:00.000Z");
    await settleReads(counted.bridge);
    const readsBeforeUnmount = counted.readsFor("run-7");

    view.unmount();
    await projectRun(sessionStore, "run-7", 2, "2026-01-01T10:07:00.000Z");
    await settleReads(counted.bridge);

    expect(counted.readsFor("run-7")).toBe(readsBeforeUnmount);
  });

  it("negative control: taking the read from a render body leaves one reading behind", async () => {
    const counted = linkageCountingBridge();
    const models = new AgentConsoleModels(counted.bridge, storeHoldingRun("run-7"));
    const restoreThrowOnReport = import.meta.env.DEV;
    consoleTripwires.setThrowOnReport(false);
    consoleTripwires.reset();

    render(
      <SurfaceErrorBoundary surfaceName="The linkage column">
        <RenderTimeLinkageProbe models={models} parentRunId="run-7" />
      </SurfaceErrorBoundary>,
    );
    await settleReads(counted.bridge);

    // The pass that took it never committed, so no cleanup exists to release the
    // read — and it went on refreshing regardless. This is what the counter above
    // has to be able to see, and it is the whole reason the acquisition moved into
    // an effect: the pane's own three cases would pass over a pane that started
    // nothing at all.
    expect(counted.readsFor("run-7")).toBeGreaterThan(0);
    expect(models.heldLinkageParentRunId).toBe("run-7");

    models.dispose();
    consoleTripwires.setThrowOnReport(restoreThrowOnReport);
    consoleTripwires.reset();
  });
});
