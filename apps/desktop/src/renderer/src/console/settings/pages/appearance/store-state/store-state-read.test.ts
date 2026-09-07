// One read of the store at a time, and the newest answer is the one on screen.
//
// THE DEFECT THESE COVER. The block wired the mount and the window's focus straight to
// `UiStateStore.health()`, so a focus that landed while the first quota estimate was
// still outstanding put two of them in flight and whichever ANSWERED last published.
// An estimate taken before the thing that changed then replaced the one taken after
// it, and the block rendered the older figure with nothing saying so.
//
// The store underneath is REAL — the shipped `UiStateStore` over the shipped
// in-memory adapter — with exactly one method held: the adapter's quota measurement,
// which is the slow half on the durable adapter and the only thing these cases need to
// control. A hand-built store would have made every assertion below a claim about the
// harness.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../../../core/index.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../../../core/settle.test-support.js";
import { crossMacrotaskBoundary } from "../../../../core/macrotask-boundary.test-support.js";
import {
  MemoryPersistenceAdapter,
  UiStateStore,
  type QuotaGauge,
} from "../../../../persistence/index.js";
import { StoreStateRead } from "./store-state-read.js";

/**
 * The shipped in-memory adapter with its quota measurement HELD.
 *
 * A subclass rather than a stand-in, so everything the store does around the held
 * call — the health ledger, the adapter description, the durability reading — is the
 * shipped behaviour. What each case decides is only WHEN an estimate answers and what
 * figure it answers with, which is the axis the race lives on.
 */
class HeldQuotaAdapter extends MemoryPersistenceAdapter {
  readonly #waiting: ((usageBytes: number) => void)[] = [];
  #startedReadCount = 0;
  #outstandingReadCount = 0;
  #peakOutstandingReadCount = 0;

  /** Estimates begun. One per `health()` that actually reached the adapter. */
  public get startedReadCount(): number {
    return this.#startedReadCount;
  }

  /** The most estimates ever outstanding at once. The serialization assertion. */
  public get peakOutstandingReadCount(): number {
    return this.#peakOutstandingReadCount;
  }

  public override measureQuota(): Promise<QuotaGauge> {
    this.#startedReadCount += 1;
    this.#outstandingReadCount += 1;
    this.#peakOutstandingReadCount = Math.max(
      this.#peakOutstandingReadCount,
      this.#outstandingReadCount,
    );
    return new Promise<QuotaGauge>((resolve) => {
      this.#waiting.push((usageBytes: number) => {
        this.#outstandingReadCount -= 1;
        resolve({
          usageBytes,
          quotaBytes: undefined,
          pressure: "unknown",
          unavailableReason: this.unavailableReason,
        });
      });
    });
  }

  /**
   * Answer the estimate at `position` in the order they began, with this figure.
   *
   * Positional rather than first-in-first-out, so a case can release an OLDER estimate
   * after a newer one — the ordering the defect needed and the one a queue could not
   * express.
   */
  public releaseEstimate(position: number, usageBytes: number): void {
    const release = this.#waiting[position];
    if (release === undefined) {
      throw new Error(`no store estimate has begun at position ${String(position)}`);
    }
    release(usageBytes);
  }
}

interface ReadHarness {
  readonly adapter: HeldQuotaAdapter;
  readonly clock: ManualClock;
  readonly read: StoreStateRead;
}

function createReadHarness(): ReadHarness {
  const adapter = new HeldQuotaAdapter();
  const clock = new ManualClock();
  const uiStateStore = new UiStateStore({ adapter, clock });
  return { adapter, clock, read: new StoreStateRead({ uiStateStore, clock }) };
}

/** Carry the schedule past its debounce and let the read reach the adapter. */
async function fireScheduledRead(harness: ReadHarness): Promise<void> {
  harness.clock.advance(PAST_REFRESH_DEBOUNCE_MS);
  await crossMacrotaskBoundary();
}

/** The usage figure the block would render, or `undefined` on the other two arms. */
function renderedUsageBytes(read: StoreStateRead): number | undefined {
  const reading = read.snapshot();
  return reading.kind === "read" ? reading.health.quota.usageBytes : undefined;
}

let harness: ReadHarness;

beforeEach(() => {
  harness = createReadHarness();
});

describe("StoreStateRead — one estimate at a time, newest on screen", () => {
  it("collapses a burst of triggers into one read of the store", async () => {
    // The mount and a focus arriving inside one debounce window is the ordinary case,
    // not the exotic one: the window that regains focus is the window that just
    // mounted a settings page. Two direct calls is what the block used to make.
    harness.read.requestRead("subscribe");
    harness.read.requestRead("window-focus");

    await fireScheduledRead(harness);

    expect(harness.adapter.startedReadCount).toBe(1);
    harness.read.dispose();
  });

  it("never has two estimates outstanding, so an older one cannot replace a newer", async () => {
    // THE RACE, DRIVEN IN THE ORDER THAT LOSES IT. The first estimate is held; a focus
    // arrives while it is outstanding; the clock is carried well past a second debounce
    // window. A block that called the store per trigger has two estimates in flight
    // here, and the one that answers last wins whichever it is.
    harness.read.requestRead("subscribe");
    await fireScheduledRead(harness);
    expect(harness.adapter.startedReadCount).toBe(1);

    harness.read.requestRead("window-focus");
    await fireScheduledRead(harness);

    expect(harness.adapter.startedReadCount).toBe(1);
    expect(harness.adapter.peakOutstandingReadCount).toBe(1);

    // The held estimate answers with the OLDER figure, and the queued reason then
    // becomes the next read rather than a parallel one.
    harness.adapter.releaseEstimate(0, 1_000);
    await crossMacrotaskBoundary();
    await fireScheduledRead(harness);
    expect(harness.adapter.startedReadCount).toBe(2);

    harness.adapter.releaseEstimate(1, 4_000);
    await crossMacrotaskBoundary();

    expect(renderedUsageBytes(harness.read)).toBe(4_000);
    expect(harness.adapter.peakOutstandingReadCount).toBe(1);
    harness.read.dispose();
  });

  it("discards an estimate that answers after the reading was retired", async () => {
    // Serialization bounds what this reading races against ITSELF and says nothing
    // about a page that unmounted, or a window whose store was replaced, while an
    // estimate was outstanding. Nothing behind `health()` is cancellable — it takes no
    // signal — so the superseded answer is ignored rather than stopped, and the round
    // is what expresses that.
    harness.read.requestRead("subscribe");
    await fireScheduledRead(harness);
    expect(harness.adapter.startedReadCount).toBe(1);

    harness.read.dispose();
    harness.adapter.releaseEstimate(0, 9_000);
    await crossMacrotaskBoundary();

    expect(harness.read.snapshot()).toEqual({ kind: "unread" });
    expect(harness.read.isDisposed).toBe(true);
  });

  it("negative control: the same estimate answering into a live reading does install", async () => {
    // Without it the case above would pass over a reading that installed nothing ever
    // — which looks identical from an assertion that only checks the seed is still
    // there, and would leave the block saying "asking the store how it is" for the
    // life of the window.
    harness.read.requestRead("subscribe");
    await fireScheduledRead(harness);

    harness.adapter.releaseEstimate(0, 9_000);
    await crossMacrotaskBoundary();

    expect(renderedUsageBytes(harness.read)).toBe(9_000);
    harness.read.dispose();
  });

  it("carries a rejected estimate to the unreadable arm rather than holding the seed", async () => {
    // A store that cannot describe itself is a state a person on a broken adapter is
    // in. Driven through the shipped adapter's own closed-store refusal rather than a
    // thrown literal, so what the block renders is the code an author would grep for.
    const adapter = new MemoryPersistenceAdapter();
    const clock = new ManualClock();
    const read = new StoreStateRead({ uiStateStore: new UiStateStore({ adapter, clock }), clock });
    adapter.close();

    read.requestRead("subscribe");
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();

    expect(read.snapshot().kind).toBe("unreadable");
    read.dispose();
  });

  it("harness integrity: the reading is armed on the manual clock and nothing else", () => {
    // The cases above measure debounce windows in frozen milliseconds, which only
    // means anything if the schedule is on the clock they advance. A real clock here
    // would make every advance a no-op the assertions would not notice.
    harness.read.requestRead("subscribe");

    expect(harness.clock.pendingCount).toBe(1);
    expect(harness.adapter.startedReadCount).toBe(0);
    harness.read.dispose();
    expect(harness.clock.pendingCount).toBe(0);
  });
});
