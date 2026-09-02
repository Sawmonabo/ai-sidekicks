// The write chokepoint, and what the console says when there is no durable store.
//
// Two claims are driven here that nothing else in the tree drives:
//
//   1. Every durable write goes through one function that refuses a value outside
//      the closed class enumeration AND fires the tripwire — the refusal alone
//      would not be enough, because a refused write that nobody is told about is
//      a preference that silently stops working.
//   2. A renderer whose scheme was not registered privileged runs on the in-memory
//      adapter and SAYS SO (I-023-11), on the quota gauge as well as in prose —
//      a surface that reads only the gauge must not see three empty numbers and
//      report a silent nothing.
//
// The clock is frozen, so the LRU ordering is driven by named instants rather than
// by whether two writes happened to land in the same millisecond.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManualClock, consoleTripwires, isConsoleRefusal } from "../core/index.js";
import {
  PERSISTENCE_GLOBAL_PARTITION,
  PERSISTENCE_UNAVAILABLE_DESCRIPTIONS,
  PersistenceAdapterError,
  describeQuotaUnavailability,
  unmeasuredQuota,
  type PartitionSummary,
} from "./adapter.js";
import {
  MemoryPersistenceAdapter,
  type MemoryPersistenceAdapterOptions,
} from "./memory-adapter.js";
import { UiStateStore } from "./ui-state-store.js";
import { refusePersistence } from "./value-classes.js";

// Tripwires throw in development so a breach is impossible to ignore. Here they
// are RECORDED, because these cases assert that the breach was detected and
// described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
});

describe("the write chokepoint refuses what the durable store may not hold", () => {
  it("refuses a class outside the enumeration, counts it, and fires the tripwire", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });

    // Cast deliberately: the compiler already refuses this, and the runtime guard
    // has to hold for anything arriving across a boundary the compiler cannot see.
    const result = await store.write("session-1", "body", "composer-draft" as never, "hello");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-class-unknown");
      expect(isConsoleRefusal(result.refusal)).toBe(true);
    }
    expect(consoleTripwires.firingCount("persistence-value-class")).toBe(1);

    const health = await store.health();
    expect(health.refusalCounts["value-class-unknown"]).toBe(1);
    // Nothing was written: a refusal is not a write that also complained.
    await expect(store.read("session-1", "body")).resolves.toBeUndefined();
    await store.close();
  });

  it("refuses prose inside an ADMITTED class, so the class is not the only guard", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });

    const result = await store.write("session-1", "selection", "selection", {
      note: "Rerun the migration against staging and tell me what the row counts look like.",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
    expect(consoleTripwires.firingCount("persistence-value-class")).toBe(1);
    await store.close();
  });

  it("negative control: an in-enumeration write lands and fires nothing", async () => {
    // Without this, a chokepoint that refused every write would pass both cases
    // above while having broken persistence entirely.
    const clock = new ManualClock(1_000);
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter(), clock });

    await expect(
      store.write("session-1", "expansion", "expansion", ["run-01", "run-02"]),
    ).resolves.toStrictEqual({ outcome: "written" });
    await expect(store.writeGlobal("scheme", "scheme", "dark")).resolves.toStrictEqual({
      outcome: "written",
    });

    expect(consoleTripwires.totalFiringCount).toBe(0);
    const record = await store.readGlobal("scheme");
    expect(record?.value).toBe("dark");
    expect(record?.partition).toBe(PERSISTENCE_GLOBAL_PARTITION);
    await store.close();
  });

  it("stamps every record from the injected clock, never from the wall", async () => {
    const clock = new ManualClock(1_000);
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter(), clock });

    await store.write("session-1", "expansion", "expansion", ["run-01"]);
    clock.advance(5_000);
    await store.write("session-2", "expansion", "expansion", ["run-02"]);

    expect((await store.read("session-1", "expansion"))?.updatedAt).toBe(1_000);
    expect((await store.read("session-2", "expansion"))?.updatedAt).toBe(6_000);
    await store.close();
  });

  it("trims the least-recently-written session partition, ordered on those stamps", async () => {
    const clock = new ManualClock(1_000);
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock,
      sessionPartitionCap: 2,
    });

    await store.write("session-old", "expansion", "expansion", ["run-01"]);
    clock.advance(1_000);
    await store.write("session-mid", "expansion", "expansion", ["run-02"]);
    clock.advance(1_000);
    await store.writeGlobal("scheme", "scheme", "dark");
    clock.advance(1_000);
    // The third session partition crosses the cap and triggers the trim.
    await store.write("session-new", "expansion", "expansion", ["run-03"]);

    expect(await store.read("session-old", "expansion")).toBeUndefined();
    expect(await store.read("session-mid", "expansion")).toBeDefined();
    expect(await store.read("session-new", "expansion")).toBeDefined();
    // The global partition is written once at boot and is therefore permanently
    // the least recently touched one. It must never be the first casualty.
    expect(await store.readGlobal("scheme")).toBeDefined();
    await store.close();
  });
});

describe("no durable store means a visible degradation, not a silent one", () => {
  it("discloses the cause in prose AND on the quota gauge", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ unavailableReason: "open-refused" }),
      clock: new ManualClock(1_000),
    });

    const health = await store.health();

    expect(health.adapterKind).toBe("memory");
    expect(health.durable).toBe(false);
    expect(health.description).toContain("not survive a restart");
    // "Storage unavailable" alone would leave an operator with nothing to check.
    expect(health.description).toContain("renderer scheme");
    // And the gauge — which is what a storage surface reads — carries the reason
    // rather than three absent numbers a reader cannot interpret.
    expect(health.quota.unavailableReason).toBe("open-refused");
    expect(describeQuotaUnavailability(health.quota)).toBe(
      PERSISTENCE_UNAVAILABLE_DESCRIPTIONS["open-refused"],
    );
    await store.close();
  });

  it("negative control: the reason discriminates rather than always producing text", () => {
    // A `describeQuotaUnavailability` that returned a sentence unconditionally
    // would pass the case above while telling every reader storage was broken.
    expect(describeQuotaUnavailability(unmeasuredQuota(undefined))).toBeUndefined();
    expect(describeQuotaUnavailability(unmeasuredQuota("open-timed-out"))).toBe(
      PERSISTENCE_UNAVAILABLE_DESCRIPTIONS["open-timed-out"],
    );
  });

  it("reports pressure and the reason together once a ceiling is known", async () => {
    const adapter = new MemoryPersistenceAdapter({
      unavailableReason: "no-indexeddb-global",
      capacityBytes: 200,
    });
    const store = new UiStateStore({ adapter, clock: new ManualClock(1_000) });

    const beforePressure = await store.health();
    expect(beforePressure.quota.pressure).toBe("ok");
    expect(beforePressure.quota.quotaBytes).toBe(200);
    expect(beforePressure.quota.unavailableReason).toBe("no-indexeddb-global");

    await store.write("session-1", "expansion", "expansion", [
      "run-0001",
      "run-0002",
      "run-0003",
      "run-0004",
      "run-0005",
      "run-0006",
      "run-0007",
      "run-0008",
      "run-0009",
      "run-0010",
      "run-0011",
      "run-0012",
      "run-0013",
      "run-0014",
    ]);

    const afterPressure = await store.health();
    // Pressure is REPORTED, never acted on behind the operator's back — the layout
    // is still there, and the gauge is how they find out it is close to the edge.
    expect(afterPressure.quota.pressure).toBe("high");
    expect(afterPressure.quota.unavailableReason).toBe("no-indexeddb-global");
    await store.close();
  });

  it("falls all the way back to memory when the window has no database API", async () => {
    // The composition root's own path, end to end: `opening()` attempts the
    // durable open, this host has no database API (I-023-11's failing arm), and
    // the store that comes back works — it just says it is not durable.
    const clock = new ManualClock(1_000);
    const store = UiStateStore.opening({ clock });

    const health = await store.health();

    expect(health.adapterKind).toBe("memory");
    expect(health.durable).toBe(false);
    expect(health.quota.unavailableReason).toBe("no-indexeddb-global");
    expect(describeQuotaUnavailability(health.quota)).toBe(
      PERSISTENCE_UNAVAILABLE_DESCRIPTIONS["no-indexeddb-global"],
    );
    // Preferences still round-trip inside the window, and the open armed no timer
    // on the way there: the timeout race exists only when there is something to
    // race against.
    await expect(store.writeGlobal("scheme", "scheme", "dark")).resolves.toStrictEqual({
      outcome: "written",
    });
    expect((await store.readGlobal("scheme"))?.updatedAt).toBe(1_000);
    expect(clock.pendingCount).toBe(0);
    await store.close();
  });

  it("starts as 'nothing has been read yet', not as zero bytes used", () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });

    // The five kinds of nothing are distinct: an unread gauge is not an empty one.
    expect(store.lastQuota.usageBytes).toBeUndefined();
    expect(store.lastQuota.quotaBytes).toBeUndefined();
    expect(store.lastQuota.unavailableReason).toBe("not-attempted");
  });
});

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
