// The refused position reaches a screen, driven through the surface that mounts it.
//
// THE DEFECT THIS SUITE IS THE CONTROL FOR, IN BOTH DIRECTIONS. `timelineResumeFor`
// had zero callers outside its own declaration once — the decision was computed on
// every read, kept on the entry, forwarded by the registry, and rendered by nothing —
// and the surface that closed that gap then rendered the WRONG arm: it reported a
// version skew on every read from every responder, because the rule it consulted
// required a cursor member the shipped schema forbids. So this suite drives the
// REGISTERED workspace surface, and the arm it asserts on is a refusal the daemon
// actually raised about a position this console actually sent.
//
// EVERYTHING BELOW THE SURFACE IS REAL: a real `SessionStoreRegistry` opening a real
// entry, whose real scheduler performs real reads, the second of which carries the
// position the first acknowledged. The only stand-in is the workspace BODY, which is
// the composition root's parameter and is another family's component entirely.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { settleReactWork } from "../core/act-settlement.test-support.js";
import { ConsolePaneRegistry, ConsoleSurfaceRegistry } from "../seats/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import { SessionStoreRegistry, type SessionSnapshot } from "../store/index.js";
import { registerLedger } from "./index.js";

const SESSION_ID = "session-resume-degraded";

/** The code the banner renders verbatim. This module's own, never the daemon's. */
const REFUSAL_CODE = "resume-cursor-unresolvable";

/** The position the first read acknowledges, and the second read submits. */
const ACKNOWLEDGED = "7_1723291480000000000";

afterEach(() => {
  cleanup();
});

/** A snapshot at `cursor`, acknowledged where one is supplied. */
function snapshotAt(cursor: number, acknowledged?: string): SessionSnapshot {
  return {
    cursor,
    entities: [],
    participantJoinLog: [],
    timelineCursors: {
      latest: "9_1723291500000000000",
      ...(acknowledged === undefined ? {} : { acknowledged }),
    },
  };
}

/**
 * Render the registered `workspace` surface over a registry whose reads follow a
 * script, and refresh it `refreshes` times.
 *
 * The surface is resolved from a registry composed HERE rather than the process-wide
 * one, on `ledger.test.ts`' reasoning: a case that registered into the singleton would
 * be asserting over a board production also fills.
 */
async function renderWorkspaceSurface(input: {
  readonly reads: readonly (SessionSnapshot | { readonly rejectWith: unknown })[];
  readonly refreshes: number;
}): Promise<void> {
  // A manual clock, because the scheduler debounces every request against one: the
  // reads have to have COMPLETED before the render, or every arm renders the interval
  // before a decision exists and the negative controls pass on nothing.
  const clock = new ManualClock(0);
  let readIndex = 0;
  const sessionStoreRegistry = new SessionStoreRegistry({
    clock,
    refreshDebounceMs: 20,
    read: () => {
      const step = input.reads[Math.min(readIndex, input.reads.length - 1)];
      readIndex += 1;
      if (step !== undefined && "rejectWith" in step) {
        return Promise.reject(step.rejectWith);
      }
      return Promise.resolve(step);
    },
  });
  const sessionStore = sessionStoreRegistry.open(SESSION_ID);
  const surfaces = new ConsoleSurfaceRegistry();
  registerLedger(surfaces, { workspace: () => <div data-testid="workspace-body" /> });
  const descriptor = surfaces.descriptorFor("workspace");
  if (descriptor === undefined) {
    throw new Error("the ledger family registered no workspace surface");
  }

  for (let turn = 0; turn < input.refreshes; turn += 1) {
    sessionStoreRegistry.requestRefresh(SESSION_ID, "window-focus");
    clock.advance(21);
    await settleReactWork();
  }

  render(
    <>
      {descriptor.render({
        route: { kind: "workspace", sessionId: SESSION_ID },
        bridge: { source: "fixture" },
        frameStore: {},
        sessionStore,
        sessionStoreRegistry,
        uiStateStore: {},
        draftStore: {},
        paneRegistry: new ConsolePaneRegistry(),
      } as unknown as ConsoleSurfaceContext)}
    </>,
  );
  await settleReactWork();
}

/** The read that refuses the position the previous read acknowledged. */
const REFUSES_THE_POSITION = {
  rejectWith: {
    code: "event.cursor_unresolvable",
    message: "the submitted cursor could not be decoded",
  },
};

describe("the workspace surface renders the refused resume position", () => {
  it("says the remembered position could not be resumed", async () => {
    await renderWorkspaceSurface({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByText(REFUSAL_CODE)).toBeTruthy();
    expect(screen.getByText(/re-read from the beginning/u)).toBeTruthy();
  });

  it("reaches the screen even though the recovering read establishes nothing", async () => {
    // The reason the decision carries its own notification. The recovery answers at
    // the beginning of the window, which `admitsSnapshotAt` refuses for arriving
    // behind the store's cursor — so no store transition happens and a surface
    // subscribed to the projection's revision alone would render nothing at all.
    await renderWorkspaceSurface({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByText(REFUSAL_CODE)).toBeTruthy();
  });

  it("negative control: an honoured position renders no notice at all", async () => {
    // Without this, a surface that rendered the sentence unconditionally would pass
    // both cases above — and would tell every session its position was lost.
    await renderWorkspaceSurface({
      reads: [snapshotAt(7, ACKNOWLEDGED), snapshotAt(9, "9_1723291500000000000")],
      refreshes: 2,
    });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });

  it("negative control: a first read that acknowledges nothing renders no notice", async () => {
    // The arm the retired rule refused on: nothing acknowledged is the ordinary first
    // read, not a failure, and it is what every scripted scenario answers with. A
    // surface that treated it as a refusal put a band above every workspace.
    await renderWorkspaceSurface({ reads: [snapshotAt(0)], refreshes: 1 });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });

  it("negative control: the workspace body mounts on both arms", async () => {
    // The notice renders ABOVE the room and never in place of it. Without this, a
    // surface that replaced the workspace with the refusal would satisfy the first
    // case while reporting an outage the daemon is not having.
    await renderWorkspaceSurface({
      reads: [snapshotAt(7, ACKNOWLEDGED), REFUSES_THE_POSITION, snapshotAt(0)],
      refreshes: 2,
    });

    expect(screen.getByTestId("workspace-body")).toBeTruthy();
  });

  it("clears once a later read settles a position of its own", async () => {
    // Not a permanent band. The decision is the newest completed read's, so the next
    // ordinary refresh replaces the refusal and this renders nothing.
    await renderWorkspaceSurface({
      reads: [
        snapshotAt(7, ACKNOWLEDGED),
        REFUSES_THE_POSITION,
        snapshotAt(0),
        snapshotAt(11, "11_1723291600000000000"),
      ],
      refreshes: 3,
    });

    expect(screen.queryByText(REFUSAL_CODE)).toBeNull();
  });
});
