// The two acts that write to a row, driven through the reader that hosts them.
//
// THROUGH THE READER AND NEVER BESIDE IT. `ArtifactPaneActions` is handed an
// `ArtifactActionHost`, and the only implementation of that port is the reader's own
// adapter — so a suite that supplied a hand-written host would be asserting against a
// stand-in for the half these acts are meant to be correct against. Every case here
// presses a control on a live reader.
//
// TWO LOAD-BEARING BLOCKS. The delete block is the reconciliation one: a served delete
// establishes that a row is GONE, which no in-flight list read can discover, so it
// applies and re-reads even when a refresh moved the stamp under it. The re-read block
// is the register one: each row's manifest re-read is single-flight BY ROW, so a
// second press on one row is refused while a press on another row is admitted, and a
// settlement the register has moved past is dropped.
//
// A CALL THAT REJECTED rather than answering is `artifact-actions.rejection.test.ts`,
// which drives all three acts because the claim there is about the door they share.

import { describe, expect, it, vi } from "vitest";

import {
  drainMicrotasks,
  fixtureBridgeWithGrowth,
} from "../../bridge/fixture-bridge.test-support.js";
import { growthUnavailable } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { ManualClock } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPaneReader } from "./artifact-reader.js";
import {
  type GrowthPortAnswer,
  DELETE_RECEIPT,
  OTHER_ARTIFACT_ID,
  SERVED_DELETE,
  SERVED_SUMMARY,
  SESSION_ID,
  listedRowIds,
  readThrough,
  readerRacingADelete,
} from "./artifact-pane.test-support.js";

describe("artifact pane actions — a served delete reconciles, superseded or not", () => {
  it("removes the row and reads again when nothing raced the delete", async () => {
    const clock = new ManualClock();
    const { reader, releaseDelete, stopListingTheArtifact } = readerRacingADelete(clock);
    reader.start();
    await readThrough(clock);
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);

    const deletion = reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    stopListingTheArtifact();
    releaseDelete(SERVED_DELETE);

    expect(await deletion).toStrictEqual({ status: "settled", receipt: DELETE_RECEIPT });
    expect(listedRowIds(reader)).toStrictEqual([]);
    await readThrough(clock);
    expect(reader.performCount).toBe(2);
  });

  it("still reconciles when a refresh moved the stamp under the delete", async () => {
    // The bug, exercised: confirm Delete, press "Read again" before the answer
    // lands, and let that read observe the artifact the daemon is about to destroy.
    // A reader that returned on the moved stamp scheduled no second read and left
    // the republished row on screen, actionable, against a manifest that is gone.
    const clock = new ManualClock();
    const { reader, releaseDelete, stopListingTheArtifact } = readerRacingADelete(clock);
    reader.start();
    await readThrough(clock);

    const deletion = reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    reader.refresh();
    await readThrough(clock);
    expect(reader.performCount).toBe(2);
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);

    stopListingTheArtifact();
    releaseDelete(SERVED_DELETE);

    // Not `settled`: the reader applied the removal and asked for the read that
    // re-establishes the rest, and it cannot vouch for a screen it does not yet own.
    expect(await deletion).toStrictEqual({ status: "reconciling", receipt: DELETE_RECEIPT });
    expect(listedRowIds(reader)).toStrictEqual([]);

    await readThrough(clock);
    expect(reader.performCount).toBe(3);
    expect(listedRowIds(reader)).toStrictEqual([]);
  });

  it("negative control: a disposed reader publishes nothing and schedules nothing", async () => {
    // The other half of the split. `#generation` answered disposal and supersession
    // with one comparison; a fix that reconciled on every served delete would re-arm
    // a scheduler behind a pane that unmounted, which is the failure the refresh
    // substrate exists to make unrepresentable.
    const clock = new ManualClock();
    const { reader, releaseDelete, stopListingTheArtifact } = readerRacingADelete(clock);
    reader.start();
    await readThrough(clock);

    const deletion = reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    reader.dispose();
    stopListingTheArtifact();
    releaseDelete(SERVED_DELETE);

    expect(await deletion).toStrictEqual({ status: "superseded" });
    expect(listedRowIds(reader)).toStrictEqual([SERVED_SUMMARY.artifactId]);
    await readThrough(clock);
    expect(reader.performCount).toBe(1);
  });
});

/**
 * A reader whose manifest re-reads are all parked, one resolver per call.
 *
 * A QUEUE rather than one overwritten resolver, because the whole claim is about two
 * reads of one manifest settling in either order: a harness that could release only
 * the newest call could not deliver the older answer last, which is the delivery the
 * defect turned on.
 */
function readerWithHeldManifestReads(clock: ManualClock): {
  readonly reader: ArtifactPaneReader;
  readonly artifactRead: ReturnType<typeof vi.fn>;
  readonly releaseNthRead: (index: number, answer: GrowthPortAnswer<"artifactRead">) => void;
} {
  const parked: ((answer: GrowthPortAnswer<"artifactRead">) => void)[] = [];
  const artifactRead = vi.fn(
    async () =>
      new Promise<GrowthPortAnswer<"artifactRead">>((resolve) => {
        parked.push(resolve);
      }),
  );
  const reader = new ArtifactPaneReader({
    bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
      artifactList: async () => ({ status: "served", value: [SERVED_SUMMARY] }),
      artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
      artifactRead,
    }),
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock,
  });
  return {
    reader,
    artifactRead,
    releaseNthRead: (index, answer) => {
      parked[index]?.(answer);
    },
  };
}

/** One served manifest re-read, carrying a digest a case can tell from its sibling. */
function servedManifest(digest: string): GrowthPortAnswer<"artifactRead"> {
  return {
    status: "served",
    value: { manifest: { ...SERVED_SUMMARY, digest }, payloadHandle: "sha256:2b4c" },
  };
}

/** What the row on the reading currently says its digest is. */
function listedDigest(reader: ArtifactPaneReader): string | undefined {
  const state = reader.snapshot.artifacts;
  return state.kind === "listed" ? state.rows[0]?.digest : undefined;
}

describe("artifact pane actions — one manifest re-read per row, each with its own identity", () => {
  it("sends one read when the row is pressed twice, and refuses the second in words", async () => {
    // The bug, exercised: both presses captured the same refresh stamp — starting an
    // act does not advance it — so both reached the port and both replies passed the
    // supersession check. Two reads of one manifest settle in either order, so the
    // older answer could overwrite the newer row.
    const clock = new ManualClock();
    const { reader, artifactRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.readManifest(SERVED_SUMMARY.artifactId);
    await drainMicrotasks();
    const secondPress = await reader.readManifest(SERVED_SUMMARY.artifactId);

    expect(artifactRead).toHaveBeenCalledTimes(1);
    expect(secondPress.status).toBe("refused");
    expect(secondPress.status === "refused" ? secondPress.refusal.code : undefined).toBe(
      "manifest-read-in-flight",
    );
    // The row is named on the reading while its read is outstanding, which is what
    // holds the control that sent it.
    expect(reader.snapshot.manifestReadInFlightArtifactIds.has(SERVED_SUMMARY.artifactId)).toBe(
      true,
    );
    expect(reader.snapshot.refusalByArtifactId.get(SERVED_SUMMARY.artifactId)?.code).toBe(
      "manifest-read-in-flight",
    );

    void firstPress;
  });

  it("drops a reply for a request this row's register has given up", async () => {
    // The identity check, exercised: the register is what a continuation is measured
    // against, so an answer for a request it has moved past — a disposal here, a
    // successor once one is reachable — writes nothing rather than putting an older
    // manifest back on a row that has since been answered for.
    const clock = new ManualClock();
    const { reader, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.readManifest(SERVED_SUMMARY.artifactId);
    await drainMicrotasks();
    reader.dispose();
    releaseNthRead(0, servedManifest("sha256:stale"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(listedDigest(reader)).toBe(SERVED_SUMMARY.digest);
  });

  it("negative control: the register is given back, so the next press is sent rather than refused", async () => {
    // Without this, a register taken and never released would pass both cases above
    // and refuse every later re-read of that row for the life of the pane — and the
    // control would stay held with it, which is worse than the defect it replaced.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.readManifest(SERVED_SUMMARY.artifactId);
    await drainMicrotasks();
    releaseNthRead(0, servedManifest("sha256:first"));
    expect((await firstPress).status).toBe("settled");
    expect(reader.snapshot.manifestReadInFlightArtifactIds.size).toBe(0);

    const secondPress = reader.readManifest(SERVED_SUMMARY.artifactId);
    await drainMicrotasks();
    releaseNthRead(1, servedManifest("sha256:second"));

    expect((await secondPress).status).toBe("settled");
    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(listedDigest(reader)).toBe("sha256:second");
  });

  it("negative control: a second row is read while the first is still on the wire", async () => {
    // The register is keyed per row for the reason the mode picker's is: two rows
    // re-reading are two calls about two manifests that cannot collide, and a pane
    // that held one row's control because another was waiting would refuse a press
    // for a reason that is not about it.
    const clock = new ManualClock();
    const { reader, artifactRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    void reader.readManifest(SERVED_SUMMARY.artifactId);
    await drainMicrotasks();
    void reader.readManifest(OTHER_ARTIFACT_ID);
    await drainMicrotasks();

    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(reader.snapshot.manifestReadInFlightArtifactIds.has(OTHER_ARTIFACT_ID)).toBe(true);
    expect(reader.snapshot.refusalByArtifactId.get(OTHER_ARTIFACT_ID)).toBeUndefined();
  });
});
