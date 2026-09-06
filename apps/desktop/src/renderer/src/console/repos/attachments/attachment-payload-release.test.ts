// When an upload lets go of the participant's bytes, and when it may not.
//
// A `Blob` is a handle rather than a copy, but it is a KEEP: the browser holds the file
// behind it for as long as anything can reach it. The carrier held one per attachment
// and released none, so ten finished uploads pinned ten files' worth of memory until
// the surface unmounted — invisible, because every figure on the card is a number the
// ledger already had.
//
// The rule the cases below hold the ledger to is one sentence: an entry holds the bytes
// while — and only while — a send is still possible from where it stands. The retry
// cases are the other half of it, because a rule that released too early would be just
// as wrong: a refused upload is retried in place, and it can only replay bytes it still
// has.

import { describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../bridge/fixture-bridge.test-support.js";
import { ATTACHMENT_CHUNK_BYTE_CAP } from "../../core/index.js";
import { AttachmentIngestLedger } from "./attachment-ingest-ledger.js";
import {
  SMALL_SOURCE,
  ScriptedGrowthPort,
  clientOver,
  sourceOver,
} from "./attachment-ingest-scripted-port.test-support.js";
import {
  ATTACHMENT_INGEST_STATES,
  SENDING_ATTACHMENT_INGEST_STATES,
  attachmentSourceFrom,
  isSendingAttachmentIngestState,
  type AttachmentIngestEntry,
  type AttachmentIngestRecord,
} from "./attachment-shapes.js";

/**
 * Whether this entry is still carrying bytes — read as a PROPERTY of the object.
 *
 * `entry.payload === undefined` would also pass over an entry that carried the member
 * holding `undefined`, which is a different shape and a different claim. The settled arm
 * has no such member at all, and that is what is being asserted.
 */
function holdsPayload(entry: AttachmentIngestEntry | undefined): boolean {
  return entry !== undefined && Object.hasOwn(entry, "payload");
}

describe("attachment payload release — a finished upload lets the bytes go", () => {
  it("releases the payload when the ingest completes", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("complete");
    // The artifact is minted, so there is nothing left to send and nothing left to
    // send it FROM. The member is absent rather than emptied: a completed entry has
    // nowhere to put a `Blob`.
    expect(holdsPayload(entry)).toBe(false);
    expect(entry?.payload).toBeUndefined();
    // Everything a card reads survives, which is why the release costs no surface: the
    // name, the declared size, and the derived truth are all still here.
    expect(entry?.declared.declaredName).toBe("notes.md");
    expect(entry?.declared.byteLength).toBe(300);
    expect(entry?.derived?.artifactId).toBe("artifact-9");
    expect(entry?.derived?.normalizedName).toBe("notes-1.md");
  });

  it("releases the payload when a participant stops sending", async () => {
    // Abandonment is terminal in the other direction: the daemon's reaper claims the
    // spool and no artifact is minted, so nothing here will ever send these bytes
    // either. Holding them would keep a file alive for an upload somebody cancelled.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith("wire-unregistered");
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    client.abandon("attachment-1");
    await drainMicrotasks();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("abandoned");
    expect(holdsPayload(entry)).toBe(false);
  });

  it("keeps the payload on a refused entry, which is what makes the retry a replay", async () => {
    // The half a release rule gets wrong first. Every refusal disposition offers a
    // retry, and a retry resends from the ledger's own offset — over bytes an entry
    // that had let go of its payload could not produce.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.refuseChunksWith("artifact.ingest_capacity_exhausted");
    client.attach(sourceOver("attachment-two", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2));
    await drainMicrotasks();

    const [refused] = client.snapshot;
    expect(refused?.state).toBe("refused");
    expect(holdsPayload(refused)).toBe(true);

    // And the retry actually sends: the assertion above would be satisfied by a handle
    // nothing could read, so the proof is a second chunk on the wire.
    port.refuseChunksWith(undefined);
    client.retry("attachment-two");
    await drainMicrotasks();

    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.chunkCalls).toHaveLength(3);
  });

  it("offers no retry once the upload has completed", async () => {
    // The card only draws the control on `refused`, and this is the same rule at the
    // client: a completed entry has released its bytes, so a retry that reached it
    // would put the finished stream through the protocol a second time.
    //
    // Counted as PUBLICATIONS rather than as calls, because the calls are the weaker
    // claim: a retry from `complete` re-enters at an offset that is already the whole
    // payload, so it sends no chunk and still completes the stream again — which is a
    // second `AttachmentIngestComplete` for one artifact and a ledger write behind it.
    // A retry that did nothing publishes nothing.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();
    expect(client.snapshot[0]?.state).toBe("complete");

    let publishCount = 0;
    client.subscribe(() => {
      publishCount += 1;
    });
    client.retry("attachment-1");
    await drainMicrotasks();

    expect(publishCount).toBe(0);
    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.initCalls).toHaveLength(1);
    expect(port.chunkCalls).toHaveLength(1);
  });

  it("writes nothing when a settled entry is asked back into a sending state", () => {
    // The backstop under the guard above, stated at the one writer and driven against
    // it directly. Those bytes are gone, so an entry claiming a payload it does not
    // have would fail at its next slice instead of here — a write refused now is a
    // state no card ever renders.
    const ledger = new AttachmentIngestLedger();
    ledger.declare(
      attachmentSourceFrom({
        localId: "attachment-1",
        declaredName: "notes.md",
        payload: new Blob([new Uint8Array(300)]),
      }),
    );
    const completedRecord: AttachmentIngestRecord = {
      state: "complete",
      receivedBytes: 300,
      ingestId: "ingest-1",
      derived: {
        artifactId: "artifact-1",
        normalizedName: "notes.md",
        derivedMediaType: "text/markdown",
        derivedSizeBytes: 300,
      },
      refusal: undefined,
      disposition: undefined,
      openedAtMilliseconds: 1_000,
      lastProgressAtMilliseconds: 1_000,
    };
    ledger.write("attachment-1", completedRecord);
    expect(holdsPayload(ledger.current("attachment-1"))).toBe(false);

    const stampAfterCompletion = ledger.stamp("attachment-1");
    if (stampAfterCompletion === undefined) {
      throw new Error("the ledger held no entry to stamp");
    }
    ledger.write("attachment-1", { ...completedRecord, state: "declared" });

    expect(ledger.current("attachment-1")?.state).toBe("complete");
    // Nothing was written, so no round was superseded: a continuation holding the
    // earlier stamp still recognises this entry rather than reading it as one that
    // moved.
    expect(ledger.currentIfUnchanged("attachment-1", stampAfterCompletion)).toBeDefined();
  });

  it("negative control: an upload still in flight is holding the bytes", async () => {
    // Without this every absence above would pass over a ledger that had never carried
    // a payload at all — which would report a stream that cannot send as a release.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.holdChunks();
    client.attach(sourceOver("attachment-two", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2));
    await drainMicrotasks();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("ingesting");
    expect(holdsPayload(entry)).toBe(true);
  });

  it("partitions the ingest states, so neither arm of the entry can be missed", () => {
    // The union's two arms are keyed on this split, and only the sending half is
    // written down — the settled half is its complement. A state added to the
    // vocabulary and to neither list would land in the settled arm silently, so the
    // split is asserted against the parent set rather than against a copy of it.
    const sending = ATTACHMENT_INGEST_STATES.filter((state) =>
      isSendingAttachmentIngestState(state),
    );
    expect(sending).toStrictEqual([...SENDING_ATTACHMENT_INGEST_STATES]);
    const settled = ATTACHMENT_INGEST_STATES.filter(
      (state) => !isSendingAttachmentIngestState(state),
    );
    expect(settled).toStrictEqual(["complete", "abandoned"]);
    expect(sending.length + settled.length).toBe(ATTACHMENT_INGEST_STATES.length);
  });
});
