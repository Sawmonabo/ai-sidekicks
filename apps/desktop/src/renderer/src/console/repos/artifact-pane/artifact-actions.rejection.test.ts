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
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
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
    expect(reader.snapshot.payload).toMatchObject({
      status: "refused",
      artifactId: SERVED_SUMMARY.artifactId,
      refusal: {
        // The port's own origin on both of its failure paths, and the member that says
        // WHICH one this was: `call-rejected` is a call that was made and threw, where
        // `wire-unregistered` is the wire this build does not carry and nobody asked.
        code: "call-rejected",
        origin: "growth-port",
        // And the port's widening, so a rejected fetch carries the operation it was on
        // rather than arriving as a bare refusal the pane cannot attribute.
        operationId: "artifactRead",
      },
    });
    // The reason travels. The pane used to publish a constant naming the leg, which
    // left a participant with a refusal and nothing to act on; the sentence now comes
    // through `core/wire-rejection.ts`, which composes prose the producing side wrote
    // and refuses to serialize the rejected value into it.
    expect(
      reader.snapshot.payload.status === "refused" ? reader.snapshot.payload.refusal.detail : "",
    ).toContain("the daemon channel closed");
    // The control is held by the `fetching` arm alone, so leaving that arm IS the
    // control coming back — there is no second flag to assert against.
    expect(reader.snapshot.payload.status).not.toBe("fetching");

    // And the register was given back, so the next press reaches the port rather
    // than meeting the in-flight refusal for the life of the pane.
    await reader.fetchPayload(SERVED_SUMMARY.artifactId);
    expect(artifactRead).toHaveBeenCalledTimes(2);
  });

  it("keeps a thrown refusal's sentence and folds its code onto the port's", async () => {
    // The normalizer's carried-refusal arm, read for the half that is this pane's to
    // render: the fixture bridge throws a `ConsoleRefusalError`, and the diagnosis the
    // seam composed reaches the pane rather than being replaced.
    //
    // ITS CODE AND ORIGIN DO NOT, AND THAT IS THE DELIBERATE HALF. Carried through,
    // this refusal reached a growth surface stamped `fixture-bridge` /
    // `reply-unscripted` — a subsystem name that is not the one the call was made to
    // and a code from a set the growth port does not declare, which is exactly the
    // sprawl one origin per subsystem exists to end and contradicts this door's own
    // headline property. `bridge/growth-port/growth-port.ts` closes that: what
    // happened here is that this port's call threw, which is one fact with one code
    // however the rejection spelled itself.
    const clock = new ManualClock();
    const carried = refuse(
      "fixture-bridge",
      "reply-unscripted",
      "artifact.read — no scenario scripts this call",
    );
    const { reader } = readerWithRejectingBridge(clock, new ConsoleRefusalError(carried));
    reader.start();
    await readThrough(clock);

    const outcome = await reader.fetchPayload(SERVED_SUMMARY.artifactId);

    const refusal = outcome.status === "refused" ? outcome.refusal : undefined;
    expect(refusal?.code).toBe("call-rejected");
    expect(refusal?.origin).toBe("growth-port");
    expect(refusal?.detail).toContain(carried.detail);
    expect(reader.snapshot.payload).toStrictEqual({
      status: "refused",
      artifactId: SERVED_SUMMARY.artifactId,
      refusal,
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
      "call-rejected",
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
    await crossMacrotaskBoundary();
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
