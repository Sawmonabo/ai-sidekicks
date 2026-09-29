// The payload fetch's single flight, driven through the reader that hosts it.
//
// The reading holds one payload, which is what these cases assert: a second press never
// reaches the port while a fetch is out, a settlement the register has moved past is
// dropped, and a list refresh landing under a fetch neither cancels it nor loses its answer.

import { describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { ReadArtifact } from "./services/artifact-reads.js";
import { ArtifactPaneReader } from "./artifact-list-reader.js";
import {
  LISTED_ONE_ROW,
  SESSION_ID,
  OTHER_ARTIFACT_ID,
  SERVED_SUMMARY,
  readThrough,
  readerWithHeldPayloadFetch,
  inlinePayloadRead,
} from "@test/helpers/artifact-list-readers.js";

/** The preview text the reading holds, or an empty string while it holds another arm. */
function fetchedText(reader: ArtifactPaneReader): string {
  const { payload } = reader.snapshot;
  return payload?.status === "text" ? payload.text : "";
}

describe("artifact pane actions — one payload fetch in flight, each with its own identity", () => {
  it("sends one fetch when the control is pressed twice, and refuses the second in words", async () => {
    // Two fetches in flight are two downloads, and the older answer could overwrite the
    // newer bytes and the newer manifest beside them.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.fetchPayload(SERVED_SUMMARY.id);
    await crossMacrotaskBoundary();
    await expect(reader.fetchPayload(OTHER_ARTIFACT_ID)).rejects.toThrow("already in flight");

    expect(artifactRead).toHaveBeenCalledTimes(1);
    // The payload arm still belongs to the fetch that is genuinely outstanding.
    expect(reader.snapshot.payload).toStrictEqual({
      status: "fetching",
      artifactId: SERVED_SUMMARY.id,
    });

    releaseRead(inlinePayloadRead(SERVED_SUMMARY.id, "the first press"));
    expect((await firstPress).status).toBe("settled");
    expect(fetchedText(reader)).toBe("the first press");
  });

  it("drops a settlement whose request the register has given up", async () => {
    // A disposal takes the register out from under a continuation, and an answer that
    // writes anyway would publish onto a pane that unmounted.
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

  it("negative control: a list refresh under a fetch neither cancels it nor loses its answer", async () => {
    // Without this the register could be the refresh stamp: a refresh landing under a fetch
    // would return `superseded` and publish nothing, leaving the reading on `fetching` with
    // no answer ever coming and the control held forever.
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

  it("negative control: the register is given back, so a later press is sent rather than refused", async () => {
    // Without this a register taken and never released would pass every case above and
    // reject the second fetch a user ever asks for, for the life of the pane.
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
  });

  it("propagates a rejected fetch and gives the control back", async () => {
    // A call that rejected leaves nothing to answer the `fetching` arm, so the reading
    // goes back to no payload and the next press is sent.
    const clock = new ManualClock();
    const artifactRead = vi
      .fn<ReadArtifact>()
      .mockRejectedValueOnce(new Error("the read failed"))
      .mockResolvedValueOnce(inlinePayloadRead(SERVED_SUMMARY.id, "the retry"));
    const reader = new ArtifactPaneReader({
      listArtifacts: async () => LISTED_ONE_ROW,
      readArtifact: artifactRead,
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      clock,
    });
    reader.start();
    await readThrough(clock);

    await expect(reader.fetchPayload(SERVED_SUMMARY.id)).rejects.toThrow("the read failed");
    expect(reader.snapshot.payload).toBeUndefined();

    expect((await reader.fetchPayload(SERVED_SUMMARY.id)).status).toBe("settled");
    expect(fetchedText(reader)).toBe("the retry");
  });
});
