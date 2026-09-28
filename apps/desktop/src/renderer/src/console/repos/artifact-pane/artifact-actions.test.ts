// The manifest re-read, driven through the reader that hosts it.
//
// Every case presses a control on a live reader rather than supplying a hand-written host,
// so the act is asserted against the half it is meant to be correct against.
//
// The load-bearing block is the re-read register: each row's re-read is single-flight by
// row, so a second press on one row never reaches the port while a press on another row is
// admitted, and a settlement the register has moved past is dropped.

import { type Mock, describe, expect, it, vi } from "vitest";

import type { GrowthArtifactRead } from "../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { ManualClock } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPaneReader } from "./artifact-reader.js";
import {
  LISTED_ONE_ROW,
  OTHER_ARTIFACT_ID,
  SERVED_SUMMARY,
  SESSION_ID,
  readThrough,
} from "./artifact-pane.test-support.js";

/**
 * A reader whose manifest re-reads are all parked, one resolver per call.
 *
 * A queue rather than one overwritten resolver, because the claim is about two reads of
 * one manifest settling in either order: a harness that could release only the newest call
 * could not deliver the older answer last.
 */
function readerWithHeldManifestReads(clock: ManualClock): {
  readonly reader: ArtifactPaneReader;
  readonly artifactRead: Mock<() => Promise<GrowthArtifactRead>>;
  readonly releaseNthRead: (index: number, answer: GrowthArtifactRead) => void;
} {
  const parked: ((answer: GrowthArtifactRead) => void)[] = [];
  const artifactRead = vi.fn(
    async () =>
      new Promise<GrowthArtifactRead>((resolve) => {
        parked.push(resolve);
      }),
  );
  const reader = new ArtifactPaneReader({
    listArtifacts: async () => LISTED_ONE_ROW,
    readArtifact: artifactRead,
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
function servedManifest(digest: string): GrowthArtifactRead {
  return { manifest: { ...SERVED_SUMMARY, digest }, payloadHandle: "sha256:2b4c" };
}

/** What the row on the reading currently says its digest is. */
function listedDigest(reader: ArtifactPaneReader): string | undefined {
  const state = reader.snapshot.artifacts;
  return state.kind === "listed" ? state.rows[0]?.digest : undefined;
}

describe("artifact pane actions — one manifest re-read per row, each with its own identity", () => {
  it("sends one read when the row is pressed twice, and refuses the second in words", async () => {
    // Two reads of one manifest settle in either order, so the older answer could
    // overwrite the newer row.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.readManifest(SERVED_SUMMARY.artifactId);
    await crossMacrotaskBoundary();
    await expect(reader.readManifest(SERVED_SUMMARY.artifactId)).rejects.toThrow(
      "already being read",
    );

    expect(artifactRead).toHaveBeenCalledTimes(1);
    // The row is named on the reading while its read is outstanding, which is what holds
    // the control that sent it.
    expect(reader.snapshot.manifestReadInFlightArtifactIds.has(SERVED_SUMMARY.artifactId)).toBe(
      true,
    );

    releaseNthRead(0, servedManifest("sha256:first"));
    expect((await firstPress).status).toBe("settled");
  });

  it("drops a reply for a request this row's register has given up", async () => {
    // A disposal takes the register out from under a continuation, and an answer for a
    // request it has moved past writes nothing rather than putting an older manifest back
    // on a row that has since been answered for.
    const clock = new ManualClock();
    const { reader, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.readManifest(SERVED_SUMMARY.artifactId);
    await crossMacrotaskBoundary();
    reader.dispose();
    releaseNthRead(0, servedManifest("sha256:stale"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(listedDigest(reader)).toBe(SERVED_SUMMARY.digest);
  });

  it("negative control: the register is given back, so the next press is sent rather than refused", async () => {
    // A register taken and never released would pass both cases above and reject every
    // later re-read of that row for the life of the pane, with the control held.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.readManifest(SERVED_SUMMARY.artifactId);
    await crossMacrotaskBoundary();
    releaseNthRead(0, servedManifest("sha256:first"));
    expect((await firstPress).status).toBe("settled");
    expect(reader.snapshot.manifestReadInFlightArtifactIds.size).toBe(0);

    const secondPress = reader.readManifest(SERVED_SUMMARY.artifactId);
    await crossMacrotaskBoundary();
    releaseNthRead(1, servedManifest("sha256:second"));

    expect((await secondPress).status).toBe("settled");
    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(listedDigest(reader)).toBe("sha256:second");
  });

  it("negative control: a second row is read while the first is still on the wire", async () => {
    // Two rows re-reading are two calls about two manifests that cannot collide, and a
    // pane that held one row's control because another was waiting would block a press
    // for a reason that is not about it.
    const clock = new ManualClock();
    const { reader, artifactRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    void reader.readManifest(SERVED_SUMMARY.artifactId);
    await crossMacrotaskBoundary();
    void reader.readManifest(OTHER_ARTIFACT_ID);
    await crossMacrotaskBoundary();

    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(reader.snapshot.manifestReadInFlightArtifactIds.has(OTHER_ARTIFACT_ID)).toBe(true);
  });

  it("propagates a rejected read and gives the row's control back", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactPaneReader({
      listArtifacts: async () => LISTED_ONE_ROW,
      readArtifact: async () => {
        throw new Error("the read failed");
      },
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);

    await expect(reader.readManifest(SERVED_SUMMARY.artifactId)).rejects.toThrow("the read failed");

    expect(reader.snapshot.manifestReadInFlightArtifactIds.size).toBe(0);
    expect(listedDigest(reader)).toBe(SERVED_SUMMARY.digest);
  });
});
