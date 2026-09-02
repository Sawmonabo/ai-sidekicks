// A store whose trim fails refuses the write rather than rejecting it.
//
// The write path touches the adapter four times — the write, the trim under quota,
// the partition count that trim is sized from, and the housekeeping trim after a
// successful write — and only the first two were inside a `try`. A failure in either
// of the others left `write` REJECTING, which is not a state its `written | refused`
// result type can express and which the one shipped caller (the scheme preference,
// written without `await`) turns into an unhandled rejection nobody sees.
//
// The write chokepoint itself is `ui-state-store.test.ts`; what the console says
// when there is no durable store at all is `ui-state-store.degradation.test.ts`.

import { describe, expect, it } from "vitest";

import { ManualClock, isConsoleRefusal } from "../core/index.js";
import { PersistenceAdapterError, type PartitionSummary } from "./adapter.js";
import {
  MemoryPersistenceAdapter,
  type MemoryPersistenceAdapterOptions,
} from "./memory-adapter.js";
import { UiStateStore } from "./ui-state-store.js";
import { refusePersistence } from "./value-classes.js";

describe("a store whose trim fails refuses the write rather than rejecting it", () => {
  // The write path touches the adapter four times — the write, the trim under
  // quota, the partition count that trim is sized from, and the housekeeping trim
  // after a successful write — and only the first two were inside a `try`. A
  // failure in either of the others left `write` REJECTING, which is not a state
  // its `written | refused` result type can express and which the one shipped
  // caller (the scheme preference, written without `await`) turns into an
  // unhandled rejection nobody sees.

  const connectionLost = (): PersistenceAdapterError =>
    new PersistenceAdapterError(
      refusePersistence(
        "adapter-unavailable",
        "the preferences database dropped its connection mid-trim",
      ),
    );

  it("refuses when the partition count the quota trim needs fails", async () => {
    // A one-byte ceiling puts the very first write over quota, so the store takes
    // its trim-and-retry arm immediately and the count that arm opens with fails.
    const store = new UiStateStore({
      adapter: new BookkeepingFailureAdapter("summarise", connectionLost(), { capacityBytes: 1 }),
      clock: new ManualClock(1_000),
    });

    const result = await store.write("session-1", "expansion", "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("adapter-unavailable");
      expect(isConsoleRefusal(result.refusal)).toBe(true);
    }
    // Counted, so the diagnostics surface shows a store that has begun to fail
    // rather than a write that quietly went nowhere.
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

    // One session partition is at the cap, so nothing is trimmed and the write
    // settles normally.
    await expect(
      store.write("session-1", "expansion", "expansion", ["run-01"]),
    ).resolves.toStrictEqual({ outcome: "written" });

    // The second crosses it, and the trim that crossing triggers fails.
    const result = await store.write("session-2", "expansion", "expansion", ["run-02"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("adapter-unavailable");
    }
    // The record did land: this arm reports a refusal because the store could not
    // finish the path it declares, not because the value was rejected. Asserted so
    // the trade-off is pinned rather than assumed either way.
    expect(await store.read("session-2", "expansion")).toBeDefined();
  });

  it("negative control: a failure that is not an adapter refusal still rejects", async () => {
    // Without this, the guard above could be a bare `catch {}` that turned every
    // defect in this class — a mistyped method, a null adapter — into a refusal
    // filed under a code that names storage.
    const store = new UiStateStore({
      adapter: new BookkeepingFailureAdapter(
        "summarise",
        new TypeError("summarisePartitions is not a function"),
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
 * A memory adapter whose partition bookkeeping fails on one named operation.
 *
 * A SUBCLASS rather than a hand-written double: the quota ceiling, the record
 * map, and the gauge stay the real adapter's, so these cases drive the store
 * against the same collaborator every other case in this file uses and exactly
 * one operation misbehaves.
 */
class BookkeepingFailureAdapter extends MemoryPersistenceAdapter {
  readonly #failingOperation: "summarise" | "trim";
  readonly #failure: Error;

  public constructor(
    failingOperation: "summarise" | "trim",
    failure: Error,
    options: MemoryPersistenceAdapterOptions = {},
  ) {
    super(options);
    this.#failingOperation = failingOperation;
    this.#failure = failure;
  }

  public override summarisePartitions(): Promise<readonly PartitionSummary[]> {
    return this.#failingOperation === "summarise"
      ? Promise.reject(this.#failure)
      : super.summarisePartitions();
  }

  public override trimPartitions(keepSessionPartitions: number): Promise<number> {
    return this.#failingOperation === "trim"
      ? Promise.reject(this.#failure)
      : super.trimPartitions(keepSessionPartitions);
  }
}
