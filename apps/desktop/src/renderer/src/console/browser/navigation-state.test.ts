// The address guard, and the one reading the chrome is allowed to derive from.
//
// The guard gets exhaustive cases because it has exactly one catastrophic failure and
// it is silent: a spelling it misses is a page navigated to a local file, which looks
// like a successful navigation to everything above it. So the cases are the spellings
// rather than the concept — scheme, POSIX root, home shorthand, UNC share, drive
// letter, and each with the whitespace a paste carries — and the negative control is
// the ordinary web destination the field exists to accept.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_SCENARIO } from "../bridge/scenarios/browser.js";
import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { isFilesystemDestination, useReportedNavigation } from "./navigation-state.js";

describe("isFilesystemDestination", () => {
  it("catches every spelling of a place on this machine", () => {
    const local = [
      "file:///etc/hosts",
      "FILE://C:/Windows",
      "/etc/hosts",
      "/",
      "~/Documents/report.pdf",
      "~",
      "\\\\share\\folder",
      "C:\\Windows\\System32",
      "c:/Windows",
    ];
    for (const destination of local) {
      expect(isFilesystemDestination(destination)).toBe(true);
    }
  });

  it("is not fooled by the whitespace a paste carries", () => {
    expect(isFilesystemDestination("  /etc/hosts  ")).toBe(true);
    expect(isFilesystemDestination("\tfile:///etc/hosts\n")).toBe(true);
  });

  it("negative control: an ordinary web destination passes", () => {
    // Without this, a guard that refused everything would satisfy every case above
    // and would also make the address field inert.
    for (const destination of [
      "https://example.invalid/page",
      "example.invalid",
      "http://localhost:5173/",
      "",
    ]) {
      expect(isFilesystemDestination(destination)).toBe(false);
    }
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
      expect(result.current.refusal).toBeDefined();
    });
    expect(result.current.refusal?.code).toBe("wire-unregistered");
    // The half that matters to the chrome: no state means no navigability, so every
    // history control stays disabled rather than optimistically live.
    expect(result.current.state).toBeUndefined();
  });

  it("starts with neither, so nothing renders a reading before one arrives", () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    expect(result.current).toStrictEqual({ state: undefined, refusal: undefined });
  });
});

// The stream that is served after nobody is listening.
//
// A subscription is a resource with two ends, and the renderer only ever holds one
// of them. Between the call and its answer the pane can go, and the cleanup that
// runs in that window has nothing to close — so the arriving stream is closed by the
// arrival or by nothing at all, and "by nothing at all" costs one live bridge
// subscription and one live producer per open/close cycle, forever.
describe("useReportedNavigation — a subscription that answers after the pane has gone", () => {
  type SubscribeOutcome = Awaited<
    ReturnType<ConsoleBridge["growth"]["browserSubscribeNavigation"]>
  >;
  type NavigationStream = Extract<SubscribeOutcome, { readonly status: "served" }>["value"];
  type NavigationEvent =
    NavigationStream["events"] extends AsyncIterable<infer Event> ? Event : never;

  /**
   * A bridge whose navigation subscription answers when the TEST says so, and a
   * stream that records its own close. The pending promise is the whole subject:
   * the fixture port answers in a microtask, which is too fast to unmount inside.
   */
  function deferredSubscription(events: readonly NavigationEvent[] = []): {
    readonly bridge: ConsoleBridge;
    readonly serve: () => void;
    readonly close: ReturnType<typeof vi.fn>;
  } {
    const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const close = vi.fn();
    let answer: ((outcome: SubscribeOutcome) => void) | undefined;
    const stream: NavigationStream = {
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<NavigationEvent> {
          yield* events;
        },
      },
      close,
    };
    return {
      close,
      serve: () => {
        answer?.({ status: "served", value: stream });
      },
      bridge: {
        ...base,
        growth: {
          ...base.growth,
          browserSubscribeNavigation: async () =>
            new Promise<SubscribeOutcome>((resolve) => {
              answer = resolve;
            }),
        },
      },
    };
  }

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
    const reported: NavigationEvent = {
      url: "https://example.invalid/page",
      title: "Page",
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
    };
    const { bridge, serve, close } = deferredSubscription([reported]);
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    serve();
    await waitFor(() => {
      expect(result.current.state).toStrictEqual(reported);
    });
    expect(close).not.toHaveBeenCalled();
  });
});
