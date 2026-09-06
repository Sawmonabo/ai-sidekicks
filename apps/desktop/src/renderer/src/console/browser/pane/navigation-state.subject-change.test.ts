// The reading that outlived its subject.
//
// A hook instance is reused across a prop change: a deck that swaps which pane a slot
// holds hands the same instance a different `paneId`, and the effect replaces the
// subscription while the state still holds the previous pane's frame. Until the
// replacement produces one — which can be never, for a pane whose producer is slow or
// silent — the chrome drew the OLD page's URL and enabled its history controls, and
// dispatched Back and Forward against the NEW pane. One pane's reading driving
// another pane's acts, and nothing on screen saying so.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { useReportedNavigation } from "./navigation-state.js";
import {
  reportedStateOf,
  REPORTED_PAGE,
  type NavigationEvent,
  type NavigationStream,
} from "./navigation-state.test-support.js";

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
   * Per-pane rather than the single deferred settlement the sibling suites use,
   * because the subject is two subscriptions existing at once: the case is what the
   * hook returns between the pane changing and the second stream reporting, and a
   * fixture with one stream cannot pose it. The streams stay open — a producer that
   * returns as soon as its script runs out is one that has already ended, which is a
   * different arm.
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
    expect(result.current).toStrictEqual({ kind: "reading" });

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
    expect(result.current).toStrictEqual({ kind: "reading" });
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

    expect(result.current).toStrictEqual({ kind: "reading" });
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
