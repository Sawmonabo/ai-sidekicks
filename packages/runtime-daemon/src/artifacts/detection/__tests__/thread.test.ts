// Type detection runs each payload on a thread of its own that the daemon ends. A detector that
// never returns holds only its thread: the daemon goes on answering, and at the time bound the
// thread is ended and the ingest told to send its completion again. A detector that allocates
// without end is stopped by its thread's heap bound, not the time bound, with nothing kept. Four
// threads run at once, each timed from its own start, a bounded number wait, and a stop refuses
// the waiting calls and ends the running threads.

import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ALLOCATING_DETECTOR_URL } from "../../__fixtures__/allocating-detector.js";
import { NEVER_RETURNING_DETECTOR_URL } from "../../__fixtures__/never-returning-detector.js";
import { SLEEPING_DETECTOR_URL } from "../../__fixtures__/sleeping-detector.js";
import {
  openIngestHarness,
  PNG_SIGNATURE,
  type IngestHarness,
} from "../../__tests__/harness.test-support.js";
import { ThreadedTypeDetector } from "../thread.js";

let harness: IngestHarness | undefined;
let detector: ThreadedTypeDetector | undefined;

afterEach(async () => {
  await detector?.stop();
  await harness?.close();
  detector = undefined;
  harness = undefined;
});

// The message ports this thread holds open; a running detection thread's holds one more.
function openMessagePorts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "MessagePort").length;
}

// The ASCII digits of `holdMs`, which the sleeping detector reads as how long to hold its thread.
function holdFor(holdMs: number): Uint8Array {
  return new TextEncoder().encode(String(holdMs));
}

describe("a detector that never returns", () => {
  it("is ended at the time bound while the daemon goes on answering", async () => {
    const threadedDetector = new ThreadedTypeDetector(NEVER_RETURNING_DETECTOR_URL);
    detector = threadedDetector;
    harness = await openIngestHarness({
      detectMediaType: () => (leadingBytes) => threadedDetector.detect(leadingBytes),
    });
    const portsBefore = openMessagePorts();
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
      code: "artifact.type_check_unavailable",
      detail: { fileName: "scan.png" },
    });
    expect(openMessagePorts()).toBe(portsBefore);
    expect(await harness.spooledBytes(ingestId)).toStrictEqual(Buffer.from(PNG_SIGNATURE));
    expect(await harness.storedPayloads()).toStrictEqual([]);
    expect(harness.manifestRows()).toStrictEqual([]);
  });
});

describe("a detector that allocates without end", () => {
  it("is stopped by its thread's heap bound, and the publish keeps nothing", async () => {
    const threadedDetector = new ThreadedTypeDetector(ALLOCATING_DETECTOR_URL);
    detector = threadedDetector;
    harness = await openIngestHarness({
      detectMediaType: () => (leadingBytes) => threadedDetector.detect(leadingBytes),
    });

    await expect(
      harness.publish({ artifactType: "summary", payload: "notes", mediaType: "text/plain" }),
    ).rejects.toMatchObject({
      code: "artifact.type_check_unavailable",
      cause: { code: "ERR_WORKER_OUT_OF_MEMORY" },
    });

    expect(await harness.spoolNames()).toStrictEqual([]);
    expect(await harness.storedPayloads()).toStrictEqual([]);
    expect(harness.manifestRows()).toStrictEqual([]);
  });
});

describe("the detection threads", () => {
  it("run four at once, each timed from its own start", async () => {
    const threadedDetector = new ThreadedTypeDetector(SLEEPING_DETECTOR_URL);
    detector = threadedDetector;
    const holdMs = 1_200;
    const startedAt = performance.now();

    const finishedAfterMs = await Promise.all(
      Array.from({ length: 5 }, async () => {
        await expect(threadedDetector.detect(holdFor(holdMs))).resolves.toBe("text/plain");
        return performance.now() - startedAt;
      }),
    );

    // The fifth waited for a thread, then held one for its own whole time bound's worth.
    expect(Math.max(...finishedAfterMs)).toBeGreaterThanOrEqual(holdMs * 2);
  });

  it("refuse a call past the waiting ones at once, and answer every call admitted", async () => {
    const threadedDetector = new ThreadedTypeDetector(SLEEPING_DETECTOR_URL);
    detector = threadedDetector;
    const admitted = Array.from({ length: 20 }, () => threadedDetector.detect(holdFor(50)));

    await expect(threadedDetector.detect(holdFor(50))).rejects.toThrow(/waiting/u);
    await expect(Promise.all(admitted)).resolves.toStrictEqual(Array(20).fill("text/plain"));
  });

  it("are ended by a stop, which refuses the waiting calls", async () => {
    const threadedDetector = new ThreadedTypeDetector(NEVER_RETURNING_DETECTOR_URL);
    const portsBefore = openMessagePorts();
    const detections = Array.from({ length: 5 }, () =>
      threadedDetector.detect(PNG_SIGNATURE).then(
        () => "answered",
        () => "refused",
      ),
    );
    // Long enough for four threads to be spinning, the fifth call waiting for one.
    await delay(500);

    await threadedDetector.stop();

    expect(openMessagePorts()).toBe(portsBefore);
    await expect(Promise.all(detections)).resolves.toStrictEqual(Array(5).fill("refused"));
    await expect(threadedDetector.detect(PNG_SIGNATURE)).rejects.toThrow(/stopped/u);
  });
});
