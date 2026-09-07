// The captures this window took, and the bound on how many keep a card.
//
// The register is what makes a produced-object row a CARD rather than an identity row,
// so the property under test is that a card appears only for a capture that actually
// answered — and that a retake replaces its predecessor's card rather than sitting
// beside it, because one artifact id is one object and the shelf renders one row per
// object.
//
// THE SERVED ARM IS DRIVEN THROUGH THE REAL OPERATION'S REGISTERED SIGNATURE. The
// growth port refuses `browserCapture` by name today, so a case that only drove the
// fixture could assert nothing about what a capture BECOMES; the bridge below answers
// the shape the signature declares, and the refusing arm is driven through the real
// port beside it.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { useBrowserPaneActs } from "../pane/act-sequence.js";
import { useCapturedObjects, type CapturedObjects } from "./captured-objects.js";

const PANE_ID = "pane-browser-1";

/** A bridge whose capture answers, handing back a fresh artifact id each time. */
function capturingBridge(artifactIds: readonly string[]): ConsoleBridge {
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  let nextIndex = 0;
  return {
    ...base,
    growth: {
      ...base.growth,
      browserCapture: async () => {
        const artifactId = artifactIds[Math.min(nextIndex, artifactIds.length - 1)] ?? "artifact-a";
        nextIndex += 1;
        return {
          status: "served" as const,
          value: { artifactId, mediaType: "image/png", byteLength: 4096 },
        };
      },
    },
  };
}

interface CaptureHarness {
  readonly capture: () => Promise<void>;
  readonly read: () => CapturedObjects;
  readonly refusalCode: () => string | undefined;
}

function mountCaptures(bridge: ConsoleBridge): CaptureHarness {
  const { result } = renderHook(() => {
    const paneActs = useBrowserPaneActs(bridge, PANE_ID);
    return { paneActs, captured: useCapturedObjects(bridge, PANE_ID, paneActs) };
  });
  return {
    capture: async () => {
      await act(async () => {
        result.current.captured.capture();
        // The act sequence answers on a chain this case does not own, so the wait is
        // the boundary rather than a count of turns tuned against its current depth.
        await crossMacrotaskBoundary();
      });
    },
    read: () => result.current.captured,
    refusalCode: () => result.current.paneActs.refusal?.code,
  };
}

describe("the captures this pane took", () => {
  it("starts with no cards, because this window has produced nothing", () => {
    const harness = mountCaptures(createFixtureBridge({ scenario: BROWSER_SCENARIO }));
    expect(harness.read().cardsByArtifactId.size).toBe(0);
  });

  it("keeps a card for a capture that answered, keyed by the artifact it became", async () => {
    const harness = mountCaptures(capturingBridge(["artifact-a"]));
    await harness.capture();
    const card = harness.read().cardsByArtifactId.get("artifact-a");
    expect(card?.kind).toBe("capture");
    expect(card?.kind === "capture" ? card.props.mediaType : undefined).toBe("image/png");
  });

  it("replaces a retaken capture's card rather than holding two for one artifact", async () => {
    const harness = mountCaptures(capturingBridge(["artifact-a", "artifact-a"]));
    await harness.capture();
    await harness.capture();
    expect(harness.read().cardsByArtifactId.size).toBe(1);
  });

  it("holds a card per artifact where two captures became two artifacts", async () => {
    const harness = mountCaptures(capturingBridge(["artifact-a", "artifact-b"]));
    await harness.capture();
    await harness.capture();
    expect([...harness.read().cardsByArtifactId.keys()].sort()).toEqual([
      "artifact-a",
      "artifact-b",
    ]);
  });

  it("negative control: a refused capture becomes no card at all", async () => {
    const harness = mountCaptures(createFixtureBridge({ scenario: BROWSER_SCENARIO }));
    await harness.capture();
    expect(harness.read().cardsByArtifactId.size).toBe(0);
    // And it says so through the pane's one refusal, rather than silently.
    expect(harness.refusalCode()).toBeDefined();
  });
});
