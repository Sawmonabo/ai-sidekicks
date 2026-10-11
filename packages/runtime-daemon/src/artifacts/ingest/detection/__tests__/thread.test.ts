// A detector that never returns holds only its own thread: the daemon goes on answering while it
// spins, and at the time bound the thread is terminated and the ingest refused for good, its spool
// deleted and nothing kept.

import { afterEach, describe, expect, it } from "vitest";

import { NEVER_RETURNING_DETECTOR_URL } from "../../__fixtures__/never-returning-detector.js";
import {
  openIngestHarness,
  PNG_SIGNATURE,
  type IngestHarness,
} from "../../__tests__/service.test-support.js";
import { createThreadedDetector } from "../thread.js";

let harness: IngestHarness;

afterEach(async () => {
  await harness.close();
});

describe("a detector that never returns", () => {
  it("fails its ingest at the time bound while the daemon goes on answering", async () => {
    harness = await openIngestHarness({
      detectMediaType: createThreadedDetector(NEVER_RETURNING_DETECTOR_URL),
    });
    const { ingestId } = await harness.init(PNG_SIGNATURE.length, "scan.png");
    await harness.chunk(ingestId, 0, PNG_SIGNATURE);

    let isCompleteSettled = false;
    const completing = harness.complete(ingestId).finally(() => {
      isCompleteSettled = true;
    });
    // Answered while the detector spins, which a detector on the daemon's own thread would block.
    const other = await harness.init(1, "notes.txt");
    expect(other.ingestId).not.toBe(ingestId);
    expect(isCompleteSettled).toBe(false);

    await expect(completing).rejects.toMatchObject({
      code: "artifact.type_unreadable",
      detail: { fileName: "scan.png" },
    });
    expect(await harness.spooledBytes(ingestId)).toBeUndefined();
    expect(await harness.storedPayloads()).toStrictEqual([]);
    expect(harness.manifestRows()).toStrictEqual([]);
  });
});
