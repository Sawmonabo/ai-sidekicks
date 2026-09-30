// When an upload lets go of the user's bytes, and when it may not. A `Blob` is a handle the
// browser keeps alive, so a staged list holding one per finished upload would pin ten files of
// memory until the composer unmounts. The rule: an entry holds the bytes only while a send is
// still possible, so a refused upload can be retried in place.

import { ARTIFACT_CHUNK_MAX_BYTES, type ArtifactId } from "@ai-sidekicks/contracts";

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { AttachmentIngestEntries } from "./attachment-ingest-entries.js";
import {
  SMALL_SOURCE,
  ScriptedIngestPort,
  clientOver,
  sourceOver,
} from "@test/helpers/scripted-ingest-port.js";
import {
  ATTACHMENT_INGEST_STATES,
  SENDING_ATTACHMENT_INGEST_STATES,
  attachmentSourceFrom,
  isSendingAttachmentIngestState,
  type AttachmentIngestEntry,
  type AttachmentIngestRecord,
} from "./attachment-shapes.js";

/**
 * Whether this entry carries a payload, read as a property of the object: `payload === undefined`
 * would also pass over a member holding `undefined`, a different shape.
 */
function holdsPayload(entry: AttachmentIngestEntry | undefined): boolean {
  return entry !== undefined && Object.hasOwn(entry, "payload");
}

describe("attachment payload release — a finished upload lets the bytes go", () => {
  it("releases the payload when the ingest completes", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("complete");
    // The artifact is minted, so nothing is left to send. The member is absent, not emptied.
    expect(holdsPayload(entry)).toBe(false);
    expect(entry?.payload).toBeUndefined();
    // Everything a card reads survives: the name, the declared size and the derived truth.
    expect(entry?.declared.declaredName).toBe("notes.md");
    expect(entry?.declared.byteLength).toBe(300);
    expect(entry?.derived?.artifactId).toBe("artifact-9");
    expect(entry?.derived?.fileName).toBe("notes-1.md");
  });

  it("releases the payload when a user stops sending", async () => {
    // Abandonment is terminal too: nothing will send these bytes, and holding them would keep
    // a canceled file alive.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.holdChunks();
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    client.abandon("attachment-1");
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("abandoned");
    expect(holdsPayload(entry)).toBe(false);
  });

  it("keeps the payload on a refused entry, so the retry has bytes to send", async () => {
    // The half a release rule gets wrong first: every disposition offers a retry, which
    // resends bytes an entry that let go could not produce.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.acknowledgeChunksWith({ ingestId: "ingest-1", receivedBytes: 0 });
    client.attach(sourceOver("attachment-two", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();

    const [refused] = client.snapshot;
    expect(refused?.state).toBe("refused");
    expect(holdsPayload(refused)).toBe(true);

    // The retry actually sends: the chunks on the wire after it are the proof.
    port.acknowledgeChunksWith(undefined);
    client.retry("attachment-two");
    await crossMacrotaskBoundary();

    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.chunkCalls).toHaveLength(3);
  });

  it("offers no retry once the upload has completed", async () => {
    // The card draws the control only on `refused`, and the client holds the same rule: a retry
    // reaching a completed entry would run the finished stream through the protocol again.
    // Counted as publications, the stronger claim: such a retry sends no chunk yet would still
    // complete the stream a second time.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();
    expect(client.snapshot[0]?.state).toBe("complete");

    let publishCount = 0;
    client.subscribe(() => {
      publishCount += 1;
    });
    client.retry("attachment-1");
    await crossMacrotaskBoundary();

    expect(publishCount).toBe(0);
    expect(client.snapshot[0]?.state).toBe("complete");
    expect(port.initCalls).toHaveLength(1);
    expect(port.chunkCalls).toHaveLength(1);
  });

  it("writes nothing when a settled entry is asked back into a sending state", () => {
    // The backstop under the guard above, driven at the one writer: those bytes are gone, so a
    // write is refused now rather than failing at the next slice.
    const ledger = new AttachmentIngestEntries();
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
        artifactId: "artifact-1" as ArtifactId,
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 300,
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
    // Nothing was written, so no round was superseded and an earlier stamp still recognizes
    // this entry.
    expect(ledger.currentIfUnchanged("attachment-1", stampAfterCompletion)).toBeDefined();
  });

  it("negative control: an upload still in flight is holding the bytes", async () => {
    // Without this every absence above would pass over a ledger that never carried a payload.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    port.holdChunks();
    client.attach(sourceOver("attachment-two", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("ingesting");
    expect(holdsPayload(entry)).toBe(true);
  });

  it("partitions the ingest states, so neither arm of the entry can be missed", () => {
    // The union's arms are keyed on this split and only the sending half is listed, so it is
    // asserted against the parent set: a state added to neither list would land in the settled
    // arm silently.
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
