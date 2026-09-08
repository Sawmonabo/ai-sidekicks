// The fourth act, driven through the reader that hosts it: what the row ends up
// saying, which press is refused, and what a refresh under it does not undo.
//
// THROUGH THE READER AND NEVER BESIDE IT, on `artifact-actions.test.ts`'s rule: the
// only implementation of `ArtifactActionHost` is the reader's own adapter, so a suite
// supplying a hand-written host would assert against a stand-in for the half this act
// has to be correct against.
//
// THREE LOAD-BEARING CLAIMS. The row takes the class the DAEMON settled on and never
// the one that was asked for; a second press on one row is refused while a press on
// another row is admitted; and a change served under a refresh still applies, because
// the racing list read may have observed the row before the daemon re-classified it.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { ParkedCalls, handAnsweredCall } from "../held-calls.test-support.js";
import { ArtifactPaneReader } from "./artifact-reader.js";
import {
  type GrowthPortAnswer,
  LISTED_ONE_ROW,
  OTHER_ARTIFACT_ID,
  SERVED_SUMMARY,
  SESSION_ID,
  artifactBridgeAnswering,
  readThrough,
} from "./artifact-pane.test-support.js";

/** The reply a served change answers with. Every member required, so all are here. */
const SERVED_LOCAL_ONLY: GrowthPortAnswer<"artifactVisibilityUpdate"> = {
  status: "served",
  value: {
    artifactId: SERVED_SUMMARY.artifactId,
    visibility: "local-only",
    updatedAt: "2026-09-02T07:06:00.000Z",
  },
};

function readerAnswering(
  clock: ManualClock,
  script: Parameters<typeof artifactBridgeAnswering>[0],
): ArtifactPaneReader {
  const bridge = artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, ...script });
  return new ArtifactPaneReader({
    bridge,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
}

/** What the one listed row currently says its class is. */
function listedVisibility(reader: ArtifactPaneReader): string | undefined {
  const { artifacts } = reader.snapshot;
  return artifacts.kind === "listed" ? artifacts.rows[0]?.visibility : undefined;
}

describe("artifact visibility update — the row takes the daemon's class", () => {
  it("writes the settled class onto the row and asks for the read that follows", async () => {
    const clock = new ManualClock();
    const reader = readerAnswering(clock, { visibilityAnswer: SERVED_LOCAL_ONLY });
    reader.start();
    await readThrough(clock);
    expect(listedVisibility(reader)).toBe("shared");

    const outcome = await reader.updateVisibility(SERVED_SUMMARY.artifactId, "local-only");

    expect(outcome).toStrictEqual({ status: "settled", visibility: "local-only" });
    expect(listedVisibility(reader)).toBe("local-only");
    await readThrough(clock);
    expect(reader.performCount).toBe(2);
  });

  it("negative control: a policy-blocked share leaves the class the daemon kept", async () => {
    // THE CLAIM THE REQUEST CANNOT MAKE. A row written from what was ASKED FOR would
    // read `shared` under an artifact the daemon has just declined to share, and the
    // toggle beside it would then offer to undo a change that never happened.
    const clock = new ManualClock();
    // THE SAME SERVED REPLY, ASKED FOR THE OPPOSITE CLASS. One fixture rather than a
    // near-identical second: what makes this the policy-blocked case is the REQUEST
    // below, not a different answer.
    const reader = readerAnswering(clock, { visibilityAnswer: SERVED_LOCAL_ONLY });
    reader.start();
    await readThrough(clock);

    const outcome = await reader.updateVisibility(SERVED_SUMMARY.artifactId, "shared");

    expect(outcome).toStrictEqual({ status: "settled", visibility: "local-only" });
    expect(listedVisibility(reader)).toBe("local-only");
  });

  it("records the daemon's refusal against the row and changes nothing", async () => {
    const clock = new ManualClock();
    // Unscripted, so the port answers its own refusal for this operation by name.
    const reader = readerAnswering(clock, {});
    reader.start();
    await readThrough(clock);

    const outcome = await reader.updateVisibility(SERVED_SUMMARY.artifactId, "local-only");

    expect(outcome.status).toBe("refused");
    expect(listedVisibility(reader)).toBe("shared");
    expect(reader.snapshot.refusalByArtifactId.get(SERVED_SUMMARY.artifactId)).toBeDefined();
  });
});

describe("artifact visibility update — one change per row at a time", () => {
  it("refuses a second press on the row whose change is on the wire", async () => {
    const clock = new ManualClock();
    const held = handAnsweredCall<GrowthPortAnswer<"artifactVisibilityUpdate">>();
    const reader = readerAnswering(clock, { artifactVisibilityUpdate: held.invoke });
    reader.start();
    await readThrough(clock);

    const first = reader.updateVisibility(SERVED_SUMMARY.artifactId, "local-only");
    expect([...reader.snapshot.visibilityUpdateInFlightArtifactIds]).toContain(
      SERVED_SUMMARY.artifactId,
    );
    const second = await reader.updateVisibility(SERVED_SUMMARY.artifactId, "shared");

    expect(second.status).toBe("refused");
    // The sentence names the row, so a participant can tell which one is held.
    expect(reader.snapshot.refusalByArtifactId.get(SERVED_SUMMARY.artifactId)?.detail).toContain(
      SERVED_SUMMARY.artifactId,
    );

    held.open(SERVED_LOCAL_ONLY);
    await first;
    expect([...reader.snapshot.visibilityUpdateInFlightArtifactIds]).not.toContain(
      SERVED_SUMMARY.artifactId,
    );
  });

  it("negative control: a press on a DIFFERENT row is admitted while the first is held", async () => {
    // Keyed by artifact id and never per pane: two rows re-classifying are two calls
    // about two manifests that cannot collide, and holding one row's toggle because
    // another row is waiting would hold it for a reason that is not about it.
    //
    // BOTH CALLS ARE PARKED AND RELEASED TOGETHER, because a gate that answers only
    // its newest invocation would leave the first press unsettled and prove nothing
    // about it.
    const clock = new ManualClock();
    const parked = new ParkedCalls();
    const reader = readerAnswering(clock, {
      artifactVisibilityUpdate: async () => {
        await parked.park();
        return SERVED_LOCAL_ONLY;
      },
    });
    reader.start();
    await readThrough(clock);

    const first = reader.updateVisibility(SERVED_SUMMARY.artifactId, "local-only");
    const other = reader.updateVisibility(OTHER_ARTIFACT_ID, "local-only");
    expect([...reader.snapshot.visibilityUpdateInFlightArtifactIds]).toStrictEqual([
      SERVED_SUMMARY.artifactId,
      OTHER_ARTIFACT_ID,
    ]);

    parked.releaseAll();
    // Neither is the in-flight refusal: both reached the port, which is the claim.
    expect((await other).status).not.toBe("refused");
    expect((await first).status).not.toBe("refused");
  });
});

describe("artifact visibility update — a refresh under it does not undo it", () => {
  it("reconciles rather than dropping when the stamp moved under the change", async () => {
    // A MUTATION IS NOT A RE-READ. The list read a racing refresh started can have
    // observed the artifact BEFORE the daemon re-classified it, so returning early on
    // the moved stamp would leave the old class on screen with nothing scheduled to
    // correct it.
    const clock = new ManualClock();
    const held = handAnsweredCall<GrowthPortAnswer<"artifactVisibilityUpdate">>();
    const reader = readerAnswering(clock, { artifactVisibilityUpdate: held.invoke });
    reader.start();
    await readThrough(clock);

    const change = reader.updateVisibility(SERVED_SUMMARY.artifactId, "local-only");
    reader.refresh();
    await readThrough(clock);
    expect(reader.performCount).toBe(2);

    held.open(SERVED_LOCAL_ONLY);

    expect(await change).toStrictEqual({ status: "reconciling", visibility: "local-only" });
    expect(listedVisibility(reader)).toBe("local-only");
  });

  it("negative control: a disposed reader publishes nothing a late answer carries", async () => {
    const clock = new ManualClock();
    const held = handAnsweredCall<GrowthPortAnswer<"artifactVisibilityUpdate">>();
    const reader = readerAnswering(clock, { artifactVisibilityUpdate: held.invoke });
    reader.start();
    await readThrough(clock);

    const change = reader.updateVisibility(SERVED_SUMMARY.artifactId, "local-only");
    reader.dispose();
    held.open(SERVED_LOCAL_ONLY);

    expect(await change).toStrictEqual({ status: "superseded" });
    expect(listedVisibility(reader)).toBe("shared");
  });
});
