// The platform observers this family arms, under test control.
//
// `element-motion.ts` is the family's one `ResizeObserver` construction site, and
// three suites drive it: the seam's own, the overlay registry that arms it per
// overlay, and the geometry publisher that arms it over the pane host and every
// ancestor between that host and the document body. A fake per suite is the same
// duplication the seam itself exists to prevent — three fakes drift, and the one
// that drifts is the one whose suite then passes for the wrong reason.
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

/**
 * Let queued `MutationObserver` records reach their callback.
 *
 * A mutation observer never reports synchronously, so a test that asserted straight
 * after a DOM edit would read the state before delivery every time. A TASK turn and
 * not a microtask one — measured rather than assumed: the DOM implementation these
 * console tiers run on delivers records on a queued task, where the platform
 * delivers them at the end of the microtask checkpoint, and a microtask-only wait
 * reports zero deliveries here. The trailing microtask turn then lets whatever the
 * callback itself scheduled settle before the assertion reads it.
 */
export async function settleMutationRecords(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
}
