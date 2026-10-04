// The manifest re-read, driven through the reader that owns it, so the act is asserted against
// the half it is meant to be correct against.

import { type Mock, describe, expect, it, vi } from "vitest";

import type { ArtifactReadResponse } from "@ai-sidekicks/contracts/artifacts/operations";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { ArtifactListReader } from "./artifact-list-reader.js";
import {
  LISTED_ONE_ROW,
  OTHER_ARTIFACT_ID,
  SERVED_SUMMARY,
  SERVED_VERSION,
  SESSION_ID,
  readThrough,
} from "@test/helpers/artifact-list-readers.js";

/**
 * A reader whose manifest re-reads are all parked, one resolver per call.
 *
 * A queue rather than one resolver, so a case can settle two reads of one manifest in
 * either order.
 */
function readerWithHeldManifestReads(clock: ManualClock): {
  readonly reader: ArtifactListReader;
  readonly artifactRead: Mock<() => Promise<ArtifactReadResponse>>;
  readonly releaseNthRead: (index: number, answer: ArtifactReadResponse) => void;
} {
  const parked: ((answer: ArtifactReadResponse) => void)[] = [];
  const artifactRead = vi.fn(
    async () =>
      new Promise<ArtifactReadResponse>((resolve) => {
        parked.push(resolve);
      }),
  );
  const reader = new ArtifactListReader({
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
function servedManifest(digest: string): ArtifactReadResponse {
  return {
    manifest: { ...SERVED_SUMMARY, digest },
    ...SERVED_VERSION,
    payloadHandle: "sha256:2b4c",
  };
}

/** What the row on the reading currently says its digest is. */
function listedDigest(reader: ArtifactListReader): string | undefined {
  const state = reader.snapshot.artifacts;
  return state.kind === "listed" ? state.rows[0]?.digest : undefined;
}

describe("artifact list actions — one manifest re-read per row, each with its own identity", () => {
  it("sends one read when the row is pressed twice, and refuses the second in words", async () => {
    // Two reads of one manifest settle in either order; the older could overwrite the newer.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.readManifest(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    await expect(reader.readManifest(SERVED_SUMMARY.id)).rejects.toThrow("already being read");

    expect(artifactRead).toHaveBeenCalledTimes(1);
    // The reading names the row while its read is outstanding, which holds the control.
    expect(reader.snapshot.manifestReadInFlightArtifactIds.has(SERVED_SUMMARY.id)).toBe(true);

    releaseNthRead(0, servedManifest("sha256:first"));
    expect((await firstPress).status).toBe("settled");
  });

  it("drops a reply for a request this row's register has given up", async () => {
    // A disposal supersedes the register; the answer must not put an older manifest back.
    const clock = new ManualClock();
    const { reader, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.readManifest(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    reader.dispose();
    releaseNthRead(0, servedManifest("sha256:stale"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(listedDigest(reader)).toBe(SERVED_SUMMARY.digest);
  });

  it("negative control: the register is given back, so the next press is sent rather than refused", async () => {
    // A register never released would reject every later re-read of that row.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseNthRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.readManifest(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    releaseNthRead(0, servedManifest("sha256:first"));
    expect((await firstPress).status).toBe("settled");
    expect(reader.snapshot.manifestReadInFlightArtifactIds.size).toBe(0);

    const secondPress = reader.readManifest(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    releaseNthRead(1, servedManifest("sha256:second"));

    expect((await secondPress).status).toBe("settled");
    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(listedDigest(reader)).toBe("sha256:second");
  });

  it("negative control: a second row is read while the first is still on the wire", async () => {
    // Two rows re-reading cannot collide; one row's control must not be held for the other.
    const clock = new ManualClock();
    const { reader, artifactRead } = readerWithHeldManifestReads(clock);
    reader.start();
    await readThrough(clock);

    void reader.readManifest(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    void reader.readManifest(OTHER_ARTIFACT_ID);
    await crossMacrotaskBoundary();

    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(reader.snapshot.manifestReadInFlightArtifactIds.has(OTHER_ARTIFACT_ID)).toBe(true);
  });

  it("propagates a rejected read and gives the row's control back", async () => {
    const clock = new ManualClock();
    const reader = new ArtifactListReader({
      listArtifacts: async () => LISTED_ONE_ROW,
      readArtifact: async () => {
        throw new Error("the read failed");
      },
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);

    await expect(reader.readManifest(SERVED_SUMMARY.id)).rejects.toThrow("the read failed");

    expect(reader.snapshot.manifestReadInFlightArtifactIds.size).toBe(0);
    expect(listedDigest(reader)).toBe(SERVED_SUMMARY.digest);
  });
});
