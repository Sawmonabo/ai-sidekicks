// The crashed-window signal: one subscription, and what a stop reaches while a
// request for one is still in flight.
//
// Split from `aux-handoff.test.ts`, which is about the four gates and the two sets a
// detach writes. Every case here is about ORDER — a reply that arrives after the
// watch it belongs to was stopped, a detach arriving behind a stop, a drain whose
// stream was closed underneath it — and each one is driven through the hand-off's
// own surface rather than through `PaneErrorWatch` directly, because the delegation
// is part of what has to hold: a lost window has to reach the same set a hand-written
// `noteWindowLost` writes.

import { describe, expect, it } from "vitest";

import { createRefusingGrowthPort, type GrowthPort } from "../bridge/growth-port.js";
import { lostWindowNotice, type LostAuxiliaryWindow } from "./aux-handoff-contract.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";
import { servingPort } from "./aux-handoff.test-support.js";

describe("AuxiliaryHandoff — the crashed-window signal", () => {
  /** A served pane-error stream that delivers exactly what the test lists. */
  function streamingPort(paneErrors: readonly { paneId: string; reason: string }[]): GrowthPort {
    return {
      ...servingPort(),
      windowSubscribePaneErrors: async () => ({
        status: "served",
        value: {
          events: (async function* deliver() {
            for (const paneError of paneErrors) {
              await Promise.resolve();
              yield paneError;
            }
          })(),
          close: () => undefined,
        },
      }),
    };
  }

  it("returns the pane to the deck when the signal names it, with the reason it named", async () => {
    // The only way a crashed window's pane comes back. Without a subscriber, the
    // window dying left the pane in a window nobody could focus — and without the
    // record below, it came back with nothing to say about why.
    const handoff = new AuxiliaryHandoff({
      growth: streamingPort([{ paneId: "pane-1", reason: "the window closed unexpectedly" }]),
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    expect(handoff.detached()).toHaveLength(1);

    await handoff.watchPaneErrors();

    expect(handoff.detached()).toHaveLength(0);
    expect(handoff.paneErrorRefusal).toBeUndefined();
    expect(lostWindowNotice(handoff.lostWindows()[0] as LostAuxiliaryWindow)).toStrictEqual(
      expect.objectContaining({
        code: "window-lost",
        detail: "the window closed unexpectedly",
      }),
    );
  });

  it("negative control: a pane the signal did not name stays in its window", async () => {
    // Without this, the case above would pass over a watcher that returned every
    // detached pane the moment any error arrived.
    const handoff = new AuxiliaryHandoff({
      growth: streamingPort([{ paneId: "pane-other", reason: "the window closed unexpectedly" }]),
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    await handoff.watchPaneErrors();

    expect(handoff.detached()).toHaveLength(1);
  });

  it("keeps the refusal where the signal is not served, rather than reading it as calm", async () => {
    const handoff = new AuxiliaryHandoff({
      growth: {
        ...createRefusingGrowthPort(),
        windowDetachPane: async () => ({ status: "served", value: { windowId: "aux-1" } }),
      },
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    await handoff.watchPaneErrors();

    expect(handoff.paneErrorRefusal?.code).toBe("wire-unregistered");
    expect(handoff.detached()).toHaveLength(1);
  });

  /**
   * A port whose subscription request the test decides the settlement of, and which
   * records every stream it handed out plus whether that stream was closed.
   *
   * The three cases below are all about ORDER — what a stop reaches while a request is
   * still in flight — so the request has to be held open, and the assertion has to be
   * about the streams themselves rather than about what the handoff happened to
   * publish afterwards.
   */
  function heldSubscriptionPort(): {
    readonly port: GrowthPort;
    /** Settle the oldest unsettled request. */
    readonly settleNext: () => void;
    readonly streams: { closed: boolean; drained: boolean }[];
  } {
    const settlers: (() => void)[] = [];
    const streams: { closed: boolean; drained: boolean }[] = [];
    return {
      streams,
      settleNext: () => {
        settlers.shift()?.();
      },
      port: {
        ...servingPort(),
        windowSubscribePaneErrors: async () => {
          await new Promise<void>((resolve) => {
            settlers.push(resolve);
          });
          const stream = { closed: false, drained: false };
          streams.push(stream);
          return {
            status: "served",
            value: {
              events: (async function* deliver() {
                stream.drained = true;
                // Never ends on its own: a watch is closed, not waited out.
                await new Promise<void>(() => undefined);
                yield { paneId: "pane-never", reason: "unreachable" };
              })(),
              close: () => {
                stream.closed = true;
              },
            },
          };
        },
      },
    };
  }

  /** Let the held request's continuation run, without advancing any timer. */
  async function drainMicrotasks(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) {
      await Promise.resolve();
    }
  }

  it("closes a subscription that arrives after the watch was stopped, and drains nothing", async () => {
    // The defect: the stop saw no installed stream, so it could neither cancel nor
    // invalidate the request — and the response then installed a stream and drained
    // it for a window with nothing detached.
    const held = heldSubscriptionPort();
    const handoff = new AuxiliaryHandoff({ growth: held.port });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    void handoff.watchPaneErrors();
    await drainMicrotasks();
    handoff.stopWatchingPaneErrors();
    held.settleNext();
    await drainMicrotasks();

    expect(held.streams).toHaveLength(1);
    expect(held.streams[0]?.closed).toBe(true);
    expect(held.streams[0]?.drained).toBe(false);
  });

  it("holds exactly one stream open through a detach, a stop, and a second detach", async () => {
    // The leak: the guard recorded only the RESOLVED stream, so a detach arriving
    // while the first request was in flight started a second subscription and one of
    // the two was left open with nobody holding it.
    const held = heldSubscriptionPort();
    const handoff = new AuxiliaryHandoff({ growth: held.port });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    void handoff.watchPaneErrors();
    await drainMicrotasks();
    handoff.stopWatchingPaneErrors();
    void handoff.watchPaneErrors();
    await drainMicrotasks();

    held.settleNext();
    held.settleNext();
    await drainMicrotasks();

    expect(held.streams).toHaveLength(2);
    const live = held.streams.filter((stream) => !stream.closed);
    expect(live).toHaveLength(1);
    expect(live[0]?.drained).toBe(true);
  });

  it("negative control: a second watch while the first is still in flight asks once", async () => {
    // Without this, the case above would pass over a guard that started a fresh
    // subscription on every call and merely closed the extras afterwards.
    const held = heldSubscriptionPort();
    const handoff = new AuxiliaryHandoff({ growth: held.port });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    void handoff.watchPaneErrors();
    void handoff.watchPaneErrors();
    await drainMicrotasks();
    held.settleNext();
    held.settleNext();
    await drainMicrotasks();

    expect(held.streams).toHaveLength(1);
    expect(held.streams[0]?.closed).toBe(false);
  });

  it("negative control: an uninterrupted watch installs its stream and drains it", async () => {
    // Without this, every case above would pass over a watch that closed whatever it
    // opened and never received a crash at all.
    const held = heldSubscriptionPort();
    const handoff = new AuxiliaryHandoff({ growth: held.port });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    void handoff.watchPaneErrors();
    await drainMicrotasks();
    held.settleNext();
    await drainMicrotasks();

    expect(held.streams).toHaveLength(1);
    expect(held.streams[0]?.closed).toBe(false);
    expect(held.streams[0]?.drained).toBe(true);
  });

  it("says so when the signal itself ends in a failure", async () => {
    const handoff = new AuxiliaryHandoff({
      growth: {
        ...servingPort(),
        windowSubscribePaneErrors: async () => ({
          status: "served",
          value: {
            // An iterable that throws on its first pull, which is what a channel
            // dropping under an open subscription looks like from this side.
            events: {
              [Symbol.asyncIterator]: () => ({
                next: () => Promise.reject(new Error("the channel dropped")),
              }),
            },
            close: () => undefined,
          },
        }),
      },
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    await handoff.watchPaneErrors();

    expect(handoff.paneErrorRefusal?.detail).toContain("the channel dropped");
  });

  /**
   * A served signal whose delivery can be made to fail, per stream and on demand.
   *
   * The two cases below are about WHOSE failure it was: closing a stream is what makes
   * its drain throw, and a stop closes one, so a drain that reports its own failure
   * without asking whether it is still the watch reports it over whatever was opened
   * behind that stop.
   */
  function abortableSignalPort(): {
    readonly port: GrowthPort;
    /** Fail delivery on the stream opened at `position`, without closing the watch. */
    readonly failDeliveryOn: (position: number) => void;
    readonly openedCount: () => number;
  } {
    const failures: ((reason: unknown) => void)[] = [];
    return {
      failDeliveryOn: (position) => {
        failures[position]?.(new Error("the channel dropped"));
      },
      openedCount: () => failures.length,
      port: {
        ...servingPort(),
        windowSubscribePaneErrors: async () => {
          let failDelivery: (reason: unknown) => void = () => undefined;
          // Never resolves: a signal delivers or it fails, and a watch is closed
          // rather than waited out.
          const pull = new Promise<never>((_resolve, reject) => {
            failDelivery = reject;
          });
          failures.push(failDelivery);
          return {
            status: "served",
            value: {
              events: { [Symbol.asyncIterator]: () => ({ next: () => pull }) },
              close: () => {
                failDelivery(new Error("the channel dropped"));
              },
            },
          };
        },
      },
    };
  }

  it("does not report a superseded drain's failure over the watch that replaced it", async () => {
    // The defect: the claim was released at the reply, so the drain — which runs for
    // the whole life of the subscription — held no generation. A stop closes the
    // stream, the close makes the drain throw, and a detach arriving right behind that
    // stop has already installed a healthy signal by the time the throw is caught. The
    // placeholder then said the crash signal had stopped while it was delivering.
    const held = abortableSignalPort();
    const handoff = new AuxiliaryHandoff({ growth: held.port });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    void handoff.watchPaneErrors();
    await drainMicrotasks();
    handoff.stopWatchingPaneErrors();
    void handoff.watchPaneErrors();
    await drainMicrotasks();

    expect(held.openedCount()).toBe(2);
    expect(handoff.paneErrorRefusal).toBeUndefined();
    // And the healthy stream is still the installed one: the stale drain's clear is a
    // settlement too, and it went nowhere.
    handoff.stopWatchingPaneErrors();
    await drainMicrotasks();
    expect(handoff.paneErrorRefusal).toBeUndefined();
  });

  it("negative control: a drain that fails while it IS the watch says so", async () => {
    // Without this, the case above would pass over a drain whose catch wrote nothing
    // at all, and a signal that really dropped would end in silence.
    const held = abortableSignalPort();
    const handoff = new AuxiliaryHandoff({ growth: held.port });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    void handoff.watchPaneErrors();
    await drainMicrotasks();
    held.failDeliveryOn(0);
    await drainMicrotasks();

    expect(handoff.paneErrorRefusal?.detail).toContain("the channel dropped");
  });
});
