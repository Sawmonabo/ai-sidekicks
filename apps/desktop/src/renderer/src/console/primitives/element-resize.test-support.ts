// The size observer the console arms, under test control.
//
// `element-resize.ts` beside this file is the console's one `ResizeObserver`
// construction site, and four suites drive it: the seam's own callers in the browser
// family — the overlay registry, the pane geometry publisher, and the motion module
// that arms it over an ancestry — and the terminal emulator that re-fits its grid
// from it. A fake per suite is the same duplication the seam itself exists to
// prevent: four fakes drift, and the one that drifts is the one whose suite then
// passes for the wrong reason.
//
// IT LIVES BESIDE THE SEAM rather than in the family that first needed it. The fake
// follows the production module down the DAG, because a terminal suite reaching into
// `browser/` for it would be the lateral edge the hoist removed, in the test tier.
//
// DELIVERY IS TARGETED, not just broadcast. A caller that observes N elements
// arms N observers, so "an ancestor resized" and "everything resized" are
// different facts and a control that could only say the second could not tell a
// single ancestor's relayout from a window-wide one.

import { vi } from "vitest";

/** What a suite can ask of the installed fake. */
export interface FakeResizeObserverControl {
  /** Deliver a size change to every observer watching `target`. */
  deliverFor(target: Element): void;
  /** Deliver a size change to every live observer, in construction order. */
  deliverAll(): void;
  /** How many `observe` calls the fake has taken. */
  observedCount(): number;
  /** How many observers have been disconnected. */
  disconnectCount(): number;
  /** Observers constructed and not yet disconnected. Zero is "nothing is armed". */
  liveObserverCount(): number;
}

interface FakeObserverRecord {
  readonly deliver: () => void;
  readonly targets: Set<Element>;
  disconnected: boolean;
}

/**
 * Install a `ResizeObserver` the test drives.
 *
 * `vi.stubGlobal` rather than a constructor injected into the module under test,
 * because the seam reads `globalThis.ResizeObserver` at arm time — which is the
 * behaviour being checked, including its absence — and a caller that took the
 * constructor as an argument would be a different module.
 *
 * The caller restores the global with `vi.unstubAllGlobals()`; this returns the
 * control rather than a disposer so a suite already carrying that `afterEach`
 * gains no second teardown to forget.
 */
export function installFakeResizeObserver(): FakeResizeObserverControl {
  const records: FakeObserverRecord[] = [];
  let observedCount = 0;

  class FakeResizeObserver {
    readonly #record: FakeObserverRecord;

    public constructor(callback: () => void) {
      this.#record = {
        deliver: () => {
          callback();
        },
        targets: new Set<Element>(),
        disconnected: false,
      };
      records.push(this.#record);
    }

    public observe(target: Element): void {
      observedCount += 1;
      this.#record.targets.add(target);
    }

    public unobserve(target: Element): void {
      // The consumers disconnect rather than unobserving; present so the fake is
      // the shape the platform declares rather than the subset one caller uses.
      this.#record.targets.delete(target);
    }

    public disconnect(): void {
      this.#record.disconnected = true;
      this.#record.targets.clear();
    }
  }

  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    deliverFor: (target: Element) => {
      for (const record of records) {
        if (!record.disconnected && record.targets.has(target)) {
          record.deliver();
        }
      }
    },
    deliverAll: () => {
      for (const record of records) {
        if (!record.disconnected) {
          record.deliver();
        }
      }
    },
    observedCount: () => observedCount,
    disconnectCount: () => records.filter((record) => record.disconnected).length,
    liveObserverCount: () => records.filter((record) => !record.disconnected).length,
  };
}
