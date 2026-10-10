// The drawing queue every diagram block shares, against stand-in workers: which drawing goes
// first, what is never sent, what is never kept, the worker started again after its library
// fails, it stops, or it stops answering, and when the caches shown pictures filled are emptied.

import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { DiagramPalette } from "./palette.js";
import { DiagramPictures } from "./pictures.js";
import { drawnOutcome, FakeDiagramWorkers } from "./worker/connection.test-support.js";
import { DRAWING_DEADLINE_MS, type DiagramOutcome } from "./worker/messages.js";

const PALETTE: DiagramPalette = {
  identity: "test",
  isDark: false,
  groundColor: "#ffffff",
  fontFamily: "system-ui",
  fontSizePx: 13,
  colors: {},
};

/** How long a new worker may take to load merman before it is ended, in milliseconds. */
const LOAD_DEADLINE_MS = 10_000;

/** A share far larger than these cases draw. */
const CACHE_BYTE_CAP = 16 * 1024 * 1024;

/** Leaves the renderer's caches alone: no case here shows enough pictures to empty them for. */
const keepUnusedMemory = (): void => undefined;

/** Lets the queue choose its next drawing, which it does once the turn's asks have arrived. */
async function settleQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function sentSources(workers: FakeDiagramWorkers): string[] {
  return workers.started.flatMap((worker) => worker.requests.map((request) => request.source));
}

/** Asks for `source`, from a block `distance` pixels from reading, and keeps what it hears. */
function requestInto(
  pictures: DiagramPictures,
  source: string,
  heard: DiagramOutcome[],
  distance = 0,
): () => void {
  const listener = (outcome: DiagramOutcome) => heard.push(outcome);
  return pictures.request(source, PALETTE, () => distance, listener);
}

describe("the diagram queue", () => {
  it("draws one at a time, the nearest first, and never a withdrawn one", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const heard: DiagramOutcome[] = [];
    requestInto(pictures, "far", heard, 900);
    const withdrawLeft = requestInto(pictures, "left", heard, 0);
    requestInto(pictures, "near", heard, 40);
    withdrawLeft();
    await settleQueue();
    expect(sentSources(workers)).toStrictEqual(["near"]);

    workers.latest().answer(drawnOutcome("near"));
    await settleQueue();
    expect(sentSources(workers)).toStrictEqual(["near", "far"]);
    workers.latest().answer(drawnOutcome("far"));
    await settleQueue();
    expect(sentSources(workers)).toStrictEqual(["near", "far"]);
    expect(heard).toStrictEqual([drawnOutcome("near"), drawnOutcome("far")]);
  });

  it("discards a picture that lands after every block that asked has gone", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const heard: DiagramOutcome[] = [];
    const withdraw = requestInto(pictures, "late", heard);
    await settleQueue();
    withdraw();
    workers.latest().answer(drawnOutcome("late"));
    await settleQueue();

    expect(heard).toStrictEqual([]);
    expect(pictures.read("late", PALETTE)).toBeUndefined();
  });

  it("ends a worker whose library failed, keeps nothing of it, and starts another", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const heard: DiagramOutcome[] = [];
    requestInto(pictures, "first", heard);
    await settleQueue();
    const failedDrawing = workers.latest();
    failedDrawing.load();
    failedDrawing.answer({ libraryFailure: "unreachable executed" });
    await settleQueue();
    requestInto(pictures, "second", heard);
    await settleQueue();
    const failedLoad = workers.latest();
    // The new worker has not loaded merman, so its drawing's deadline has not started.
    vi.advanceTimersByTime(3 * DRAWING_DEADLINE_MS);
    expect(failedLoad.isTerminated).toBe(false);
    failedLoad.load("compile error");
    await settleQueue();

    expect(failedDrawing.isTerminated).toBe(true);
    expect(failedLoad.isTerminated).toBe(true);
    expect(heard).toStrictEqual([
      { kind: "failed", reason: "The diagram library failed: unreachable executed" },
      { kind: "failed", reason: "The diagram library failed: compile error" },
    ]);
    expect(pictures.read("first", PALETTE)).toBeUndefined();
    expect(pictures.read("second", PALETTE)).toBeUndefined();

    requestInto(pictures, "third", heard);
    await settleQueue();
    expect(workers.started).toHaveLength(3);
    workers.latest().answer(drawnOutcome("third"));
    await settleQueue();
    expect(pictures.read("third", PALETTE)?.kind).toBe("drawn");
  });

  it("shows a drawing that ran out of time, keeps none of it and draws it again", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const heard: DiagramOutcome[] = [];
    requestInto(pictures, "slow", heard);
    await settleQueue();
    const worker = workers.latest();
    worker.answer("timed-out");
    await settleQueue();

    expect(heard).toStrictEqual([{ kind: "failed", reason: "The diagram took too long to draw" }]);
    expect(pictures.read("slow", PALETTE)).toBeUndefined();
    // The moment's failure, not the worker's: the same worker draws it again when asked.
    requestInto(pictures, "slow", heard);
    await settleQueue();
    expect(worker.isTerminated).toBe(false);
    expect(sentSources(workers)).toStrictEqual(["slow", "slow"]);
  });

  it("ends a worker that stopped, failing the drawing it held", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const heard: DiagramOutcome[] = [];
    requestInto(pictures, "held", heard);
    await settleQueue();
    const stopped = workers.latest();
    stopped.onerror?.(new ErrorEvent("error", { message: "out of memory" }));
    await settleQueue();

    expect(stopped.isTerminated).toBe(true);
    expect(heard).toStrictEqual([
      { kind: "failed", reason: "The diagram worker stopped: out of memory" },
    ]);
  });

  it("ends a worker whose merman never loads, failing its drawing, and starts another", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const heard: DiagramOutcome[] = [];
    requestInto(pictures, "waiting", heard);
    await settleQueue();
    const neverLoaded = workers.latest();
    vi.advanceTimersByTime(LOAD_DEADLINE_MS);
    await settleQueue();

    expect(neverLoaded.isTerminated).toBe(true);
    expect(heard).toStrictEqual([
      { kind: "failed", reason: "The diagram library did not load in time" },
    ]);
    expect(pictures.read("waiting", PALETTE)).toBeUndefined();
    requestInto(pictures, "waiting", heard);
    await settleQueue();
    expect(workers.started).toHaveLength(2);
    // A worker that loaded in time is not ended by the load deadline.
    workers.latest().load();
    workers.latest().answer(drawnOutcome("waiting"));
    await settleQueue();
    vi.advanceTimersByTime(LOAD_DEADLINE_MS);
    expect(workers.latest().isTerminated).toBe(false);
    expect(pictures.read("waiting", PALETTE)?.kind).toBe("drawn");
  });

  it("ends a worker that stops answering, counting the deadline from merman's load", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, workers.start, keepUnusedMemory);
    const heard: DiagramOutcome[] = [];
    requestInto(pictures, "answered", heard);
    await settleQueue();
    const worker = workers.latest();
    // A worker still loading merman is given the time it needs.
    vi.advanceTimersByTime(3 * DRAWING_DEADLINE_MS);
    expect(worker.isTerminated).toBe(false);
    worker.load();
    worker.answer(drawnOutcome("answered"));
    await settleQueue();
    // An answered drawing's wait is cleared, so it never ends the worker that drew it.
    vi.advanceTimersByTime(2 * DRAWING_DEADLINE_MS);
    expect(worker.isTerminated).toBe(false);

    requestInto(pictures, "stuck", heard);
    await settleQueue();
    vi.advanceTimersByTime(DRAWING_DEADLINE_MS);
    expect(worker.isTerminated).toBe(false);
    vi.advanceTimersByTime(DRAWING_DEADLINE_MS);
    await settleQueue();

    expect(worker.isTerminated).toBe(true);
    expect(heard.at(-1)).toStrictEqual({
      kind: "failed",
      reason: "The diagram took too long to draw",
    });
    expect(pictures.read("stuck", PALETTE)).toBeUndefined();
  });

  it("empties the renderer's caches only once a large fall in the pictures shown has lasted", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let clearCount = 0;
    const pictures = new DiagramPictures(CACHE_BYTE_CAP, new FakeDiagramWorkers().start, () => {
      clearCount += 1;
    });
    // Each picture carries 200 KiB of markup.
    const show = (label: string) =>
      pictures.showPicture({
        ...drawnOutcome(label),
        markup: `<svg><text>${label}</text>${" ".repeat(200 * 1024)}</svg>`,
      });
    const first = ["a", "b", "c", "d"].map(show);
    // A large fall that comes back before the wait is over empties nothing.
    for (const showing of first.slice(0, 3)) {
      showing.release();
    }
    vi.advanceTimersByTime(29_000);
    const back = ["e", "f", "g"].map(show);
    vi.advanceTimersByTime(60_000);
    expect(clearCount).toBe(0);
    // Neither does a small fall, however long it lasts.
    back[0]?.release();
    vi.advanceTimersByTime(60_000);
    expect(clearCount).toBe(0);
    // A large fall that lasts empties them, once.
    for (const showing of [...back.slice(1), first[3]]) {
      showing?.release();
    }
    vi.advanceTimersByTime(30_000);
    expect(clearCount).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(clearCount).toBe(1);
  });
});
