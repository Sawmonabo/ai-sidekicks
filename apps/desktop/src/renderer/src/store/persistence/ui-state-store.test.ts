// The write chokepoint refuses a value outside the closed class enumeration and fires the
// tripwire, since a refused write nobody hears about is a preference that silently stops
// working. The address is held to the same grammar as the value, the record byte cap counts
// both halves, and the LRU trim orders on the injected clock's stamps (frozen, so ordering is
// driven by named instants). Degradation and adapter-failure cases have their own files.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { isRefusal } from "@renderer/lib/refusal.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { PERSISTENCE_GLOBAL_PARTITION } from "./persistence-adapter.js";
import { MemoryPersistenceAdapter } from "./memory-persistence-adapter.js";
import { UiStateStore } from "./ui-state-store.js";

// Tripwires throw in development; here they are recorded, because these cases assert the
// breach was detected and described.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.reset();
});

describe("the write chokepoint refuses what the durable store may not hold", () => {
  it("refuses a class outside the enumeration, counts it, and fires the tripwire", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });

    // Cast deliberately: the runtime guard must hold for input the compiler cannot see.
    const result = await store.write("session-1", "body", "composer-draft" as never, "hello");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-class-unknown");
      expect(isRefusal(result.refusal)).toBe(true);
    }
    expect(windowTripwires.firingCount("persistence-value-class")).toBe(1);

    const health = await store.health();
    expect(health.refusalCounts["value-class-unknown"]).toBe(1);
    // A refusal is not a write that also complained.
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
    expect(windowTripwires.firingCount("persistence-value-class")).toBe(1);
    await store.close();
  });

  it("refuses a key built from prose, writes nothing, and fires the tripwire", async () => {
    // Nothing in the value is wrong, so a chokepoint validating only the value would have
    // written the sentence.
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });
    const proseKey = "Rerun the migration and tell me what the row counts look like";

    const result = await store.write("session-1", proseKey, "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("address-not-identifier-shaped");
      expect(isRefusal(result.refusal)).toBe(true);
    }
    expect(windowTripwires.firingCount("persistence-value-class")).toBe(1);
    // The site a tripwire reports must not carry the prose the store refused.
    expect(windowTripwires.reports().at(-1)?.site).not.toContain(proseKey);

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
    // A cap over the value alone would leave the key unbounded.
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
    // Guards against a chokepoint that refused every write.
    const clock = new ManualClock(1_000);
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter(), clock });

    await expect(
      store.write("session-1", "expansion", "expansion", ["run-01", "run-02"]),
    ).resolves.toStrictEqual({ outcome: "written" });
    await expect(store.writeGlobal("scheme", "scheme", "dark")).resolves.toStrictEqual({
      outcome: "written",
    });

    expect(windowTripwires.totalFiringCount).toBe(0);
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
    // The global partition is written once at boot, so it is permanently the least recently
    // touched one and must never be the first casualty.
    expect(await store.readGlobal("scheme")).toBeDefined();
    await store.close();
  });
});
