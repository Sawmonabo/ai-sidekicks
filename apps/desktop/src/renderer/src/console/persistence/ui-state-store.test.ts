// The write chokepoint.
//
// Every durable write goes through one function that refuses a value outside the
// closed class enumeration AND fires the tripwire — the refusal alone would not be
// enough, because a refused write that nobody is told about is a preference that
// silently stops working. The address is held to the same grammar as the value, the
// record byte cap counts both halves, and the LRU trim orders on the injected
// clock's stamps.
//
// The clock is frozen, so that ordering is driven by named instants rather than by
// whether two writes happened to land in the same millisecond.
//
// The store's other two subjects have their own files:
// `ui-state-store.degradation.test.ts` for what the console says when there is no
// durable store, and `ui-state-store.adapter-failure.test.ts` for a write whose
// bookkeeping fails underneath it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManualClock, consoleTripwires, isConsoleRefusal } from "../core/index.js";
import { PERSISTENCE_GLOBAL_PARTITION } from "./adapter.js";
import { MemoryPersistenceAdapter } from "./memory-adapter.js";
import { UiStateStore } from "./ui-state-store.js";

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

  it("refuses a key built from prose, writes nothing, and fires the tripwire", async () => {
    // The address half of the record. Nothing in the value here is wrong — an
    // expansion set of two run ids is exactly what the class is for — so a
    // chokepoint that validated only the value would have written the sentence.
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });
    const proseKey = "Rerun the migration and tell me what the row counts look like";

    const result = await store.write("session-1", proseKey, "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("address-not-identifier-shaped");
      expect(isConsoleRefusal(result.refusal)).toBe(true);
    }
    expect(consoleTripwires.firingCount("persistence-value-class")).toBe(1);
    // The site a tripwire reports must not carry the prose the store refused.
    expect(consoleTripwires.reports().at(-1)?.site).not.toContain(proseKey);

    expect(await store.read("session-1", proseKey)).toBeUndefined();
    expect(await store.readPartition("session-1")).toStrictEqual([]);
    const health = await store.health();
    expect(health.refusalCounts["address-not-identifier-shaped"]).toBe(1);
    await store.close();
  });

  it("refuses a path-shaped partition, which the value grammar would have admitted", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });
    const path = "/Users/someone/repos/service/notes.md";

    const result = await store.write(path, "expansion", "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("address-not-identifier-shaped");
    }
    expect(await store.readPartition(path)).toStrictEqual([]);
    await store.close();
  });

  it("counts the address against the record byte cap, not only the value", async () => {
    // A cap that measured the value alone would let a caller spend the ceiling on
    // the value and then an unbounded further amount on the key beside it.
    const value = ["run-01"];
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
      // Room for the short address below and nothing like room for the long one.
      recordByteCap: "s".length + "k".length + "expansion".length + JSON.stringify(value).length,
    });

    await expect(store.write("s", "k", "expansion", value)).resolves.toStrictEqual({
      outcome: "written",
    });

    const overCap = await store.write("s", "expansion-of-the-runs-pane", "expansion", value);

    expect(overCap.outcome).toBe("refused");
    if (overCap.outcome === "refused") {
      expect(overCap.refusal.code).toBe("value-too-large");
    }
    expect(await store.read("s", "expansion-of-the-runs-pane")).toBeUndefined();
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
