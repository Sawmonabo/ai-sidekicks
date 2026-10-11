// Chunks are taken in sequence: a resend of the last one, alone or racing its original, is answered
// without appending it again; a gap, a regression or a resent number with other bytes ends the
// stream, and every later call on it is refused; and a chunk past the declared size ends it as too
// large, while a stream that sent less completes at the size it sent.

import { afterEach, describe, expect, it } from "vitest";

import { contentHashOf, openIngestHarness, type IngestHarness } from "./service.test-support.js";

const STREAM_INVALID = { code: "artifact.ingest_stream_invalid" };
const FIRST = new TextEncoder().encode("first chunk;");
const SECOND = new TextEncoder().encode("second chunk;");
const BOTH = new Uint8Array([...FIRST, ...SECOND]);

let harness: IngestHarness;

afterEach(async () => {
  await harness.close();
});

describe("a stream's chunks", () => {
  it("answer a resend of the last chunk without appending it again", async () => {
    harness = await openIngestHarness();
    const { ingestId } = await harness.init(BOTH.length);
    await harness.chunk(ingestId, 0, FIRST);
    await harness.chunk(ingestId, 1, SECOND);

    await expect(harness.chunk(ingestId, 1, SECOND)).resolves.toStrictEqual({
      ingestId,
      receivedBytes: BOTH.length,
    });

    expect(await harness.spooledBytes(ingestId)).toStrictEqual(Buffer.from(BOTH));
    await expect(harness.complete(ingestId)).resolves.toMatchObject({
      contentHash: contentHashOf(BOTH),
      derivedSizeBytes: BOTH.length,
    });
  });

  it("append an original and its racing resend once", async () => {
    harness = await openIngestHarness();
    const { ingestId } = await harness.init(BOTH.length);

    const acknowledgements = await Promise.all([
      harness.chunk(ingestId, 0, FIRST),
      harness.chunk(ingestId, 0, FIRST),
    ]);

    expect(acknowledgements.map((acknowledgement) => acknowledgement.receivedBytes)).toStrictEqual([
      FIRST.length,
      FIRST.length,
    ]);
    expect(await harness.spooledBytes(ingestId)).toStrictEqual(Buffer.from(FIRST));
  });

  it.each([
    { violation: "a gap", sequenceNumber: 3, bytes: SECOND },
    { violation: "a regression", sequenceNumber: 0, bytes: FIRST },
    { violation: "a resent number with other bytes", sequenceNumber: 1, bytes: FIRST },
  ])(
    "end the stream on $violation, refusing every later call",
    async ({ sequenceNumber, bytes }) => {
      harness = await openIngestHarness();
      const { ingestId } = await harness.init(BOTH.length * 2);
      await harness.chunk(ingestId, 0, FIRST);
      await harness.chunk(ingestId, 1, SECOND);

      await expect(harness.chunk(ingestId, sequenceNumber, bytes)).rejects.toMatchObject(
        STREAM_INVALID,
      );

      expect(await harness.spooledBytes(ingestId)).toBeUndefined();
      await expect(harness.chunk(ingestId, 2, FIRST)).rejects.toMatchObject(STREAM_INVALID);
      await expect(harness.complete(ingestId)).rejects.toMatchObject(STREAM_INVALID);
      expect(harness.manifestRows()).toStrictEqual([]);
    },
  );

  it("end the stream past its declaration, and complete at the size sent", async () => {
    harness = await openIngestHarness();
    const { ingestId: overrunId } = await harness.init(FIRST.length + 1, "draft.txt");
    await harness.chunk(overrunId, 0, FIRST);

    await expect(harness.chunk(overrunId, 1, SECOND)).rejects.toMatchObject({
      code: "artifact.too_large",
      detail: { fileName: "draft.txt", declaredSizeBytes: FIRST.length + 1 },
    });
    expect(await harness.spooledBytes(overrunId)).toBeUndefined();
    await expect(harness.chunk(overrunId, 1, Uint8Array.of(1))).rejects.toMatchObject(
      STREAM_INVALID,
    );

    const { ingestId: shortId } = await harness.init(BOTH.length);
    await harness.chunk(shortId, 0, FIRST);
    await expect(harness.complete(shortId)).resolves.toMatchObject({
      derivedSizeBytes: FIRST.length,
    });
  });
});
