// The bridge shape the navigation cases pose against, and the two readers all of them use.
//
// A subscription is a resource with two ends and the renderer only ever holds one, so
// every case about one needs the settlement to be the TEST's to choose: the fixture
// port answers in a microtask, which is too fast to unmount or fail inside. The suites
// that pose that moment read one fixture here rather than each building its own.

import { vi } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { type NavigationReading } from "./navigation-state.js";

export type SubscribeOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["browserSubscribeNavigation"]>
>;
export type NavigationStream = Extract<SubscribeOutcome, { readonly status: "served" }>["value"];
export type NavigationEvent =
  NavigationStream["events"] extends AsyncIterable<infer Event> ? Event : never;

/** The refusal an arm carries, or nothing — so a case reads one field, not a switch. */
export function refusalOf(reading: NavigationReading): ConsoleRefusal | undefined {
  return reading.kind === "refused" ? reading.refusal : undefined;
}

/** The reported state, and deliberately nothing from any other arm. */
export function reportedStateOf(reading: NavigationReading): NavigationEvent | undefined {
  return reading.kind === "served" ? reading.state : undefined;
}

/** One reported page, for the cases that need the served arm to actually report. */
export const REPORTED_PAGE: NavigationEvent = {
  url: "https://example.invalid/page",
  title: "Page",
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
  loadProgress: null,
};

interface DeferredSubscriptionOptions {
  readonly events?: readonly NavigationEvent[];
  /** Thrown by the iterator once the events are drained — a producer that died. */
  readonly failsAfterEventsWith?: unknown;
  /**
   * Hold the iterator open after the events, until the test says the producer is
   * finished — which is what a live subscription does.
   *
   * A generator that returns as soon as its script runs out is a producer that has
   * ALREADY ended, so a case about the moment a subscription ends, or about what the
   * pane does while one is live, needs that moment to be the test's to choose.
   */
  readonly staysOpen?: boolean;
}

interface SubscriptionSettlement {
  readonly resolve: (outcome: SubscribeOutcome) => void;
  readonly reject: (failure: unknown) => void;
}

/**
 * A bridge whose navigation subscription settles when the TEST says so, and a stream
 * that records its own close. The pending promise is the whole subject: the fixture
 * port answers in a microtask, which is too fast to unmount or fail inside.
 */
export function deferredSubscription(options: DeferredSubscriptionOptions = {}): {
  readonly bridge: ConsoleBridge;
  readonly serve: () => void;
  readonly reject: (failure: unknown) => void;
  /** End a held-open producer, the way a daemon closing its side would. */
  readonly finish: () => void;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  const close = vi.fn();
  let settlement: SubscriptionSettlement | undefined;
  let finish: (() => void) | undefined;
  const heldOpen = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stream: NavigationStream = {
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<NavigationEvent> {
        yield* options.events ?? [];
        if (options.failsAfterEventsWith !== undefined) {
          throw options.failsAfterEventsWith;
        }
        if (options.staysOpen === true) {
          await heldOpen;
        }
      },
    },
    close,
  };
  return {
    close,
    finish: () => {
      finish?.();
    },
    serve: () => {
      settlement?.resolve({ status: "served", value: stream });
    },
    reject: (failure: unknown) => {
      settlement?.reject(failure);
    },
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        browserSubscribeNavigation: async () =>
          new Promise<SubscribeOutcome>((resolve, reject) => {
            settlement = { resolve, reject };
          }),
      },
    },
  };
}
