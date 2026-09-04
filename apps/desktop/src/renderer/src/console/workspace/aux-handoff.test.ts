// Tearing a pane off into its own window, and the four different ways it is refused.
//
// The gates run in a fixed order and each one produces a DIFFERENT refusal, which
// is the whole point: "this kind cannot be detached", "this build cannot do it
// yet", "this pane does not name enough of a session", and "the wire is not
// registered" are four different sentences a person acts on differently. A single
// generic failure would collapse them into one shrug.

import { describe, expect, it } from "vitest";

import { createRefusingGrowthPort, type GrowthPort } from "../bridge/growth-port.js";
import { IMPLEMENTED_AUXILIARY_ROUTES } from "../../../../shared/auxiliary-routes.js";
import { lostWindowNotice, type LostAuxiliaryWindow } from "./aux-handoff-contract.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";

/** A port that serves the three window operations and refuses everything else. */
function servingPort(windowId = "aux-window-1"): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    windowDetachPane: async () => ({ status: "served", value: { windowId } }),
    windowFocusAuxiliary: async () => ({ status: "served", value: undefined }),
    windowCloseAuxiliary: async () => ({ status: "served", value: undefined }),
  };
}

describe("AuxiliaryHandoff — what can be detached at all", () => {
  it("answers for a route this build implements without attempting anything", () => {
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    expect(handoff.canDetach("timeline")).toBe(true);
    expect(handoff.routeLabel("timeline")).toBe("Timeline");
  });

  it("says no to a kind that is not an auxiliary route, and offers it no label", () => {
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    expect(handoff.canDetach("terminal")).toBe(false);
    expect(handoff.routeLabel("terminal")).toBeUndefined();
  });

  it("says no to a route this build has not implemented yet", () => {
    // `agent-console` is a route in the closed set and is deliberately absent from
    // the implemented list until its body lands. The two facts are separate, and
    // this is the case that proves the second one is consulted.
    expect(IMPLEMENTED_AUXILIARY_ROUTES).not.toContain("agent-console");
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    expect(handoff.canDetach("agent-console")).toBe(false);
  });
});

describe("AuxiliaryHandoff — the four gates, in order", () => {
  it("refuses a kind that is no route at all", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "terminal",
      sessionId: "session-1",
    });
    expect(outcome.outcome).toBe("refused");
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("kind-not-detachable");
  });

  it("refuses a route whose body has not shipped, before touching the wire", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "agent-console",
      sessionId: "session-1",
      agentId: "agent-1",
    });
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("route-not-implemented");
  });

  it("refuses a target the route's own grammar rejects, and echoes none of it", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const outcome = await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "" });
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("target-context-invalid");
    // The offending value is untrusted input the grammar refused; a refusal that
    // quoted it back would put it on screen.
    expect(outcome.outcome === "refused" && outcome.refusal.detail).not.toContain('""');
  });

  it("refuses when the wire is not registered, and says whose it is", async () => {
    const handoff = new AuxiliaryHandoff({ growth: createRefusingGrowthPort() });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });
    expect(outcome.outcome === "refused" && outcome.refusal.code).toBe("wire-unregistered");
    expect(handoff.detached()).toHaveLength(0);
  });

  it("negative control: all four gates pass and the pane is detached", async () => {
    // Without this, every case above would pass over a hand-off that refused
    // unconditionally, which is the one implementation that could never work.
    const handoff = new AuxiliaryHandoff({ growth: servingPort("aux-7") });
    const outcome = await handoff.detach({
      paneId: "pane-1",
      kind: "timeline",
      sessionId: "session-1",
    });
    expect(outcome.outcome).toBe("detached");
    expect(handoff.detachedPane("pane-1")?.windowId).toBe("aux-7");
    expect(handoff.detachedPane("pane-1")?.fragment).toContain("timeline");
  });
});

describe("AuxiliaryHandoff — the pane comes back", () => {
  it("drops the local record even when the close could not be delivered", async () => {
    // A window this process can no longer reach is a window whose pane must return
    // to the deck: leaving the placeholder up strands the pane somewhere nobody can
    // focus, which is strictly worse than one stray window.
    const handoff = new AuxiliaryHandoff({
      growth: {
        ...createRefusingGrowthPort(),
        windowDetachPane: async () => ({ status: "served", value: { windowId: "aux-1" } }),
      },
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    const refusal = await handoff.returnToDeck("pane-1");
    expect(refusal?.code).toBe("wire-unregistered");
    expect(handoff.detached()).toHaveLength(0);
  });

  it("returns the pane and keeps the reason when a window is lost rather than closed", async () => {
    // The reason is kept ON THE HAND-OFF and not merely handed back. A record returned
    // to the drain loop and held nowhere is gone by the time the deck draws the slot
    // it belongs in, which is exactly how the crash detail used to disappear.
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    const lost = handoff.noteWindowLost("pane-1", "the window closed unexpectedly");
    expect(lost?.lostReason).toBe("the window closed unexpectedly");
    expect(handoff.detached()).toHaveLength(0);
    expect(handoff.lostWindow("pane-1")?.lostReason).toBe("the window closed unexpectedly");
    expect(handoff.lostWindows()).toHaveLength(1);
  });

  it("publishes the loss, so a surface subscribed to it hears about the crash", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    const readsAtPublish: (string | undefined)[] = [];
    const unsubscribe = handoff.subscribe(() => {
      readsAtPublish.push(handoff.lostWindow("pane-1")?.lostReason);
    });

    handoff.noteWindowLost("pane-1", "the window closed unexpectedly");
    unsubscribe();

    // The record is stored BEFORE the publish, so the first read a subscriber takes
    // already carries it rather than seeing the pane back with nothing to say.
    expect(readsAtPublish).toStrictEqual(["the window closed unexpectedly"]);
  });

  it("clears the crash record when the same pane is detached again", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    handoff.noteWindowLost("pane-1", "the window closed unexpectedly");

    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    // The body is in a window again, so a note about the last window it was in is a
    // note about nothing.
    expect(handoff.lostWindow("pane-1")).toBeUndefined();
    expect(handoff.detached()).toHaveLength(1);
  });

  it("clears the crash record when the person dismisses it, and publishes that", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    handoff.noteWindowLost("pane-1", "the window closed unexpectedly");
    let publishCount = 0;
    const unsubscribe = handoff.subscribe(() => {
      publishCount += 1;
    });

    handoff.dismissLostWindow("pane-1");
    handoff.dismissLostWindow("pane-1");
    unsubscribe();

    expect(handoff.lostWindows()).toHaveLength(0);
    // Once, for the dismissal that changed something. A second dismissal of a record
    // that is already gone publishes nothing.
    expect(publishCount).toBe(1);
  });

  it("negative control: a pane whose window was closed on purpose carries no crash record", async () => {
    // Without this, every case above would pass over a hand-off that recorded a loss
    // for every pane that left a window — and the deck would tell a person their
    // window crashed every time they pressed "Return it to the deck".
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });

    await handoff.returnToDeck("pane-1");

    expect(handoff.lostWindows()).toHaveLength(0);
  });

  it("publishes every change to its subscribers", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    const counts: number[] = [];
    const unsubscribe = handoff.subscribe((detached) => {
      counts.push(detached.length);
    });
    await handoff.detach({ paneId: "pane-1", kind: "timeline", sessionId: "session-1" });
    await handoff.returnToDeck("pane-1");
    unsubscribe();
    expect(counts).toStrictEqual([1, 0]);
  });

  it("does nothing for a pane it never detached", async () => {
    const handoff = new AuxiliaryHandoff({ growth: servingPort() });
    expect(await handoff.focus("pane-unknown")).toBeUndefined();
    expect(await handoff.returnToDeck("pane-unknown")).toBeUndefined();
    expect(handoff.noteWindowLost("pane-unknown", "gone")).toBeUndefined();
  });
});

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
});
