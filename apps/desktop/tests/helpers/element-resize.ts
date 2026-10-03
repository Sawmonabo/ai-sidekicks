// The size observer the app arms, under test control.
//
// `lib/element-resize.ts` is the app's one `ResizeObserver` construction site, and more than one
// suite drives it, so one fake lives here: per-suite fakes drift, and the one that drifts passes
// for the wrong reason.
//
// Delivery is targeted, not just broadcast: a caller observing N elements arms N observers, so
// "an ancestor resized" and "everything resized" are different facts.

import { vi } from "vitest";

/** What a suite can ask of the installed fake. */
export interface FakeResizeObserverControl {
  /** Deliver a size change to every observer watching `target`. */
  deliverFor(target: Element): void;
  /** Observers constructed and not yet disconnected. Zero is "nothing is armed". */
  liveObserverCount(): number;
}

/**
 * Installs a `ResizeObserver` the test drives.
 *
 * `vi.stubGlobal` rather than an injected constructor, because the seam reads
 * `globalThis.ResizeObserver` at arm time, including its absence. The caller restores with
 * `vi.unstubAllGlobals()`; this returns the control rather than a disposer so a suite already
 * carrying that `afterEach` gains no second teardown to forget.
 */
export function installFakeResizeObserver(): FakeResizeObserverControl {
  const records: FakeObserverRecord[] = [];

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
      this.#record.targets.add(target);
    }

    public unobserve(target: Element): void {
      // The consumers disconnect instead; present so the fake has the platform's declared shape.
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
    liveObserverCount: () => records.filter((record) => !record.disconnected).length,
  };
}

interface FakeObserverRecord {
  readonly deliver: () => void;
  readonly targets: Set<Element>;
  disconnected: boolean;
}
