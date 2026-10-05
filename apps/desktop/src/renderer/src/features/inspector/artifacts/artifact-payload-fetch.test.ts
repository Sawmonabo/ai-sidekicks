// The payload fetch's single flight, driven through the reader that owns it.

import { describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { SessionStore } from "#renderer/store/session/session-store.js";
import type { ReadArtifact } from "./services/artifact-reads.js";
import { ArtifactListReader } from "./artifact-list-reader.js";
import {
  LISTED_ONE_ROW,
  SESSION_ID,
  OTHER_ARTIFACT_ID,
  SERVED_SUMMARY,
  readThrough,
  SERVED_VERSION,
  readerWithHeldPayloadFetch,
  inlinePayloadRead,
} from "#test/helpers/artifact-list-readers.js";

/** The preview text the reading holds, or an empty string while it holds another arm. */
function fetchedText(reader: ArtifactListReader): string {
  const { payload } = reader.snapshot;
  return payload?.status === "text" ? payload.text : "";
}

describe("artifact list actions: one payload fetch in flight, each with its own identity", () => {
  it("sends one fetch for two presses, and refuses the second in words", async () => {
    // Two fetches in flight could settle out of order and overwrite the newer bytes.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.fetchPayload(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    await expect(reader.fetchPayload(OTHER_ARTIFACT_ID)).rejects.toThrow("already in flight");

    expect(artifactRead).toHaveBeenCalledTimes(1);
    expect(reader.snapshot.payload).toStrictEqual({
      status: "fetching",
      artifactId: SERVED_SUMMARY.id,
    });

    releaseRead(inlinePayloadRead(SERVED_SUMMARY.id, "the first press"));
    expect((await firstPress).status).toBe("settled");
    expect(fetchedText(reader)).toBe("the first press");
  });

  it("drops a settlement whose request the register has given up", async () => {
    // A disposal supersedes the register; a write anyway would publish onto an unmounted section.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    reader.dispose();
    releaseRead(inlinePayloadRead(SERVED_SUMMARY.id, "an answer nobody is waiting for"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(reader.snapshot.payload).toStrictEqual({
      status: "fetching",
      artifactId: SERVED_SUMMARY.id,
    });
  });

  it("negative control: a list refresh mid-fetch keeps the fetch and its answer", async () => {
    // Without this the register could be the refresh stamp: the fetch would return
    // `superseded` and leave the reading on `fetching` with the control held forever.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    reader.refresh();
    await readThrough(clock);
    expect(reader.performCount).toBe(2);

    releaseRead(inlinePayloadRead(SERVED_SUMMARY.id, "the bytes the press asked for"));

    expect((await press).status).toBe("settled");
    expect(fetchedText(reader)).toBe("the bytes the press asked for");
  });

  it(
    "negative control: the register is given back, so a later press " +
      "is sent rather than refused",
    async () => {
      // Without this a register never released would reject every later fetch.
      const clock = new ManualClock();
      const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
      reader.start();
      await readThrough(clock);

      const firstPress = reader.fetchPayload(SERVED_SUMMARY.id);
      await crossMacrotaskBoundary();
      releaseRead(inlinePayloadRead(SERVED_SUMMARY.id, "first"));
      await firstPress;

      const secondPress = reader.fetchPayload(SERVED_SUMMARY.id);
      await crossMacrotaskBoundary();
      releaseRead(inlinePayloadRead(SERVED_SUMMARY.id, "second"));

      expect((await secondPress).status).toBe("settled");
      expect(artifactRead).toHaveBeenCalledTimes(2);
      expect(fetchedText(reader)).toBe("second");
    },
  );

  it("propagates a rejected fetch and gives the control back", async () => {
    // A rejected call leaves nothing to answer `fetching`, so the reading returns to no payload.
    const clock = new ManualClock();
    const artifactRead = vi
      .fn<ReadArtifact>()
      .mockRejectedValueOnce(new Error("the read failed"))
      .mockResolvedValueOnce(inlinePayloadRead(SERVED_SUMMARY.id, "the retry"));
    const reader = new ArtifactListReader({
      listArtifacts: async () => LISTED_ONE_ROW,
      readArtifact: artifactRead,
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      ownerWindow: window,
      clock,
    });
    reader.start();
    await readThrough(clock);

    await expect(reader.fetchPayload(SERVED_SUMMARY.id)).rejects.toThrow("the read failed");
    expect(reader.snapshot.payload).toBeUndefined();

    expect((await reader.fetchPayload(SERVED_SUMMARY.id)).status).toBe("settled");
    expect(fetchedText(reader)).toBe("the retry");
  });

  it("reads a payload too large for one message window by window, and draws it whole", async () => {
    // A first reply that hands back a key rather than the bytes is not the payload; the section
    // draws the bytes it was asked for.
    const clock = new ManualClock();
    const artifactRead = vi.fn<ReadArtifact>(async (request) =>
      request.range === undefined
        ? {
            manifest: { ...SERVED_SUMMARY, size: 5 },
            ...SERVED_VERSION,
            payloadHandle: "sha256:2b4c",
          }
        : inlinePayloadRead(SERVED_SUMMARY.id, "whole"),
    );
    const reader = new ArtifactListReader({
      listArtifacts: async () => LISTED_ONE_ROW,
      readArtifact: artifactRead,
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      ownerWindow: window,
      clock,
    });
    reader.start();
    await readThrough(clock);

    expect((await reader.fetchPayload(SERVED_SUMMARY.id)).status).toBe("settled");
    expect(fetchedText(reader)).toBe("whole");
    expect(artifactRead).toHaveBeenLastCalledWith({
      artifactId: SERVED_SUMMARY.id,
      version: SERVED_VERSION.versionNumber,
      includePayload: true,
      range: { offset: 0, length: 5 },
    });
  });
});
