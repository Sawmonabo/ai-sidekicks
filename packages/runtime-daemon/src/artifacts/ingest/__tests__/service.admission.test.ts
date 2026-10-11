// Opening a stream is admitted against the open-stream bound and the disk's free room less the
// open streams' reservations, one opening at a time. A refusal creates nothing, which shows in the
// next opening: it admits once the slot or the room is freed. A declaration the disk could not hold
// with no other stream open is refused as too large, naming the file and the room.

import { setTimeout } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_ACTIVE_INGEST_STREAMS } from "../limits.js";
import { openIngestHarness, type IngestHarness } from "./service.test-support.js";

const CAPACITY_EXHAUSTED = { code: "artifact.ingest_capacity_exhausted" };

let harness: IngestHarness;

afterEach(async () => {
  await harness.close();
});

// Ends an open stream the way a client's broken sequence does.
async function endStream(ingestId: string): Promise<void> {
  await expect(harness.chunk(ingestId, 5, Uint8Array.of(1))).rejects.toMatchObject({
    code: "artifact.ingest_stream_invalid",
  });
}

describe("opening an ingest stream", () => {
  it("is refused at the open-stream bound, and admitted once a stream ends", async () => {
    harness = await openIngestHarness();
    const open: string[] = [];
    for (let index = 0; index < MAX_ACTIVE_INGEST_STREAMS; index += 1) {
      open.push((await harness.init(10)).ingestId);
    }

    await expect(harness.init(10)).rejects.toMatchObject(CAPACITY_EXHAUSTED);
    await endStream(open[0] ?? "");

    await expect(harness.init(10)).resolves.toMatchObject({ ingestId: expect.any(String) });
    await expect(harness.init(10)).rejects.toMatchObject(CAPACITY_EXHAUSTED);
  });

  it("is refused with no room beside the open reservations, and admitted once freed", async () => {
    harness = await openIngestHarness({ readVolumeFreeBytes: () => Promise.resolve(1_000) });
    const { ingestId: firstId } = await harness.init(600);

    await expect(harness.init(500)).rejects.toMatchObject(CAPACITY_EXHAUSTED);
    await endStream(firstId);
    await harness.init(500);

    await expect(harness.init(600)).rejects.toMatchObject(CAPACITY_EXHAUSTED);
    await expect(harness.init(500)).resolves.toMatchObject({ ingestId: expect.any(String) });
  });

  it("is refused as too large past the disk's room, naming the file and the room", async () => {
    harness = await openIngestHarness({ readVolumeFreeBytes: () => Promise.resolve(1_000) });

    await expect(harness.init(1_001, "backup.tar")).rejects.toMatchObject({
      code: "artifact.too_large",
      detail: { fileName: "backup.tar", availableBytes: 1_000 },
    });
    await expect(harness.init(1_000)).resolves.toMatchObject({ ingestId: expect.any(String) });
  });

  it.each([
    {
      bound: "the last slot",
      freeBytes: 2 ** 40,
      alreadyOpen: MAX_ACTIVE_INGEST_STREAMS - 1,
      declaredSizeBytes: 10,
    },
    {
      bound: "the last room on the disk",
      freeBytes: 1_000,
      alreadyOpen: 0,
      declaredSizeBytes: 600,
    },
  ])(
    "admits exactly one of two openings racing for $bound",
    async ({ freeBytes, alreadyOpen, declaredSizeBytes }) => {
      // The room read yields to the timers, so an opening not held out would read beside the other.
      harness = await openIngestHarness({
        readVolumeFreeBytes: async () => {
          await setTimeout(5);
          return freeBytes;
        },
      });
      for (let index = 0; index < alreadyOpen; index += 1) {
        await harness.init(declaredSizeBytes);
      }

      const outcomes = await Promise.allSettled([
        harness.init(declaredSizeBytes),
        harness.init(declaredSizeBytes),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toStrictEqual([
        { status: "rejected", reason: expect.objectContaining(CAPACITY_EXHAUSTED) },
      ]);
    },
  );
});
