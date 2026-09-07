// What the progress reading does when delivery STOPS, which is three different facts.
//
// The reading's four arms exist because a stream can be in four places, and the one a
// naive drain gets wrong is the fourth: an iterator that rejects part-way through an
// accepted import. Nothing on screen changes — the line sits on its last frame reading
// as though more were coming — while an unhandled rejection reaches the window and the
// subscription behind it is never closed. So the cases below drive a stream that
// breaks, and read all three of those: the arm, the handle, and the runner's own
// report of what escaped.
//
// The refusal is `normalizeWireRejection`'s and not this module's, and both of its
// arms are driven: a rejection that names its own code keeps it, and one that names
// nothing takes the sentence this family wrote for exactly that.
//
// THE HOOK ANSWERS A SUBSCRIPTION — the reading and the way back onto it — so these
// cases read the reading off it. What the second half does is the subject of
// `provider-import.single-flight.test.tsx`, which drives the guard and the re-attach
// together; splitting them keeps this file about the four arms it was written for.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DrivenGrowthStream } from "../../bridge/growth-port/driven-growth-stream.test-support.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import type { GrowthImportProgress, GrowthPort } from "../../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { unhandledRejectionsDuring } from "../../core/unhandled-rejection.test-support.js";
import { useImportProgress, type ImportProgressReading } from "./provider-import.js";

const IMPORT_ID = "provider-import-7";

const FIRST_FRAME: GrowthImportProgress = {
  importId: IMPORT_ID,
  turnsSeen: 12,
  state: "reading the transcript",
};

/** A port whose only served operation is the progress subscription this case drives. */
function portServing(stream: DrivenGrowthStream<GrowthImportProgress>): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    providerSessionImportSubscribe: async () =>
      await Promise.resolve({ status: "served", value: stream } as const),
  };
}

/** Mount the reading over a driven stream, and let its first frame land. */
async function readingOver(stream: DrivenGrowthStream<GrowthImportProgress>): Promise<{
  readonly current: () => ImportProgressReading;
}> {
  const port = portServing(stream);
  const { result } = renderHook(() => useImportProgress(port, IMPORT_ID));
  await act(async () => {
    stream.emit(FIRST_FRAME);
    await crossMacrotaskBoundary();
  });
  return { current: () => result.current.reading };
}

describe("useImportProgress — a stream that rejects part-way", () => {
  it("settles the reading as refused, closes the stream, and lets nothing escape", async () => {
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    let reading: ImportProgressReading | undefined;
    const escaped = await unhandledRejectionsDuring(async () => {
      const { current } = await readingOver(stream);
      await act(async () => {
        stream.fail(new Error("the import's progress subscription was torn down"));
        await crossMacrotaskBoundary();
      });
      reading = current();
    });

    // The half a person sees: delivery failed, and the line says so rather than
    // resting on the last frame it happened to receive.
    expect(reading?.status).toBe("refused");
    expect(reading).toMatchObject({
      refusal: {
        origin: "provider-import-progress",
        code: "import-progress-subscription-failed",
      },
    });
    // The half nobody sees: the subscription is let go of rather than left open
    // behind a reader that has stopped reading it.
    expect(stream.closeCount).toBe(1);
    // And the half only the runner sees, which is where this defect actually lived.
    expect(escaped).toStrictEqual([]);
  });

  it("keeps a refusal that names its own code rather than restating it", async () => {
    // `normalizeWireRejection` is what runs, and its pass-through arm is the more
    // informative of the two: replacing `bridge-torn-down` with this family's generic
    // sentence would throw away the only part a person can act on or search for.
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const { current } = await readingOver(stream);
    await act(async () => {
      stream.fail(
        new ConsoleRefusalError(
          refuse("preload", "bridge-torn-down", "The window's bridge was replaced mid-read."),
        ),
      );
      await crossMacrotaskBoundary();
    });

    expect(current()).toMatchObject({
      status: "refused",
      refusal: { origin: "preload", code: "bridge-torn-down" },
    });
  });

  it("negative control: a live stream stays open on its newest frame and is not closed", async () => {
    // Without this both cases above pass for a reading that refused every import and
    // closed every stream the moment it opened one.
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const { current } = await readingOver(stream);

    expect(current()).toStrictEqual({ status: "open", newest: FIRST_FRAME });
    expect(stream.closeCount).toBe(0);
  });
});
