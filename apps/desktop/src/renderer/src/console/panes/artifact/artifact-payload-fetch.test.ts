// The payload fetch's single flight, driven through the reader that hosts it.
//
// THE READING HOLDS ONE PAYLOAD, which is the whole of what these cases assert: two
// fetches racing put one artifact's bytes under another's name, so the second press is
// refused in words, a settlement the register has moved past is dropped, and a list
// refresh landing under a fetch neither cancels it nor loses its answer.
//
// A DELETE IS THE ONE THING THAT DOES SUPERSEDE IT, and that case is here rather than
// beside the delete because what it establishes is a property of this register: bytes
// belonging to a manifest the daemon has destroyed are not a reading anybody may
// publish, and clearing the payload arm alone does not stop the answer already on the
// wire.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import {
  OTHER_ARTIFACT_ID,
  SERVED_SUMMARY,
  listedRowIds,
  readThrough,
  readerWithHeldPayloadFetch,
  servedPayload,
  settle,
} from "./artifact-pane.test-support.js";

describe("artifact pane actions — one payload fetch in flight, each with its own identity", () => {
  it("sends one fetch when the control is pressed twice, and refuses the second in words", async () => {
    // The bug, exercised: both presses used to capture the same refresh stamp, both
    // reached the port, and both replies passed the supersession check — so the older
    // answer could overwrite the newer bytes AND the newer manifest beside them.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    const secondPress = await reader.fetchPayload(OTHER_ARTIFACT_ID);

    expect(artifactRead).toHaveBeenCalledTimes(1);
    expect(secondPress.status).toBe("refused");
    expect(secondPress.status === "refused" ? secondPress.refusal.code : undefined).toBe(
      "payload-fetch-in-flight",
    );
    // The sentence names the artifact the pane is WAITING on, not the one pressed.
    expect(secondPress.status === "refused" ? secondPress.refusal.detail : "").toContain(
      SERVED_SUMMARY.artifactId,
    );
    // The refusal stands beside the row it was pressed on; the payload arm still
    // belongs to the fetch that is genuinely outstanding.
    expect(reader.snapshot.refusalByArtifactId.get(OTHER_ARTIFACT_ID)?.code).toBe(
      "payload-fetch-in-flight",
    );
    expect(reader.snapshot.payload).toStrictEqual({
      status: "fetching",
      artifactId: SERVED_SUMMARY.artifactId,
    });

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the first press"));
    expect((await firstPress).status).toBe("settled");
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "the first press",
    );
  });

  it("drops a settlement whose request the register has given up", async () => {
    // The identity check, exercised. A disposal takes the register out from under a
    // continuation, and an answer that writes anyway would publish onto a pane that
    // unmounted — and, on a reader that had taken a successor, over its bytes.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    reader.dispose();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "an answer nobody is waiting for"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(reader.snapshot.payload).toStrictEqual({
      status: "fetching",
      artifactId: SERVED_SUMMARY.artifactId,
    });
  });

  it("negative control: a list refresh under a fetch neither cancels it nor loses its answer", async () => {
    // Without this the register above could have been the refresh stamp again, which
    // is what it used to be: a refresh landing under a fetch returned `superseded` and
    // published nothing, leaving the reading on the in-flight absence with no answer
    // ever coming — and, with the control held on that arm, held forever.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    reader.refresh();
    await readThrough(clock);
    expect(reader.performCount).toBe(2);

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the bytes the press asked for"));

    expect((await press).status).toBe("settled");
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "the bytes the press asked for",
    );
  });

  it("negative control: the register is given back, so a later press is sent rather than refused", async () => {
    // Without this a register that was taken and never released would pass every case
    // above and refuse the second fetch a participant ever asks for, for the life of
    // the pane.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const firstPress = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "first"));
    await firstPress;

    const secondPress = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "second"));

    expect((await secondPress).status).toBe("settled");
    expect(artifactRead).toHaveBeenCalledTimes(2);
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "second",
    );
  });
});

describe("artifact pane actions — a delete supersedes the fetch for the row it destroyed", () => {
  it("drops a payload settlement the delete overtook", async () => {
    // The bug, exercised: press Fetch, confirm Delete before the bytes arrive, and
    // let the read the daemon completed BEFORE the delete be delivered after it. The
    // publish cleared the visible payload and left the register alone, so the
    // continuation passed the identity check and put the destroyed manifest's bytes
    // back — and the reconciling list read carries a payload arm forward rather than
    // clearing it, so the stale preview stayed until somebody refreshed by hand.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    expect(reader.snapshot.payload.status).toBe("fetching");

    const deletion = await reader.deleteArtifact(SERVED_SUMMARY.artifactId);
    expect(deletion.status).toBe("settled");
    expect(reader.snapshot.payload).toStrictEqual({ status: "not-checked" });

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "bytes of a manifest that is gone"));

    expect(await press).toStrictEqual({ status: "superseded" });
    expect(reader.snapshot.payload).toStrictEqual({ status: "not-checked" });
    // And the row stays off the list: the late answer also carries a manifest, which
    // a republished payload would have brought back with it.
    expect(listedRowIds(reader)).toStrictEqual([]);
  });

  it("gives the control back, so the next artifact can be fetched at once", async () => {
    // The second symptom of the same untouched register. The reading said nothing
    // was being fetched while the register said one was, so the next press was
    // refused in words by a pane that was offering the control.
    const clock = new ManualClock();
    const { reader, artifactRead, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    void reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    await reader.deleteArtifact(SERVED_SUMMARY.artifactId);

    const nextPress = reader.fetchPayload(OTHER_ARTIFACT_ID);
    await settle();
    expect(artifactRead).toHaveBeenCalledTimes(2);
    releaseRead(servedPayload(OTHER_ARTIFACT_ID, "the next artifact's bytes"));
    expect((await nextPress).status).toBe("settled");
  });

  it("negative control: a delete of another row leaves the fetch standing", async () => {
    // Without this, clearing the register on every served delete would throw away
    // the answer to a fetch the delete says nothing about — a participant deleting
    // one artifact would silently lose the preview they had just asked for of
    // another, and the pane would report `superseded` for work it did do.
    const clock = new ManualClock();
    const { reader, releaseRead } = readerWithHeldPayloadFetch(clock);
    reader.start();
    await readThrough(clock);

    const press = reader.fetchPayload(SERVED_SUMMARY.artifactId);
    await settle();
    await reader.deleteArtifact(OTHER_ARTIFACT_ID);

    releaseRead(servedPayload(SERVED_SUMMARY.artifactId, "the bytes the press asked for"));

    expect((await press).status).toBe("settled");
    expect(reader.snapshot.payload.status === "text" ? reader.snapshot.payload.text : "").toBe(
      "the bytes the press asked for",
    );
  });
});
