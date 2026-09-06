// The refusal reaches a screen, driven through the surface that mounts it.
//
// THE DEFECT THIS SUITE IS THE CONTROL FOR. `timelineResumeFor` had zero callers
// anywhere outside its own declaration: the decision was computed on every read, kept
// on the entry, forwarded by the registry, and rendered by nothing. `knip` does not
// report unused class METHODS, so every gate was green while the version-skew refusal
// was unreachable. So this suite renders through the REGISTERED workspace surface
// rather than the component alone — a component test would have passed on the day the
// defect existed.
//
// EVERYTHING BELOW THE SURFACE IS REAL: a real `SessionStoreRegistry` opening a real
// entry, whose real scheduler performs a real read, whose cursor block is what the
// resume rule is decided from. The only stand-in is the workspace BODY, which is the
// composition root's parameter and is another family's component entirely.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { settleReactWork } from "../core/act-settlement.test-support.js";
import { ConsolePaneRegistry, ConsoleSurfaceRegistry } from "../seats/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import { SessionStoreRegistry, type SessionSnapshot } from "../store/index.js";
import { registerLedger } from "./index.js";

const SESSION_ID = "session-resume-absence";

/** What the refused arm puts on screen. The title, verbatim, and nothing derived. */
const REFUSAL_TITLE = "This session's stream will not resume where it left off.";

afterEach(() => {
  cleanup();
});

/** A read that answers once with the cursor block a case is about. */
function snapshotWith(timelineCursors: SessionSnapshot["timelineCursors"]): SessionSnapshot {
  return { cursor: 0, entities: [], participantJoinLog: [], timelineCursors };
}

/**
 * Render the registered `workspace` surface over a registry reading that block.
 *
 * The surface is resolved from a registry composed HERE rather than the process-wide
 * one, on `ledger.test.ts`' reasoning: a case that registered into the singleton would
 * be asserting over a board production also fills.
 */
async function renderWorkspaceSurface(
  timelineCursors: SessionSnapshot["timelineCursors"],
): Promise<SessionStoreRegistry> {
  // A manual clock, because the scheduler debounces every request against one: the
  // read has to have COMPLETED before the render, or every arm renders the interval
  // before a decision exists and the negative controls pass on nothing.
  const clock = new ManualClock(0);
  const sessionStoreRegistry = new SessionStoreRegistry({
    clock,
    refreshDebounceMs: 20,
    read: () => Promise.resolve(snapshotWith(timelineCursors)),
  });
  const sessionStore = sessionStoreRegistry.open(SESSION_ID);
  const surfaces = new ConsoleSurfaceRegistry();
  registerLedger(surfaces, { workspace: () => <div data-testid="workspace-body" /> });
  const descriptor = surfaces.descriptorFor("workspace");
  if (descriptor === undefined) {
    throw new Error("the ledger family registered no workspace surface");
  }

  // The read is what produces a decision, so it is requested before the render: a
  // surface asserted against an entry that has performed none would be asserting that
  // nothing renders yet, which every arm satisfies.
  sessionStoreRegistry.requestRefresh(SESSION_ID, "window-focus");
  clock.advance(21);
  await settleReactWork();

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
  return sessionStoreRegistry;
}

describe("the workspace surface renders the resume refusal", () => {
  it("says the stream will not resume when the read carries no floor", async () => {
    // The version-skew arm: a responder that predates the member the resume rule is
    // stated on. Before this suite the console knew this and said nothing.
    await renderWorkspaceSurface({ latest: "9_1723291500000000000" });

    expect(screen.getByText(REFUSAL_TITLE)).toBeTruthy();
  });

  it("carries the refusal's own sentence rather than a console paraphrase", async () => {
    // The detail is the refusal's, so what a person reads names the responder's skew
    // rather than a second sentence this surface wrote about it.
    await renderWorkspaceSurface({ latest: "9_1723291500000000000" });

    expect(screen.getByText(/predates the read surface/u)).toBeTruthy();
  });

  it("negative control: a complete cursor block renders no absence at all", async () => {
    // Without this, a surface that rendered the sentence unconditionally would pass
    // both cases above — and would tell every session it cannot resume.
    await renderWorkspaceSurface({
      earliest: "-1_1723291400000000000",
      latest: "9_1723291500000000000",
      acknowledged: "7_1723291480000000000",
    });

    expect(screen.queryByText(REFUSAL_TITLE)).toBeNull();
  });

  it("negative control: the workspace body mounts on both arms", async () => {
    // The absence renders ABOVE the room and never in place of it. Without this, a
    // surface that replaced the workspace with the refusal would satisfy the first
    // case while reporting an outage the daemon is not having.
    await renderWorkspaceSurface({ latest: "9_1723291500000000000" });

    expect(screen.getByTestId("workspace-body")).toBeTruthy();
  });
});
