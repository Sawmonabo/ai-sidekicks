// A store whose trim fails refuses the write rather than rejecting it. The write path touches
// the adapter four times (the write, the trim under quota, the partition count that trim is
// sized from, and the housekeeping trim after a successful write), and a failure in any must
// leave `write` returning `refused`, since a rejection cannot be expressed by its
// `written | refused` result and would surface as an unhandled rejection.
//
// A failed read is a third answer, not a second nothing: `readOutcome` separates a record that
// was never written from a read the adapter could not perform, and the cases at the foot hold
// it to that.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { isRefusal } from "@renderer/lib/refusal.js";
import { PersistenceAdapterError, type PartitionSummary } from "./persistence-adapter.js";
import {
  MemoryPersistenceAdapter,
  type MemoryPersistenceAdapterOptions,
} from "./memory-persistence-adapter.js";
import { ReadFailurePersistenceAdapter } from "@test/helpers/read-failure-persistence-adapter.js";
import { UiStateStore } from "./ui-state-store.js";
import { refusePersistence } from "./persistence-refusals.js";

describe("a store whose trim fails refuses the write rather than rejecting it", () => {
  // The write path touches the adapter four times: the write, the trim under quota, the
  // partition count that trim is sized from, and the housekeeping trim after a success.

  const connectionLost = (): PersistenceAdapterError =>
    new PersistenceAdapterError(
      refusePersistence(
        "adapter-unavailable",
        "the preferences database dropped its connection mid-trim",
      ),
    );

  it("refuses when the partition count the quota trim needs fails", async () => {
    // A one-byte ceiling puts the first write over quota, so the trim-and-retry arm runs
    // immediately and the count it opens with fails.
    const store = new UiStateStore({
      adapter: new BookkeepingFailureAdapter("summarize", connectionLost(), { capacityBytes: 1 }),
      clock: new ManualClock(1_000),
    });

    const result = await store.write("session-1", "expansion", "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("adapter-unavailable");
      expect(isRefusal(result.refusal)).toBe(true);
    }
    // Counted, so the diagnostics view shows a store that has begun to fail.
    expect((await store.health()).refusalCounts["adapter-unavailable"]).toBe(1);
  });

  it("refuses when the quota trim itself fails", async () => {
    const store = new UiStateStore({
      adapter: new BookkeepingFailureAdapter("trim", connectionLost(), { capacityBytes: 1 }),
      clock: new ManualClock(1_000),
    });

    const result = await store.write("session-1", "expansion", "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("adapter-unavailable");
    }
  });

  it("refuses when the housekeeping trim after a SUCCESSFUL write fails", async () => {
    const adapter = new BookkeepingFailureAdapter("trim", connectionLost());
    const store = new UiStateStore({
      adapter,
      clock: new ManualClock(1_000),
      sessionPartitionCap: 1,
    });

    // One session partition is at the cap, so nothing is trimmed.
    await expect(
      store.write("session-1", "expansion", "expansion", ["run-01"]),
    ).resolves.toStrictEqual({ outcome: "written" });

    // The second crosses it, and the trim that crossing triggers fails.
    const result = await store.write("session-2", "expansion", "expansion", ["run-02"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("adapter-unavailable");
    }
    // The record did land: this arm reports a refusal because the store could not finish the
    // path it declares, not because the value was rejected.
    expect(await store.read("session-2", "expansion")).toBeDefined();
  });

  it("negative control: a failure that is not an adapter refusal still rejects", async () => {
    // Guards against a bare `catch {}` that turned every defect in this class into a refusal
    // filed under a code that names storage.
    const store = new UiStateStore({
      adapter: new BookkeepingFailureAdapter(
        "summarize",
        new TypeError("summarizePartitions is not a function"),
        { capacityBytes: 1 },
      ),
      clock: new ManualClock(1_000),
    });

    await expect(store.write("session-1", "expansion", "expansion", ["run-01"])).rejects.toThrow(
      TypeError,
    );
  });
});

/**
 * A memory adapter whose partition bookkeeping fails on one named operation. A subclass, so
 * the quota ceiling, record map and gauge stay the real adapter's and one operation
 * misbehaves.
 */
class BookkeepingFailureAdapter extends MemoryPersistenceAdapter {
  readonly #failingOperation: "summarize" | "trim";
  readonly #failure: Error;

  public constructor(
    failingOperation: "summarize" | "trim",
    failure: Error,
    options: MemoryPersistenceAdapterOptions = {},
  ) {
    super(options);
    this.#failingOperation = failingOperation;
    this.#failure = failure;
  }

  public override summarizePartitions(): Promise<readonly PartitionSummary[]> {
    return this.#failingOperation === "summarize"
      ? Promise.reject(this.#failure)
      : super.summarizePartitions();
  }

  public override trimPartitions(keepSessionPartitions: number): Promise<number> {
    return this.#failingOperation === "trim"
      ? Promise.reject(this.#failure)
      : super.trimPartitions(keepSessionPartitions);
  }
}

describe("a read that failed is not a record that was never written", () => {
  it("answers `failed` where the record is unreachable and `absent` where it is not there", async () => {
    const adapter = new ReadFailurePersistenceAdapter();
    const store = new UiStateStore({ adapter, clock: new ManualClock(1_000) });
    expect((await store.write("session-1", "expansion", "expansion", ["run-01"])).outcome).toBe(
      "written",
    );

    // The record is there and the adapter cannot say so: one answer for "unreachable",
    // another for "not there".
    expect((await store.readOutcome("session-1", "expansion")).outcome).toBe("failed");
    adapter.stopFailingReads();
    expect((await store.readOutcome("session-1", "expansion")).outcome).toBe("present");
    expect((await store.readOutcome("session-1", "never-written")).outcome).toBe("absent");
  });

  it("counts the failure on the store's health and still never throws", async () => {
    const store = new UiStateStore({
      adapter: new ReadFailurePersistenceAdapter(),
      clock: new ManualClock(1_000),
    });

    expect((await store.readOutcome("session-1", "expansion")).outcome).toBe("failed");

    expect((await store.health()).failedReadCount).toBe(1);
  });

  it("negative control: the lossy projection still reports both nothings as one", async () => {
    // `read` and `readGlobal` are the lossy form that callers take deliberately, so they must
    // not have started throwing or reporting a record.
    const adapter = new ReadFailurePersistenceAdapter();
    const store = new UiStateStore({ adapter, clock: new ManualClock(1_000) });
    await store.write("session-1", "expansion", "expansion", ["run-01"]);

    expect(await store.read("session-1", "expansion")).toBeUndefined();
    adapter.stopFailingReads();
    expect(await store.read("session-1", "never-written")).toBeUndefined();
    expect(await store.read("session-1", "expansion")).toBeDefined();
  });
});
