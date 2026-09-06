// When the sidebar's models are acquired, and when they are given back.
//
// Acquisition is an effect and never a render body, so a render React abandons must
// leave no lease and no subscription behind, and the last section to release a shared
// set is the one that disposes it. WHICH session, bridge, and store a set answers for
// is `session-models.addressing.test.tsx`, over the one cast in
// `session-models.test-support.tsx`.
import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleTripwires } from "../core/tripwires.js";
import { SurfaceErrorBoundary } from "../primitives/index.js";
import { SessionStore } from "../store/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { CollaborationSessionModelHolder, useSessionModels } from "./session-models.js";
import {
  LeaseProbe,
  RENDER_FAILURE_MESSAGE,
  countedFixtureBridge,
} from "./session-models.test-support.js";
import type { RenderPhaseReading } from "./session-models.test-support.js";

// The two probes below are this suite's alone, so they live in it: the rule that a
// `.tsx` module declares one component exempts a co-located test file exactly because
// its probes are private to its cases, and a shared support module holding a probe
// one suite drives would be scaffolding nobody else could read a use for.

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
