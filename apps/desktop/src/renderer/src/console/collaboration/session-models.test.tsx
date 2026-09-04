// Who may start a session's collaboration models, and when.
//
// The claim under test is a LIFECYCLE claim, so every case reads two instruments at
// once: the holder's own outstanding-lease count, and the number of daemon
// subscriptions the fixture bridge still has open. A count that moved without a
// subscription behind it would be bookkeeping, and a subscription with no lease
// behind it is the leak this module exists to make unrepresentable.

import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DaemonEvent,
  DaemonEventPayload,
  SidekicksBridge,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { consoleTripwires } from "../core/index.js";
import { SurfaceErrorBoundary } from "../frame/ErrorBoundary.js";
import { SessionStore } from "../store/index.js";
import { CollaborationSessionModelHolder, useSessionModels } from "./session-models.js";

const RENDER_FAILURE_MESSAGE = "this section could not render";

/** The fixture bridge, with every daemon subscription it opens counted. */
interface CountedBridge {
  readonly bridge: ConsoleBridge;
  /** Subscriptions opened and not yet released. The leak instrument. */
  readonly liveSubscriptionCount: () => number;
}

function countedFixtureBridge(sessionId: string): CountedBridge {
  const fixture = createFixtureBridge({
    scenario: {
      id: `collaboration-session-models-${sessionId}`,
      label: "Nothing scripted",
      purpose: "Drives the sidebar's model lifecycle against a bridge that plays no beat.",
      sessionId,
      participantIdsInJoinOrder: [],
      beats: [],
      replies: [],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  });
  let liveSubscriptionCount = 0;
  const daemon: SidekicksBridge["daemon"] = {
    call: fixture.sidekicks.daemon.call,
    subscribe: <EventName extends DaemonEvent>(
      event: EventName,
      handler: (payload: DaemonEventPayload<EventName>) => void,
    ): Unsubscribe => {
      liveSubscriptionCount += 1;
      const release = fixture.sidekicks.daemon.subscribe(event, handler);
      return () => {
        liveSubscriptionCount -= 1;
        release();
      };
    },
  };
  return {
    bridge: { ...fixture, sidekicks: { ...fixture.sidekicks, daemon } },
    liveSubscriptionCount: () => liveSubscriptionCount,
  };
}

/** What the holder reported while a render body was running. */
interface RenderPhaseReading {
  readonly leaseCount: number;
  readonly liveSubscriptionCount: number;
}

/** Which session a committed frame drew, beside the store that frame was handed. */
interface FramePairing {
  readonly modelsSessionId: string | undefined;
  readonly storeSessionId: string | undefined;
}

function LeaseProbe(props: {
  readonly holder: CollaborationSessionModelHolder;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly onRender?: (reading: RenderPhaseReading) => void;
  readonly onFrame?: (pairing: FramePairing) => void;
  readonly liveSubscriptionCount?: () => number;
}): React.JSX.Element {
  const models = useSessionModels(props.holder, props.bridge, props.sessionStore);
  props.onRender?.({
    leaseCount: props.holder.outstandingLeaseCount,
    liveSubscriptionCount: props.liveSubscriptionCount?.() ?? 0,
  });
  const modelsSessionId = models?.subject.sessionStore.sessionId;
  props.onFrame?.({
    modelsSessionId,
    storeSessionId: props.sessionStore.sessionId,
  });
  return <p>{modelsSessionId ?? "waiting"}</p>;
}

/** A section body that fails the way a real one does: during its own render. */
function ExplodingProbe(props: {
  readonly holder: CollaborationSessionModelHolder;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  useSessionModels(props.holder, props.bridge, props.sessionStore);
  throw new Error(RENDER_FAILURE_MESSAGE);
}

/**
 * The shape this finding replaced: the models taken during the render body itself.
 *
 * The negative control. It exists so the two instruments above are shown to REPORT a
 * leak when there is one — without it, every clean assertion here would also pass
 * against a holder that never started anything at all.
 */
function RenderTimeAcquisitionProbe(props: {
  readonly holder: CollaborationSessionModelHolder;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  props.holder.acquire(props.bridge, props.sessionStore);
  throw new Error(RENDER_FAILURE_MESSAGE);
}

describe("the sidebar's models — acquisition is an effect and never a render", () => {
  it("holds no lease and opens no subscription while the first render body runs", () => {
    const counted = countedFixtureBridge("session-lease-a");
    const holder = new CollaborationSessionModelHolder();
    const readings: RenderPhaseReading[] = [];

    render(
      <LeaseProbe
        holder={holder}
        bridge={counted.bridge}
        sessionStore={new SessionStore({ sessionId: "session-lease-a" })}
        liveSubscriptionCount={counted.liveSubscriptionCount}
        onRender={(reading) => {
          readings.push(reading);
        }}
      />,
    );

    expect(readings[0]).toStrictEqual({ leaseCount: 0, liveSubscriptionCount: 0 });
    // And the effect that follows it does take one, so the case above is about
    // ORDER rather than about a hook that acquires nothing.
    expect(holder.outstandingLeaseCount).toBe(1);
    expect(counted.liveSubscriptionCount()).toBe(1);
  });

  it("gives the lease back when the only section holding it unmounts", () => {
    const counted = countedFixtureBridge("session-lease-b");
    const holder = new CollaborationSessionModelHolder();
    const view = render(
      <LeaseProbe
        holder={holder}
        bridge={counted.bridge}
        sessionStore={new SessionStore({ sessionId: "session-lease-b" })}
      />,
    );
    expect(holder.heldSessionId).toBe("session-lease-b");

    view.unmount();

    expect(holder.outstandingLeaseCount).toBe(0);
    expect(holder.heldSessionId).toBeUndefined();
    expect(counted.liveSubscriptionCount()).toBe(0);
  });

  it("leaves one started set behind a strict-mode double mount", () => {
    const counted = countedFixtureBridge("session-lease-c");
    const holder = new CollaborationSessionModelHolder();
    render(
      <StrictMode>
        <LeaseProbe
          holder={holder}
          bridge={counted.bridge}
          sessionStore={new SessionStore({ sessionId: "session-lease-c" })}
        />
      </StrictMode>,
    );

    expect(holder.outstandingLeaseCount).toBe(1);
    expect(counted.liveSubscriptionCount()).toBe(1);
  });

  it("shares one set between two sections and disposes it on the last release", () => {
    const counted = countedFixtureBridge("session-lease-d");
    const holder = new CollaborationSessionModelHolder();
    const sessionStore = new SessionStore({ sessionId: "session-lease-d" });
    const view = render(
      <>
        <LeaseProbe holder={holder} bridge={counted.bridge} sessionStore={sessionStore} />
        <LeaseProbe holder={holder} bridge={counted.bridge} sessionStore={sessionStore} />
      </>,
    );

    expect(holder.outstandingLeaseCount).toBe(2);
    // One set, not two: the second section joined the first section's subscription
    // rather than opening a rival projection of one session's presence.
    expect(counted.liveSubscriptionCount()).toBe(1);

    view.unmount();

    expect(holder.outstandingLeaseCount).toBe(0);
    expect(counted.liveSubscriptionCount()).toBe(0);
  });

  it("disposes the previous session's set exactly once when the sidebar switches", () => {
    const counted = countedFixtureBridge("session-lease-e");
    const holder = new CollaborationSessionModelHolder();
    const view = render(
      <LeaseProbe
        holder={holder}
        bridge={counted.bridge}
        sessionStore={new SessionStore({ sessionId: "session-lease-e" })}
      />,
    );

    view.rerender(
      <LeaseProbe
        holder={holder}
        bridge={counted.bridge}
        sessionStore={new SessionStore({ sessionId: "session-lease-f" })}
      />,
    );

    expect(holder.heldSessionId).toBe("session-lease-f");
    expect(holder.outstandingLeaseCount).toBe(1);
    expect(counted.liveSubscriptionCount()).toBe(1);
  });
});

describe("the sidebar's models — a set is handed out only under its own session", () => {
  /** Every frame the probe committed, in order, with the store each one was handed. */
  function switchBetweenOpenSessions(): readonly FramePairing[] {
    const counted = countedFixtureBridge("session-switch-a");
    const holder = new CollaborationSessionModelHolder();
    const frames: FramePairing[] = [];
    const record = (pairing: FramePairing): void => {
      frames.push(pairing);
    };
    const view = render(
      <LeaseProbe
        holder={holder}
        bridge={counted.bridge}
        sessionStore={new SessionStore({ sessionId: "session-switch-a" })}
        onFrame={record}
      />,
    );
    // Straight from one open session to another, which is the sidebar's own move —
    // no unmount in between, so the held set is still the first session's on the
    // render that first names the second.
    view.rerender(
      <LeaseProbe
        holder={holder}
        bridge={counted.bridge}
        sessionStore={new SessionStore({ sessionId: "session-switch-b" })}
        onFrame={record}
      />,
    );
    view.unmount();
    return frames;
  }

  it("never draws one session's models under another session's store", () => {
    const frames = switchBetweenOpenSessions();
    const disagreeing = frames.filter(
      (frame) =>
        frame.modelsSessionId !== undefined && frame.modelsSessionId !== frame.storeSessionId,
    );
    expect(disagreeing).toStrictEqual([]);
  });

  it("renders the switching frame as absent and the next one as the new session's", () => {
    const frames = switchBetweenOpenSessions();
    const afterSwitch = frames.filter((frame) => frame.storeSessionId === "session-switch-b");
    // The frame the store moved on hands out nothing — which the sections already
    // render as the `not-loaded` absence — and the frame the effect's lease lands
    // on hands out the new session's set.
    expect(afterSwitch[0]?.modelsSessionId).toBeUndefined();
    expect(afterSwitch.at(-1)?.modelsSessionId).toBe("session-switch-b");
  });

  it("negative control: the frames before the switch DO carry the first session's set", () => {
    // Without this, the two cases above would pass over a hook that handed out
    // nothing at all, on every frame, forever.
    const frames = switchBetweenOpenSessions();
    const beforeSwitch = frames.filter((frame) => frame.storeSessionId === "session-switch-a");
    expect(beforeSwitch.at(-1)?.modelsSessionId).toBe("session-switch-a");
  });
});

describe("the sidebar's models — a render React abandons leaves nothing behind", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The boundary reports through the tripwire registry, which throws in a
    // development build — and a throw from `componentDidCatch` becomes a second
    // failure inside React's own error handling.
    restoreThrowOnReport = import.meta.env.DEV;
    consoleTripwires.setThrowOnReport(false);
    consoleTripwires.reset();
  });

  afterEach(() => {
    consoleTripwires.setThrowOnReport(restoreThrowOnReport);
    consoleTripwires.reset();
  });

  it("starts nothing when the render that asked for the models never commits", () => {
    const counted = countedFixtureBridge("session-lease-g");
    const holder = new CollaborationSessionModelHolder();

    render(
      <SurfaceErrorBoundary surfaceName="The members section">
        <ExplodingProbe
          holder={holder}
          bridge={counted.bridge}
          sessionStore={new SessionStore({ sessionId: "session-lease-g" })}
        />
      </SurfaceErrorBoundary>,
    );

    expect(holder.outstandingLeaseCount).toBe(0);
    expect(holder.heldSessionId).toBeUndefined();
    expect(counted.liveSubscriptionCount()).toBe(0);
  });

  it("negative control: the same render taking the models itself DOES leave one open", () => {
    const counted = countedFixtureBridge("session-lease-h");
    const holder = new CollaborationSessionModelHolder();

    render(
      <SurfaceErrorBoundary surfaceName="The members section">
        <RenderTimeAcquisitionProbe
          holder={holder}
          bridge={counted.bridge}
          sessionStore={new SessionStore({ sessionId: "session-lease-h" })}
        />
      </SurfaceErrorBoundary>,
    );

    // The abandoned pass left a started subscription with no committed cleanup to
    // release it — which is what both instruments above have to be able to see.
    expect(holder.outstandingLeaseCount).toBeGreaterThan(0);
    expect(counted.liveSubscriptionCount()).toBeGreaterThan(0);
    holder.dispose();
  });
});

describe("the sidebar's models — the exact bridge and store they answer for", () => {
  /** Which bridge each committed frame's set was built against. */
  function bridgesAnsweredAfterReplacing(
    before: { readonly bridge: ConsoleBridge; readonly sessionStore: SessionStore },
    after: { readonly bridge: ConsoleBridge; readonly sessionStore: SessionStore },
  ): readonly (ConsoleBridge | undefined)[] {
    const holder = new CollaborationSessionModelHolder();
    const answered: (ConsoleBridge | undefined)[] = [];
    function SubjectProbe(props: {
      readonly bridge: ConsoleBridge;
      readonly sessionStore: SessionStore;
    }): React.JSX.Element {
      const models = useSessionModels(holder, props.bridge, props.sessionStore);
      answered.push(models?.subject.bridge);
      return <p>{models === undefined ? "waiting" : "held"}</p>;
    }
    const view = render(<SubjectProbe {...before} />);
    const beforeReplacement = answered.length;
    view.rerender(<SubjectProbe {...after} />);
    view.unmount();
    return answered.slice(beforeReplacement);
  }

  it("hands out nothing on the frame where the bridge was replaced under one session", () => {
    const sessionStore = new SessionStore({ sessionId: "session-reconnect" });
    const replacement = countedFixtureBridge("session-reconnect-b").bridge;
    const answered = bridgesAnsweredAfterReplacing(
      { bridge: countedFixtureBridge("session-reconnect-a").bridge, sessionStore },
      { bridge: replacement, sessionStore },
    );

    // The held set's channel and presence reads are bound to a transport this
    // sidebar no longer holds, and a control pressed on that frame would dispatch
    // through it.
    expect(answered[0]).toBeUndefined();
    expect(answered.at(-1)).toBe(replacement);
  });

  it("hands out nothing on the frame where the store was rebuilt under one session", () => {
    const bridge = countedFixtureBridge("session-store-rebuild").bridge;
    const rebuilt = new SessionStore({ sessionId: "session-rebuilt" });
    const holder = new CollaborationSessionModelHolder();
    const answered: (SessionStore | undefined)[] = [];
    function StoreProbe(props: { readonly sessionStore: SessionStore }): React.JSX.Element {
      const models = useSessionModels(holder, bridge, props.sessionStore);
      answered.push(models?.subject.sessionStore);
      return <p>{models === undefined ? "waiting" : "held"}</p>;
    }
    const view = render(
      <StoreProbe sessionStore={new SessionStore({ sessionId: "session-rebuilt" })} />,
    );
    const beforeReplacement = answered.length;
    view.rerender(<StoreProbe sessionStore={rebuilt} />);

    // Same session id, a different projection: the held roster reads the stream the
    // previous store owned, which nothing is appending to any more.
    expect(answered[beforeReplacement]).toBeUndefined();
    expect(answered.at(-1)).toBe(rebuilt);
    view.unmount();
  });

  it("negative control: an unchanged pair keeps handing out the set it holds", () => {
    // Without this, the two cases above would pass over a hook that handed out
    // nothing on every frame it ever rendered — and over a holder that answered a
    // replacement by never building a second set at all.
    const bridge = countedFixtureBridge("session-unchanged").bridge;
    const sessionStore = new SessionStore({ sessionId: "session-unchanged" });
    const answered = bridgesAnsweredAfterReplacing(
      { bridge, sessionStore },
      { bridge, sessionStore },
    );
    expect(answered.at(-1)).toBe(bridge);
  });

  it("builds a second set rather than joining the retired bridge's, and disposes the first", () => {
    // The holder's own cache has to agree with the render guard: an `acquire` that
    // joined on the session id would hand back a set the guard then refuses to
    // render, and the section would sit at `not-loaded` for the window's life.
    const holder = new CollaborationSessionModelHolder();
    const sessionStore = new SessionStore({ sessionId: "session-id-only" });
    const retiredBridge = countedFixtureBridge("session-id-only-a");
    const replacementBridge = countedFixtureBridge("session-id-only-b");
    const retiredLease = holder.acquire(retiredBridge.bridge, sessionStore);
    expect(retiredBridge.liveSubscriptionCount()).toBe(1);

    const rejoined = holder.acquire(replacementBridge.bridge, sessionStore);

    expect(rejoined.models.subject.bridge).toBe(replacementBridge.bridge);
    expect(rejoined.models).not.toBe(retiredLease.models);
    expect(retiredBridge.liveSubscriptionCount()).toBe(0);
    expect(replacementBridge.liveSubscriptionCount()).toBe(1);
    rejoined.release();
    expect(replacementBridge.liveSubscriptionCount()).toBe(0);
  });
});
