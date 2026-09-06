// A call that rejected rather than answering, on every act the pane has.
//
// A SUITE OF ITS OWN BECAUSE THE CLAIM IS ABOUT THE DOOR AND NOT THE ACT. An IPC
// disconnect makes a call throw where the port's own union says it answers, and every
// act reaches the wire through the same reader (`growth-call.ts`) — so a fix that
// caught the rejection in one act would leave the other two holding a control that
// never comes back. All three are driven here for that reason, the payload fetch
// included, whose served behaviour belongs to `artifact-payload-fetch.test.ts`.
//
// WHAT A SERVED ANSWER DOES is `artifact-actions.test.ts`: the delete's reconciliation
// and the per-row manifest re-read register.

import { describe, expect, it, vi } from "vitest";

import { fixtureBridgeWithGrowth } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { drainMicrotasks } from "../../core/microtask-drain.test-support.js";
import { growthUnavailable } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { ConsoleRefusalError, ManualClock, refuse } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPaneReader } from "./artifact-reader.js";
import {
  SERVED_SUMMARY,
  SESSION_ID,
  listedRowIds,
  readThrough,
  readerWithHeldPayloadFetch,
  servedPayload,
} from "./artifact-pane.test-support.js";

/**
 * A reader whose port REJECTS instead of answering.
 *
 * The live bridge is one process boundary away, so an IPC disconnect makes the call
 * throw rather than return the port's typed refusal — the one failure `GrowthOutcome`
 * cannot express and therefore the one `growthAnswerReading` never sees.
 */
function readerWithRejectingBridge(
  clock: ManualClock,
  rejection: unknown,
): {
  readonly reader: ArtifactPaneReader;
  readonly artifactRead: ReturnType<typeof vi.fn>;
} {
  const artifactRead = vi.fn(() => Promise.reject(rejection));
  const reader = new ArtifactPaneReader({
    bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
      artifactList: async () => ({ status: "served", value: [SERVED_SUMMARY] }),
      artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
      artifactRead,
      artifactDelete: () => Promise.reject(rejection),
    }),
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return { reader, artifactRead };
}

describe("artifact pane actions — a rejected call is an answer, not a stuck pane", () => {
  it("publishes the refused payload arm and gives the control back", async () => {
    // The bug, exercised: the thrown rejection propagated out of the await, so
    // `growthAnswerReading` was never reached, `finally` released the register, and
    // the reading kept `{ status: "fetching" }` — the arm the pane holds its Fetch
    // control by and the arm every scheduled list read carries forward. Nothing was
    // ever going to settle it short of a remount.
    const clock = new ManualClock();
    const { reader, artifactRead } = readerWithRejectingBridge(
      clock,
      new Error("the daemon channel closed"),
    );
    reader.start();
    await readThrough(clock);

    const outcome = await reader.fetchPayload(SERVED_SUMMARY.artifactId);

    expect(outcome.status).toBe("refused");
    expect(reader.snapshot.payload).toStrictEqual({
      status: "refused",
      artifactId: SERVED_SUMMARY.artifactId,
      refusal: {
        // The port's own vocabulary on both of its failure paths: a namespace the
        // live bridge fills in is gone exactly when a call through it throws.
        code: "wire-unregistered",
        // The leg, and NOT the rejected value: a rejection off the wire can carry
        // participant content as readily as a schema failure can.
        detail: "The payload fetch was rejected.",
        origin: "growth-port",
      },
    });
    // The control is held by the `fetching` arm alone, so leaving that arm IS the
    // control coming back — there is no second flag to assert against.
    expect(reader.snapshot.payload.status).not.toBe("fetching");

    // And the register was given back, so the next press reaches the port rather
    // than meeting the in-flight refusal for the life of the pane.
    await reader.fetchPayload(SERVED_SUMMARY.artifactId);
    expect(artifactRead).toHaveBeenCalledTimes(2);
  });

  it("carries a thrown refusal through with the origin and code it named", async () => {
    // The normalizer's first arm, which is why this pane does not mint its own: the
    // fixture bridge throws a `ConsoleRefusalError`, and re-labelling it
    // `wire-unregistered` would bury the diagnosis the seam already composed.
    const clock = new ManualClock();
    const carried = refuse("growth-port", "scripted-reply-missing", "No reply was parked.");
    const { reader } = readerWithRejectingBridge(clock, new ConsoleRefusalError(carried));
    reader.start();
    await readThrough(clock);

    const outcome = await reader.fetchPayload(SERVED_SUMMARY.artifactId);

    expect(outcome).toStrictEqual({ status: "refused", refusal: carried });
    expect(reader.snapshot.payload).toStrictEqual({
      status: "refused",
      artifactId: SERVED_SUMMARY.artifactId,
      refusal: carried,
    });
  });

  it("records a rejected manifest re-read against its row, and a rejected delete too", async () => {
    // The other two acts ask the same bridge across the same boundary. Left bare,
    // each returned a rejected promise to a caller that only ever attaches `.then`,
    // so the press produced no refusal anywhere and an unhandled rejection instead.
    const clock = new ManualClock();
    const { reader } = readerWithRejectingBridge(clock, new Error("the daemon channel closed"));
    reader.start();
    await readThrough(clock);

    const reRead = await reader.readManifest(SERVED_SUMMARY.artifactId);
    expect(reRead.status).toBe("refused");
    expect(reader.snapshot.refusalByArtifactId.get(SERVED_SUMMARY.artifactId)?.code).toBe(
      "wire-unregistered",
    );

    const deletion = await reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    expect(deletion.status).toBe("refused");
    // The row is still listed: a rejected delete established nothing at all, and
    // removing the row would report a destruction the daemon never confirmed.
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);
  });

  it("negative control: a served answer still settles and a port refusal keeps its own code", async () => {
    // Both halves of the over-reach. A `try` that swallowed the served path would
    // pass every case above; so would one that re-labelled the port's own typed
    // refusal, which is the code a person pastes into a bug report.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const served = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await drainMicrotasks();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the bytes came back"));
    expect((await served).status).toBe("settled");

    const refusing = new ArtifactPaneReader({
      bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
        artifactList: async () => ({ status: "served", value: [SERVED_SUMMARY] }),
        artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
        artifactRead: async () => growthUnavailable("artifactRead"),
      }),
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    refusing.start();
    await readThrough(clock);

    const refused = await refusing.fetchPayload(SERVED_SUMMARY.artifactId);
    expect(refused.status === "refused" ? refused.refusal.code : undefined).toBe(
      "wire-unregistered",
    );
    expect(refused.status === "refused" ? refused.refusal.origin : undefined).toBe("growth-port");
  });
});
