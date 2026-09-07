// Which session, bridge, and store a handed-out model set answers for.
//
// A set is handed out only under the exact triple it was built for: the switching
// frame renders as absent rather than drawing the previous session's models, and a
// replaced bridge or a rebuilt store retires the set rather than joining it. WHEN a
// set is acquired and disposed is `session-models.lifecycle.test.tsx`, over the one
// cast in `session-models.test-support.tsx`.
import type { ConsoleBridge } from "../bridge/index.js";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../store/index.js";
import { CollaborationSessionModelHolder, useSessionModels } from "./session-models.js";
import {
  LeaseProbe,
  SUBSCRIPTIONS_PER_MODEL_SET,
  countedFixtureBridge,
} from "./session-models.test-support.js";
import type { FramePairing } from "./session-models.test-support.js";

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
    expect(retiredBridge.liveSubscriptionCount()).toBe(SUBSCRIPTIONS_PER_MODEL_SET);

    const rejoined = holder.acquire(replacementBridge.bridge, sessionStore);

    expect(rejoined.models.subject.bridge).toBe(replacementBridge.bridge);
    expect(rejoined.models).not.toBe(retiredLease.models);
    expect(retiredBridge.liveSubscriptionCount()).toBe(0);
    expect(replacementBridge.liveSubscriptionCount()).toBe(SUBSCRIPTIONS_PER_MODEL_SET);
    rejoined.release();
    expect(replacementBridge.liveSubscriptionCount()).toBe(0);
  });
});
