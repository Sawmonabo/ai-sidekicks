// Where the shelf's provenance comes from, and every producer it has to cover.
//
// The defect these cases pin: the shelf's allowed-id set was the pane's own CARD
// register, which holds one entry per capture this window took through the pane's
// Capture control. Everything else the browser produces — an agent's capture, a
// completed download, a bundled asset set, a capture started from the composer's
// attach row, and anything at all produced before the pane remounted — is absent from
// that register by construction, so valid `artifact.*` beats were dropped and the
// shelf reported that nothing had been produced.
//
// So the cases below drive the ledger the daemon answers and the register this window
// keeps, together, through the real fixture bridge — the same bridge and the same
// scenario the pane runs against.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../../bridge/index.js";
import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import type { ProducedObjectCard } from "./produced-objects.js";
import { joinProducedObjects, useBrowserProducedObjects } from "./produced-provenance.js";

/** The four objects `BROWSER_SCENARIO` says its browser produced. */
const AGENT_CAPTURE_ID = "artifact-capture-staging-header";
const RETAKEN_CAPTURE_ID = "artifact-capture-staging-header-retake";
const DOWNLOAD_ID = "artifact-download-release-notes";
const ASSET_BUNDLE_ID = "artifact-bundle-staging-assets";

/** An object some other surface published into the same session. */
const ATTACHMENT_ID = "artifact-repo-attachment";

/** The card the pane's own capture act mints, keyed by the artifact it became. */
function captureCard(artifactId: string): ProducedObjectCard {
  return {
    kind: "capture",
    props: {
      artifactId,
      scope: "viewport",
      mediaType: "image/png",
      ingest: { status: "stored", artifactId, byteLength: 4096 },
    },
  };
}

/** A bridge whose provenance read refuses, which is what a release build does. */
function refusingProvenanceBridge(): ConsoleBridge {
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      browserProducedArtifacts: async () => growthUnavailable("browserProducedArtifacts"),
    },
  };
}

async function mountedLedger(
  bridge: ConsoleBridge,
  locallyProduced: ReadonlyMap<string, ProducedObjectCard> = new Map(),
): Promise<ReadonlyMap<string, ProducedObjectCard>> {
  const { result } = renderHook(() =>
    useBrowserProducedObjects(bridge, BROWSER_SCENARIO.sessionId, locallyProduced),
  );
  await waitFor(() => {
    expect(result.current.size).toBeGreaterThan(locallyProduced.size);
  });
  return result.current;
}

describe("the browser's produced-object provenance", () => {
  it("covers every producer the daemon names, not only this window's own captures", async () => {
    // The four the scenario scripts, and the four the reviewer's classes name: an
    // agent capture, its retake, a completed download, and a bundled asset set. Not
    // one of them is an act this renderer performed, so under the card register every
    // one of them was dropped.
    const ledger = await mountedLedger(createFixtureBridge({ scenario: BROWSER_SCENARIO }));
    expect([...ledger.keys()].toSorted()).toStrictEqual(
      [AGENT_CAPTURE_ID, RETAKEN_CAPTURE_ID, DOWNLOAD_ID, ASSET_BUNDLE_ID].toSorted(),
    );
  });

  it("names an object produced before this mount, which the register cannot", async () => {
    // The register is held per component instance, so a pane that remounts forgets
    // every capture taken before it. The ledger is the daemon's and is read fresh, so
    // the same four objects are named on a mount that performed no act at all.
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const first = await mountedLedger(bridge);
    const remounted = await mountedLedger(bridge);
    expect([...remounted.keys()].toSorted()).toStrictEqual([...first.keys()].toSorted());
  });

  it("keeps this window's own card where the ledger names the same object", async () => {
    // Both sides agree the object is browser output and one of them additionally
    // knows its media type and its stored byte length, so the card has to win.
    const ledger = await mountedLedger(
      createFixtureBridge({ scenario: BROWSER_SCENARIO }),
      new Map([[AGENT_CAPTURE_ID, captureCard(AGENT_CAPTURE_ID)]]),
    );
    expect(ledger.get(AGENT_CAPTURE_ID)?.kind).toBe("capture");
    expect(ledger.get(DOWNLOAD_ID)?.kind).toBe("named");
  });

  it("leaves a refused read unanswered rather than empty", async () => {
    // A build where the browser wire is unregistered has been told nothing about what
    // the browser produced, which is not the same as being told it produced nothing.
    // The window's own capture still lists, because that one it saw itself.
    const own = new Map([["artifact-own-capture", captureCard("artifact-own-capture")]]);
    const { result } = renderHook(() =>
      useBrowserProducedObjects(refusingProvenanceBridge(), BROWSER_SCENARIO.sessionId, own),
    );
    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });
    expect(result.current.get("artifact-own-capture")?.kind).toBe("capture");
  });

  it("negative control: an object the ledger does not name is not browser output", () => {
    // The join is what excludes it, and this is the case that proves the join is not
    // simply admitting everything it is handed.
    const joined = joinProducedObjects(new Set([DOWNLOAD_ID]), new Map());
    expect(joined.has(DOWNLOAD_ID)).toBe(true);
    expect(joined.has(ATTACHMENT_ID)).toBe(false);
  });

  it("negative control: an unanswered ledger contributes nothing rather than everything", () => {
    expect(joinProducedObjects(undefined, new Map()).size).toBe(0);
  });
});
