// Failure modes of the durable tier, each about a write that must not happen quietly. One half
// is the store the console cannot open (a scheme the browser refuses storage to, a database a
// newer build wrote, no IndexedDB at all, a full quota); the other is the store it must not
// write into (a class outside the closed set, prose inside an allowed class or an object key).
// Opening decides whether `UiStateStore` has a durable adapter and what it discloses when it
// does not, and the value-class guard decides what may cross it, so both sit behind the one
// entry point. Assertions are on the refusal (code, detail, tripwire), since a does-not-throw
// check passes over silent fallback to memory and silently stored prose.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { classifyOpenFailure, openUiStateDatabase } from "./indexeddb-persistence-adapter.js";
import { MemoryPersistenceAdapter } from "./memory-persistence-adapter.js";
import { UiStateStore } from "./ui-state-store.js";

// Tripwires throw in development; under test they are recorded, because these cases assert the
// breach was detected and described.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("failure matrix — the durable store cannot be opened", () => {
  // Every case that installs one removes it again, so later files see the real host.
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("classifies a refused open as the unprivileged-scheme case", () => {
    expect(classifyOpenFailure(named("SecurityError"))).toBe("open-refused");
    expect(classifyOpenFailure(named("InvalidStateError"))).toBe("open-refused");
    expect(classifyOpenFailure(named("UnknownError"))).toBe("open-refused");
  });

  it("classifies a version mismatch separately, so nothing is deleted to recover", () => {
    // A newer build already wrote this database. Falling back to memory keeps its bytes intact;
    // clearing the store would destroy a future version's state.
    expect(classifyOpenFailure(named("VersionError"))).toBe("version-mismatch");
  });

  it("reports the missing global rather than throwing when the host has no IndexedDB", async () => {
    // The production shape: nothing is injected, and this host has no factory (happy-dom
    // defines none).
    const outcome = await openUiStateDatabase({});
    expect(outcome).toStrictEqual({ outcome: "unavailable", reason: "no-indexeddb-global" });
  });

  it("honors an EXPLICITLY absent factory on a host that has an ambient one", async () => {
    // The arm a `??` coalesce cannot reach: on a host with a global,
    // `options.indexedDbFactory ?? indexedDB` would substitute the ambient factory for an
    // explicit `undefined` and open durable storage. The recorder asserts the ambient factory
    // was never touched.
    const ambientFactory = new RecordingIndexedDbFactory();
    installAmbientIndexedDb(ambientFactory);

    const outcome = await openUiStateDatabase({ indexedDbFactory: undefined });

    expect(outcome).toStrictEqual({ outcome: "unavailable", reason: "no-indexeddb-global" });
    expect(ambientFactory.openCallCount).toBe(0);
  });

  it("negative control: an OMITTED factory still opens the ambient one", async () => {
    // The gate is the property's presence, not its value, so the other half must hold too, or
    // "explicitly absent" would just mean "never open anything".
    const ambientFactory = new RecordingIndexedDbFactory();
    installAmbientIndexedDb(ambientFactory);

    const outcome = await openUiStateDatabase({});

    expect(outcome.outcome).toBe("unavailable");
    expect(ambientFactory.openCallCount).toBe(1);
  });

  it("falls back to memory and SAYS SO when the open is refused", async () => {
    // The refusing factory is installed as the ambient global as well, because `idb`'s
    // `openDB` reads the global; otherwise the refusal would be a `ReferenceError` rather than
    // the `SecurityError` this case is named for.
    const refusingFactory = new RecordingIndexedDbFactory();
    installAmbientIndexedDb(refusingFactory);

    const outcome = await openUiStateDatabase({
      indexedDbFactory: refusingFactory.asIndexedDbFactory,
    });
    expect(outcome.outcome).toBe("unavailable");
    if (outcome.outcome === "unavailable") {
      expect(outcome.reason).toBe("open-refused");
    }
    expect(refusingFactory.openCallCount).toBe(1);

    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ unavailableReason: "open-refused" }),
    });
    const health = await store.health();
    expect(health.durable).toBe(false);
    expect(health.description).toContain("not survive a restart");
    // The disclosure names the cause; "Storage unavailable" alone gives an operator nothing.
    expect(health.description).toContain("renderer scheme");
  });

  it("trims once and then surfaces the refusal when the quota is exhausted", async () => {
    // The ceiling admits the first record (43 bytes by the adapter's estimator) and cannot admit
    // the second (88) even with the first evicted. The trim frees a whole partition and the
    // write still fails, so the refusal reaches the caller instead of being retried forever.
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ capacityBytes: 50 }),
      sessionPartitionCap: 1,
    });

    const first = await store.write("session-1", "layout", "layout", {
      paneLayout: { width: 100 },
    });
    expect(first.outcome).toBe("written");

    const overflowing = await store.write("session-2", "layout", "layout", {
      paneLayout: { width: 100, height: 200, ratio: 3, offset: 4, gutter: 5 },
    });

    expect(overflowing.outcome).toBe("refused");
    if (overflowing.outcome === "refused") {
      expect(overflowing.refusal.code).toBe("quota-exceeded");
    }
    const health = await store.health();
    expect(health.trimCount).toBeGreaterThan(0);
    expect(health.refusalCounts["quota-exceeded"]).toBe(1);
  });
});

describe("failure matrix — the persistence chokepoint is handed something it may not keep", () => {
  it("refuses an unknown value class and names the closed set", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    // Deliberately cast: the runtime guard must hold for input the compiler cannot see.
    const result = await store.write("session-1", "k", "composer-draft" as never, "hello");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-class-unknown");
      expect(result.refusal.detail).toContain("layout");
    }
    expect(windowTripwires.firingCount("persistence-value-class")).toBe(1);
  });

  it("refuses user-authored prose inside an allowed class", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    const result = await store.write("session-1", "selection", "selection", {
      composer: "Can you take another look at the rate-limit wiring before I merge it?",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
    expect(windowTripwires.firingCount("persistence-value-class")).toBe(1);
  });

  it("refuses prose smuggled through an object KEY", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    const result = await store.write("session-1", "scroll", "scroll-position", {
      "note to self: fix this later": 12,
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
  });

  it("accepts the identifier-shaped values the classes are for", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    await expect(
      store.write("session-1", "expansion", "expansion", ["run-01", "run-02"]),
    ).resolves.toStrictEqual({ outcome: "written" });
    await expect(store.writeGlobal("scheme", "scheme", "dark")).resolves.toStrictEqual({
      outcome: "written",
    });
    expect(windowTripwires.totalFiringCount).toBe(0);
  });
});

/** An error carrying only the `name` the classifier keys on. */
function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * An ambient `indexedDB` that records being reached, and refuses if it is. On a host with no
 * factory (happy-dom), coalescing the option's value and checking its presence agree, so the
 * missing-global arm needs a factory the adapter must not touch to be falsifiable.
 */
class RecordingIndexedDbFactory {
  #openCallCount = 0;

  public get openCallCount(): number {
    return this.#openCallCount;
  }

  /** Matches `IDBFactory.open` in name only; it counts the call and never returns. */
  public open(): never {
    this.#openCallCount += 1;
    throw named("SecurityError");
  }

  /**
   * The same object, typed as what `openUiStateDatabase` gates on. A cast, since `open` is the
   * only member the gate or `idb` reaches.
   */
  public get asIndexedDbFactory(): IDBFactory {
    return this as unknown as IDBFactory;
  }
}

/**
 * Give this host an ambient factory, as a browser has and this environment does not.
 * `configurable` so the `afterEach` can remove it.
 */
function installAmbientIndexedDb(factory: RecordingIndexedDbFactory): void {
  Object.defineProperty(globalThis, "indexedDB", {
    value: factory.asIndexedDbFactory,
    configurable: true,
    writable: true,
  });
}
