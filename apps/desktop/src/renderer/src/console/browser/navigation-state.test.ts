// The address guard, and the one reading the chrome is allowed to derive from.
//
// The guard gets exhaustive cases because it has exactly one catastrophic failure and
// it is silent: a spelling it misses is a page navigated to a local file, which looks
// like a successful navigation to everything above it. So the cases are the FORMS
// rather than the concept — scheme, POSIX root, home shorthand, and the five Windows
// roots that are not one leading pair of backslashes (drive-absolute, drive-relative,
// bare drive, root-relative, UNC in either separator) — each with the whitespace a
// paste carries, and beside them the ordinary web destinations the field exists to
// accept, including the one that carries a colon of its own.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_SCENARIO } from "../bridge/scenarios/browser.js";
import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../core/index.js";
import {
  isFilesystemDestination,
  useReportedNavigation,
  type NavigationReading,
} from "./navigation-state.js";

/** The refusal an arm carries, or nothing — so a case reads one field, not a switch. */
function refusalOf(reading: NavigationReading): ConsoleRefusal | undefined {
  return reading.status === "refused" ? reading.refusal : undefined;
}

/** The reported state, and deliberately nothing from any other arm. */
function reportedStateOf(reading: NavigationReading): NavigationEvent | undefined {
  return reading.status === "reported" ? reading.state : undefined;
}

/**
 * Every local-path spelling, named by its FORM and paired with the verdict the
 * address field owes it.
 *
 * A table keyed by form rather than a list of examples, because the forms are what
 * differ between platforms and a list invites the reader to check the ones that look
 * alike. The Windows rows are the reason the table exists: a drive-relative
 * `C:secret.txt` and a root-relative `\\Windows\\System32` carry neither the separator
 * after the colon nor the doubled leading backslash an earlier reading required, so
 * both were dispatched as web destinations.
 *
 * The false rows sit in the same table rather than in a control of their own so that
 * a widening which starts refusing ordinary web destinations fails here, in the place
 * a reader compares the two against each other.
 */
const DESTINATION_FORMS: readonly {
  readonly form: string;
  readonly destination: string;
  readonly isLocal: boolean;
}[] = [
  { form: "file scheme", destination: "file:///etc/hosts", isLocal: true },
  {
    form: "file scheme, upper case, naming a drive",
    destination: "FILE://C:/Windows",
    isLocal: true,
  },
  { form: "POSIX absolute", destination: "/etc/hosts", isLocal: true },
  { form: "POSIX root itself", destination: "/", isLocal: true },
  { form: "home shorthand", destination: "~/Documents/report.pdf", isLocal: true },
  { form: "home itself", destination: "~", isLocal: true },
  {
    form: "Windows drive-absolute, backslash",
    destination: "C:\\Windows\\System32",
    isLocal: true,
  },
  { form: "Windows drive-absolute, forward slash", destination: "c:/Windows", isLocal: true },
  { form: "Windows drive-relative", destination: "C:secret.txt", isLocal: true },
  { form: "Windows bare drive", destination: "D:", isLocal: true },
  { form: "Windows root-relative", destination: "\\Windows\\System32", isLocal: true },
  { form: "Windows root-relative, forward slash", destination: "/Windows/System32", isLocal: true },
  { form: "UNC share, backslash", destination: "\\\\server\\share\\secret.txt", isLocal: true },
  { form: "UNC share, forward slash", destination: "//server/share/secret.txt", isLocal: true },
  { form: "Windows extended-length prefix", destination: "\\\\?\\C:\\secret.txt", isLocal: true },
  { form: "Windows device namespace", destination: "\\\\.\\pipe\\name", isLocal: true },
  { form: "https destination", destination: "https://example.invalid/page", isLocal: false },
  { form: "bare host", destination: "example.invalid", isLocal: false },
  {
    form: "host and port, which also carries a colon",
    destination: "example.invalid:8443/page",
    isLocal: false,
  },
  { form: "loopback with a port", destination: "http://localhost:5173/", isLocal: false },
  { form: "empty field", destination: "", isLocal: false },
];

describe("isFilesystemDestination", () => {
  it.each(DESTINATION_FORMS)("$form", ({ destination, isLocal }) => {
    expect(isFilesystemDestination(destination)).toBe(isLocal);
  });

  it("is not fooled by the whitespace a paste carries", () => {
    expect(isFilesystemDestination("  /etc/hosts  ")).toBe(true);
    expect(isFilesystemDestination("\tfile:///etc/hosts\n")).toBe(true);
  });

  it("negative control: the table admits as well as refuses", () => {
    // Without this, a guard that refused EVERYTHING would satisfy every true row
    // above and would also make the address field inert — and a table read row by
    // row is exactly where that goes unnoticed.
    expect(DESTINATION_FORMS.filter((row) => !row.isLocal).length).toBeGreaterThan(0);
    expect(DESTINATION_FORMS.some((row) => row.isLocal)).toBe(true);
  });

  it("does not mistake a scheme that merely starts with the same letters", () => {
    expect(isFilesystemDestination("filesystem-notes.example.invalid")).toBe(false);
  });
});

describe("useReportedNavigation", () => {
  it("reports the port's refusal and no state, which is what the wire answers today", async () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    await waitFor(() => {
      expect(refusalOf(result.current)).toBeDefined();
    });
    expect(refusalOf(result.current)?.code).toBe("wire-unregistered");
    // The half that matters to the chrome: no state means no navigability, so every
    // history control stays disabled rather than optimistically live.
    expect(reportedStateOf(result.current)).toBeUndefined();
  });

  it("starts with neither, so nothing renders a reading before one arrives", () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    expect(result.current).toStrictEqual({ status: "unread" });
  });
});

// The stream that is served after nobody is listening, and the stream that breaks.
//
// A subscription is a resource with two ends, and the renderer only ever holds one
// of them. Between the call and its answer the pane can go, and the cleanup that
// runs in that window has nothing to close — so the arriving stream is closed by the
// arrival or by nothing at all, and "by nothing at all" costs one live bridge
// subscription and one live producer per open/close cycle, forever.
//
// The same call can also REJECT, and a served iterator can throw part-way through.
// Both were detached rejections nobody handled, and both left the pane in the state
// it holds before any read answers — no reading, no refusal — so every history
// control stayed disabled with nothing on screen saying why.

type SubscribeOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSubscribeNavigation"]>>;
type NavigationStream = Extract<SubscribeOutcome, { readonly status: "served" }>["value"];
type NavigationEvent =
  NavigationStream["events"] extends AsyncIterable<infer Event> ? Event : never;

/** One reported page, for the cases that need the served arm to actually report. */
const REPORTED_PAGE: NavigationEvent = {
  url: "https://example.invalid/page",
  title: "Page",
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
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
function deferredSubscription(options: DeferredSubscriptionOptions = {}): {
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

describe("useReportedNavigation — a subscription that answers after the pane has gone", () => {
  it("closes it, because the cleanup that ran had nothing to close", async () => {
    const { bridge, serve, close } = deferredSubscription();
    const { unmount } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    unmount();
    serve();
    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("negative control: a stream served to a live pane is drained, not closed on arrival", async () => {
    // Without this, closing every served stream on sight would satisfy the case
    // above and would also make the subscription useless: no reading would ever
    // reach the chrome, and every history control would stay disabled forever.
    const { bridge, serve, close } = deferredSubscription({
      events: [REPORTED_PAGE],
      staysOpen: true,
    });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    serve();
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(REPORTED_PAGE);
    });
    expect(close).not.toHaveBeenCalled();
  });
});

// The producer that simply finishes.
//
// Not a failure, and not nothing: the pane WAS being told where the page is and is
// not being told now. Falling out of the loop left the bridge handle allocated until
// unmount and left the chrome holding the last frame — a URL in the address field, a
// history flag on each control — as though a subscription were still behind them.
describe("useReportedNavigation — a subscription that ends", () => {
  it("closes the stream once and says the reading is over", async () => {
    const subscription = deferredSubscription({ events: [REPORTED_PAGE], staysOpen: true });
    const { result } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );
    subscription.serve();
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(REPORTED_PAGE);
    });

    subscription.finish();

    await waitFor(() => {
      expect(result.current.status).toBe("ended");
    });
    expect(subscription.close).toHaveBeenCalledTimes(1);
    // The half the chrome reads: an ended subscription hands it no state, so nothing
    // it drew off the last frame outlives the producer.
    expect(reportedStateOf(result.current)).toBeUndefined();
    expect(refusalOf(result.current)).toBeUndefined();
  });

  it("ends the same way when the producer never reported anything at all", async () => {
    const subscription = deferredSubscription();
    const { result } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );

    subscription.serve();

    await waitFor(() => {
      expect(result.current.status).toBe("ended");
    });
    expect(subscription.close).toHaveBeenCalledTimes(1);
  });

  it("negative control: an unmounted pane publishes no ending and closes once", async () => {
    // The cleanup already closed the stream, and there is no surface left to tell. A
    // second close here would be the double-close the one-owner rule exists to
    // prevent, and a state write would be a report nobody sees.
    const subscription = deferredSubscription({ events: [REPORTED_PAGE], staysOpen: true });
    const { result, unmount } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );
    subscription.serve();
    await waitFor(() => {
      expect(result.current.status).toBe("reported");
    });

    unmount();
    subscription.finish();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("reported");
  });
});

// What a rejecting subscription refuses AS.
//
// The hook normalizes through `core/refusal.ts`'s `normalizeWireRejection`, which is
// the console's one rejection normalizer, and supplies only the pair that names this
// failure's own remedy. A second mapping stood in this module and re-derived three of
// that function's four arms; the case it was missing is the first one below, and it
// is what makes this block a control on the dedup rather than a restatement of it.
describe("useReportedNavigation — a subscription that rejects", () => {
  /** The refusal the hook settles on for a rejection, however the rejection arrived. */
  async function refusalForRejection(failure: unknown): Promise<ConsoleRefusal> {
    const subscription = deferredSubscription();
    const { result } = renderHook(() =>
      useReportedNavigation(subscription.bridge, "pane-browser-1"),
    );

    subscription.reject(failure);

    await waitFor(() => {
      expect(refusalOf(result.current)).toBeDefined();
    });
    const settled = refusalOf(result.current);
    if (settled === undefined) {
      throw new Error("the hook settled on no refusal after the subscription rejected");
    }
    return settled;
  }

  it("passes a refusal that travelled as a rejection through untouched", async () => {
    // The arm the retired mapping did not have: a refusal already names its own
    // author and code, and re-coding it here replaced the one a person would paste
    // into an issue with this module's generic pair.
    const raised = refuse("browser-view-host", "view-host-gone", "The host view was torn down.");

    expect(await refusalForRejection(raised)).toStrictEqual(raised);
  });

  it("keeps a typed wire envelope's own code and message", async () => {
    // Flattening `browser.pane_not_found` into this module's code would throw away
    // the only actionable half — a missing pane and a dead transport are different
    // next moves.
    expect(
      await refusalForRejection({ code: "browser.pane_not_found", message: "No such pane." }),
    ).toStrictEqual({
      code: "browser.pane_not_found",
      detail: "No such pane.",
      origin: "browser-navigation",
    });
  });

  it("refuses an untyped rejection under this module's own pair", async () => {
    const refusal = await refusalForRejection(new Error("the preload went away"));

    expect(refusal.code).toBe("navigation-subscription-failed");
    expect(refusal.origin).toBe("browser-navigation");
    // The sentence names the remedy for a subscription that stopped, which is a
    // different remedy from retrying one control.
    expect(refusal.detail).toContain("Closing the pane and opening it again");
  });

  it("negative control: the three arms do not all answer the same refusal", async () => {
    // Every case above reads one field of one arm, and all of them would pass over a
    // normalizer that answered a single constant. This is the case that fails on one.
    const codes = [
      (await refusalForRejection(refuse("browser-view-host", "view-host-gone", "Torn down."))).code,
      (await refusalForRejection({ code: "browser.pane_not_found", message: "No such pane." }))
        .code,
      (await refusalForRejection(new Error("the preload went away"))).code,
    ];

    expect(new Set(codes).size).toBe(codes.length);
  });
});

// The reading that outlived its subject.
//
// A hook instance is reused across a prop change: a deck that swaps which pane a slot
// holds hands the same instance a different `paneId`, and the effect replaces the
// subscription while the state still holds the previous pane's frame. Until the
// replacement produces one — which can be never, for a pane whose producer is slow or
// silent — the chrome drew the OLD page's URL and enabled its history controls, and
// dispatched Back and Forward against the NEW pane. One pane's reading driving
// another pane's acts, and nothing on screen saying so.
describe("useReportedNavigation — a subject that changes under the hook", () => {
  /** The page the first pane reports, and the one the second does. Distinct on every field a control reads. */
  const FIRST_PANE_PAGE: NavigationEvent = REPORTED_PAGE;
  const SECOND_PANE_PAGE: NavigationEvent = {
    url: "https://second.invalid/other",
    title: "Other",
    isLoading: false,
    canGoBack: false,
    canGoForward: true,
  };

  interface PaneStream {
    /** Push one frame down this pane's own stream, whenever the test says so. */
    readonly emit: (state: NavigationEvent) => void;
    readonly close: ReturnType<typeof vi.fn>;
  }

  /**
   * A bridge that serves ONE live stream per `paneId`, each pushed by the test.
   *
   * Per-pane rather than the single deferred settlement above, because the subject is
   * two subscriptions existing at once: the case is what the hook returns between the
   * pane changing and the second stream reporting, and a fixture with one stream
   * cannot pose it. The streams stay open — a producer that returns as soon as its
   * script runs out is one that has already ended, which is a different arm.
   */
  function perPaneSubscriptions(): {
    readonly bridge: ConsoleBridge;
    readonly forPane: (paneId: string) => PaneStream;
  } {
    const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const streams = new Map<string, { readonly stream: NavigationStream } & PaneStream>();
    const forPane = (paneId: string): { readonly stream: NavigationStream } & PaneStream => {
      const existing = streams.get(paneId);
      if (existing !== undefined) {
        return existing;
      }
      const queued: NavigationEvent[] = [];
      let wake: (() => void) | undefined;
      const close = vi.fn();
      const entry = {
        close,
        emit: (state: NavigationEvent): void => {
          queued.push(state);
          wake?.();
        },
        stream: {
          events: {
            async *[Symbol.asyncIterator](): AsyncGenerator<NavigationEvent> {
              for (;;) {
                for (const state of queued.splice(0)) {
                  yield state;
                }
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
            },
          },
          close,
        } satisfies NavigationStream,
      };
      streams.set(paneId, entry);
      return entry;
    };
    return {
      forPane,
      bridge: {
        ...base,
        growth: {
          ...base.growth,
          browserSubscribeNavigation: async (request: { readonly paneId: string }) => ({
            status: "served" as const,
            value: forPane(request.paneId).stream,
          }),
        },
      },
    };
  }

  it("reads unread the moment the pane changes, until the new stream's first frame", async () => {
    const subscriptions = perPaneSubscriptions();
    const { result, rerender } = renderHook(
      ({ paneId }: { readonly paneId: string }) =>
        useReportedNavigation(subscriptions.bridge, paneId),
      { initialProps: { paneId: "pane-browser-1" } },
    );
    subscriptions.forPane("pane-browser-1").emit(FIRST_PANE_PAGE);
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(FIRST_PANE_PAGE);
    });

    rerender({ paneId: "pane-browser-2" });

    // The finding. Without the stamp this is still the first pane's frame, so the
    // address field shows its URL and Back is enabled — against the second pane.
    expect(result.current).toStrictEqual({ status: "unread" });

    subscriptions.forPane("pane-browser-2").emit(SECOND_PANE_PAGE);
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(SECOND_PANE_PAGE);
    });
  });

  it("drops a frame the pane that left reports after the change", async () => {
    const subscriptions = perPaneSubscriptions();
    const { result, rerender } = renderHook(
      ({ paneId }: { readonly paneId: string }) =>
        useReportedNavigation(subscriptions.bridge, paneId),
      { initialProps: { paneId: "pane-browser-1" } },
    );
    subscriptions.forPane("pane-browser-1").emit(FIRST_PANE_PAGE);
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(FIRST_PANE_PAGE);
    });

    rerender({ paneId: "pane-browser-2" });
    subscriptions.forPane("pane-browser-1").emit({
      ...FIRST_PANE_PAGE,
      url: "https://example.invalid/moved-on",
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    // A late frame carries the stamp of the subject it was read under, so it reaches
    // no render for a different one.
    expect(result.current).toStrictEqual({ status: "unread" });
    expect(reportedStateOf(result.current)).toBeUndefined();
  });

  it("reads unread when the BRIDGE changes under an unchanged pane id", async () => {
    // The other half of the subject. A pane id is not unique across bridges, and a
    // replaced bridge is a replaced transport: the frames the previous one reported
    // are not this one's.
    const first = perPaneSubscriptions();
    const second = perPaneSubscriptions();
    const { result, rerender } = renderHook(
      ({ bridge }: { readonly bridge: ConsoleBridge }) =>
        useReportedNavigation(bridge, "pane-browser-1"),
      { initialProps: { bridge: first.bridge } },
    );
    first.forPane("pane-browser-1").emit(FIRST_PANE_PAGE);
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(FIRST_PANE_PAGE);
    });

    rerender({ bridge: second.bridge });

    expect(result.current).toStrictEqual({ status: "unread" });
  });

  it("negative control: a render under the SAME subject keeps the reading it had", async () => {
    // Without it, every case above would pass against a hook that answered `unread`
    // on every render — which is a pane that never shows a URL at all.
    const subscriptions = perPaneSubscriptions();
    const { result, rerender } = renderHook(
      ({ paneId }: { readonly paneId: string }) =>
        useReportedNavigation(subscriptions.bridge, paneId),
      { initialProps: { paneId: "pane-browser-1" } },
    );
    subscriptions.forPane("pane-browser-1").emit(FIRST_PANE_PAGE);
    await waitFor(() => {
      expect(reportedStateOf(result.current)).toStrictEqual(FIRST_PANE_PAGE);
    });

    rerender({ paneId: "pane-browser-1" });

    expect(reportedStateOf(result.current)).toStrictEqual(FIRST_PANE_PAGE);
  });
});
