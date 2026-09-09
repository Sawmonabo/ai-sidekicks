// Where the shelf's provenance comes from, every producer it has to cover, and WHEN.
//
// The first defect these cases pin: the shelf's allowed-id set was the pane's own CARD
// register, which holds one entry per capture this window took through the pane's
// Capture control. Everything else the browser produces — an agent's capture, a
// completed download, a bundled asset set, a capture started from the composer's
// attach row, and anything at all produced before the pane remounted — is absent from
// that register by construction, so valid `artifact.*` beats were dropped and the
// shelf reported that nothing had been produced.
//
// The second is the one the ledger inherited: it was read ONCE, by a mount-scoped
// effect. Provenance does not change for an artifact, but which artifacts exist does,
// so an object produced after that read — the agent capture a minute later, the
// download that completed while the person was reading — had its beat reach the fold
// and be dropped, because the ledger had never heard of the id. The read is now
// push-driven, so the cases below drive a real store's beats and count the reads.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../../bridge/index.js";
import { BROWSER_SCENARIO } from "../../bridge/scenario/browser.js";
import { ManualClock } from "../../core/index.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../core/settle.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import { initialisedStore } from "../../store/session-store-registry.test-support.js";
import type { SessionStore } from "../../store/index.js";
import type { ProducedObjectCard } from "./produced-objects.js";
import { createBrowserProvenanceRead, joinProducedObjects } from "./produced-provenance.js";

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

/**
 * A bridge that counts provenance reads and answers whatever it is currently holding.
 *
 * The COUNT is what the refresh cases assert on, and the mutable answer is what makes
 * "the ledger learned about an object it had not heard of" observable rather than
 * assumed: a second read that returned the same four ids would pass a case that only
 * counted.
 */
function countingProvenanceBridge(artifactIds: string[]): {
  readonly bridge: ConsoleBridge;
  readCount: () => number;
} {
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  let reads = 0;
  const bridge: ConsoleBridge = {
    ...base,
    growth: {
      ...base.growth,
      browserProducedArtifacts: async () => {
        reads += 1;
        return { status: "served" as const, value: { artifactIds: [...artifactIds] } };
      },
    },
  };
  return { bridge, readCount: () => reads };
}

/** Let the in-flight read settle without advancing the clock. */
async function settleRead(): Promise<void> {
  await crossMacrotaskBoundary();
}

/** A started ledger read over a real store, with its first read already settled. */
async function startedLedger(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): Promise<{
  readonly clock: ManualClock;
  readonly ledger: ReturnType<typeof createBrowserProvenanceRead>;
}> {
  const clock = new ManualClock();
  const ledger = createBrowserProvenanceRead({ ...options, clock });
  ledger.start();
  clock.advance(PAST_REFRESH_DEBOUNCE_MS);
  await settleRead();
  return { clock, ledger };
}

/** The ids a settled ledger read is holding, sorted so a case can compare them. */
function namedIds(ledger: ReturnType<typeof createBrowserProvenanceRead>): readonly string[] {
  const state = ledger.state;
  return state.kind === "loaded" ? [...state.value].toSorted() : [];
}

describe("the browser's produced-object provenance", () => {
  it("covers every producer the daemon names, not only this window's own captures", async () => {
    // The four the scenario scripts, and the four the reviewer's classes name: an
    // agent capture, its retake, a completed download, and a bundled asset set. Not
    // one of them is an act this renderer performed, so under the card register every
    // one of them was dropped.
    const sessionStore = initialisedStore(BROWSER_SCENARIO.sessionId);
    const { ledger } = await startedLedger({
      bridge: createFixtureBridge({ scenario: BROWSER_SCENARIO }),
      sessionStore,
    });
    expect(namedIds(ledger)).toStrictEqual(
      [AGENT_CAPTURE_ID, RETAKEN_CAPTURE_ID, DOWNLOAD_ID, ASSET_BUNDLE_ID].toSorted(),
    );
    ledger.dispose();
  });

  it("re-reads when an artifact beat arrives after the first read, and names what it learns", async () => {
    // The defect: an agent capture taken a minute after this pane mounted published
    // an `artifact.published` beat the shelf's fold read and dropped, because the
    // ledger it checks membership against had been read once and had never heard of
    // the id. The beat is a SIGNAL — its payload names no producing surface — so the
    // daemon is asked again rather than the payload being believed.
    const sessionStore = initialisedStore(BROWSER_SCENARIO.sessionId);
    const produced = [AGENT_CAPTURE_ID];
    const { bridge, readCount } = countingProvenanceBridge(produced);
    const { clock, ledger } = await startedLedger({ bridge, sessionStore });
    expect(readCount()).toBe(1);

    const LATER_CAPTURE_ID = "artifact-capture-produced-after-the-mount-read";
    produced.push(LATER_CAPTURE_ID);
    sessionStore.apply(
      eventOfKind(sessionStore.sessionId, "artifact.published", 1, {
        artifactId: LATER_CAPTURE_ID,
        state: "published",
      }),
    );
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleRead();

    expect(readCount()).toBe(2);
    expect(namedIds(ledger)).toContain(LATER_CAPTURE_ID);
    ledger.dispose();
  });

  it("costs one re-read for a burst of produced objects, never one per beat", async () => {
    // The coalescing claim, counted rather than assumed: an asset bundle landing as
    // three beats in one transition is one ledger read on the other side of it,
    // because the refresh goes through the console's one scheduler.
    const sessionStore = initialisedStore(BROWSER_SCENARIO.sessionId);
    const { bridge, readCount } = countingProvenanceBridge([AGENT_CAPTURE_ID]);
    const { clock, ledger } = await startedLedger({ bridge, sessionStore });

    sessionStore.applyBatch([
      eventOfKind(sessionStore.sessionId, "artifact.published", 1, {
        artifactId: "artifact-one",
        state: "published",
      }),
      eventOfKind(sessionStore.sessionId, "artifact.visibility_updated", 2, {
        artifactId: "artifact-one",
        state: "published",
      }),
      eventOfKind(sessionStore.sessionId, "artifact.superseded", 3, {
        artifactId: "artifact-one",
        state: "superseded",
      }),
    ]);
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleRead();

    expect(readCount()).toBe(2);
    ledger.dispose();
  });

  it("negative control: a beat outside the shelf's own kind set re-reads nothing", async () => {
    // Without this the two cases above would pass over a read that re-read on every
    // store transition, which is a poll wearing a subscription's clothes. The kinds
    // are the fold's own, so a run beat moves nothing the shelf shows.
    const sessionStore = initialisedStore(BROWSER_SCENARIO.sessionId);
    const { bridge, readCount } = countingProvenanceBridge([AGENT_CAPTURE_ID]);
    const { clock, ledger } = await startedLedger({ bridge, sessionStore });

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.starting", 1, { runId: "run-1" }));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleRead();

    expect(readCount()).toBe(1);
    ledger.dispose();
  });

  it("hears nothing more once the pane has left", async () => {
    const sessionStore = initialisedStore(BROWSER_SCENARIO.sessionId);
    const { bridge, readCount } = countingProvenanceBridge([AGENT_CAPTURE_ID]);
    const { clock, ledger } = await startedLedger({ bridge, sessionStore });
    ledger.dispose();

    sessionStore.apply(
      eventOfKind(sessionStore.sessionId, "artifact.published", 1, {
        artifactId: "artifact-after-the-unmount",
        state: "published",
      }),
    );
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleRead();

    expect(readCount()).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("leaves a refused read unanswered rather than empty", async () => {
    // A build where the browser wire is unregistered has been told nothing about what
    // the browser produced, which is not the same as being told it produced nothing,
    // so the ledger settles `failed` and the join below reads it as unanswered.
    const sessionStore = initialisedStore(BROWSER_SCENARIO.sessionId);
    const { ledger } = await startedLedger({
      bridge: refusingProvenanceBridge(),
      sessionStore,
    });
    expect(ledger.state.kind).toBe("failed");
    // The window's own capture still lists, because that one it saw itself.
    const own = new Map([["artifact-own-capture", captureCard("artifact-own-capture")]]);
    const joined = joinProducedObjects(undefined, own);
    expect(joined.size).toBe(1);
    expect(joined.get("artifact-own-capture")?.kind).toBe("capture");
    ledger.dispose();
  });

  it("keeps this window's own card where the ledger names the same object", () => {
    // Both sides agree the object is browser output and one of them additionally
    // knows its media type and its stored byte length, so the card has to win.
    const joined = joinProducedObjects(
      new Set([AGENT_CAPTURE_ID, DOWNLOAD_ID]),
      new Map([[AGENT_CAPTURE_ID, captureCard(AGENT_CAPTURE_ID)]]),
    );
    expect(joined.get(AGENT_CAPTURE_ID)?.kind).toBe("capture");
    expect(joined.get(DOWNLOAD_ID)?.kind).toBe("named");
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
