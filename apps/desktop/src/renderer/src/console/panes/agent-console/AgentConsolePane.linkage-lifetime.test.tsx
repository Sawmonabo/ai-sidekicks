// How long one linkage read lives, counted rather than inferred.
//
// Acquiring a linkage read opens a subscription and arms a scheduler, so it happens
// in a mount effect and never in a render body. What that buys is only visible in
// counts: how many reads one mount starts, whether re-keying the run leaves the
// previous read listening, and whether an unmounted pane can still be woken by a
// session event. Every case below counts the child-link calls the pane's own bridge
// received, per parent run.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentConsoleModels } from "../../agents/index.js";
import { growthRefusing } from "../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { consoleTripwires } from "../../core/tripwires.js";
import { SurfaceErrorBoundary } from "../../frame/ErrorBoundary.js";
import { SessionStore } from "../../store/index.js";
import {
  OWNED_AGENT_ID,
  projectingStore,
  renderOwnedPane,
} from "./agent-console-pane.test-support.js";
import {
  PROJECTION_SESSION_ID,
  bridgeReadingProjection,
  settleReads,
} from "./agent-console.test-support.js";
import { AgentConsolePane } from "./AgentConsolePane.js";

/** A fixture bridge whose child-link reads are counted by the run they asked about. */
interface LinkageCountingBridge {
  readonly bridge: ConsoleBridge;
  /** Reads performed for one parent run. The lifetime instrument. */
  readonly readsFor: (parentRunId: string) => number;
}

/**
 * The counter sits on the GROWTH port, because that is where the read goes.
 *
 * `orchestration.childRunLinkRead` has no registered request/response pair anywhere
 * in the corpus, so the column reaches it as `bridge.growth.orchestrationChildRunLinkRead`
 * rather than through the call door. Counting the daemon's call arm would count a
 * call nobody makes and report zero for every case here — which is the shape of the
 * failure, not of a passing lifetime claim.
 *
 * The answer is the EMPTY reading rather than a refusal: what these cases measure is
 * how many reads a mount starts and whose, and a refused read is still a read that
 * was started. An empty one keeps the panel's rendering out of the way of the count.
 */
function linkageCountingBridge(): LinkageCountingBridge {
  const readsByParentRunId = new Map<string, number>();
  const bridge = bridgeReadingProjection(growthRefusing("sessionRead"), {
    orchestrationChildRunLinkRead: async (request) => {
      const { parentRunId } = request;
      readsByParentRunId.set(parentRunId, (readsByParentRunId.get(parentRunId) ?? 0) + 1);
      return { status: "served", value: { links: [], rejectedCreates: [] } };
    },
  });
  return { bridge, readsFor: (parentRunId) => readsByParentRunId.get(parentRunId) ?? 0 };
}

/**
 * Project one run of this pane's agent, so the linkage has a run to be keyed by.
 *
 * The payload names the session as well as the run: `sessionId` is a registered
 * member of the durable `run_lifecycle` row, and the fold refuses a beat that omits
 * it rather than writing another session's run into this store's partition.
 */
async function projectRun(
  sessionStore: SessionStore,
  runId: string,
  sequence: number,
  occurredAt: string,
): Promise<void> {
  await act(async () => {
    sessionStore.apply({
      id: `event-${String(sequence)}`,
      sessionId: PROJECTION_SESSION_ID,
      sequence,
      kind: "run.queued",
      occurredAt,
      payload: {
        sessionId: PROJECTION_SESSION_ID,
        runId,
        newState: "queued",
        agentId: OWNED_AGENT_ID,
      },
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
        id: "event-3",
        sessionId: PROJECTION_SESSION_ID,
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
        sessionId={PROJECTION_SESSION_ID}
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
