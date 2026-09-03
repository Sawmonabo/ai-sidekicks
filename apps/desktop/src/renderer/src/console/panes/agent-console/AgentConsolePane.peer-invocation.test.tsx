// The peer-invocation grant, and the one thing a pane that MOVES gets wrong.
//
// The pane stays mounted when the console goes from one session to another — the
// deck hands it new props rather than a new instance — so the control's own record
// of what a mutation settled with outlived the session it was about. Two ways: the
// value kept winning over the session the console had arrived at, and a reply from
// the session it had left could land after the move and decide the switch there.
//
// Every case drives the real pane over a real fixture bridge with one scripted
// daemon method, because both defects are only visible in an ORDER — a mutation, a
// move, and a reply — and a bridge that answered on the next microtask could not put
// the move between the last two.
//
// The method name is imported from the agents family's own wire module rather than
// written out: what the daemon answers is this file's claim, but WHICH call it
// answers is the console's, and a literal here would be a second copy of a wire
// string. The neighbouring case file reaches that family the same way.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SIDEKICK_PEER_INVOCATION_SET_METHOD } from "../../agents/agent-wire.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { RUN_LIFECYCLE_PROJECTORS } from "../../frame/run-lifecycle-projector.js";
import { SessionStore } from "../../store/index.js";
import { AgentConsolePane } from "./AgentConsolePane.js";

const FIRST_SESSION_ID = "session-first";
const SECOND_SESSION_ID = "session-second";
const OWNED_AGENT_ID = "agent-scout";

/**
 * A daemon that answers the peer-invocation mutation, and holds one reply open.
 *
 * Holding is what makes the late-reply case possible at all: the property is what a
 * reply from the session the pane has LEFT does when it lands, and a reply that
 * settles immediately lands before anything could move.
 */
class PeerInvocationDaemon {
  #releaseHeldReply: ((reading: unknown) => void) | undefined;
  #holdsNextReply = false;

  /** Hold the next mutation open until {@link settleHeldReply}. */
  public holdNextReply(): void {
    this.#holdsNextReply = true;
  }

  public readonly call = async (method: string, params?: unknown): Promise<unknown> => {
    if (method !== SIDEKICK_PEER_INVOCATION_SET_METHOD) {
      // Every other read this pane performs refuses, exactly as the shipped fixture
      // refuses a call its scenario scripts no reply for.
      throw new Error(`this daemon scripts no reply for ${method}`);
    }
    const requested = (params as { readonly enabled: boolean }).enabled;
    if (!this.#holdsNextReply) {
      return { enabled: requested };
    }
    this.#holdsNextReply = false;
    return await new Promise<unknown>((resolve) => {
      this.#releaseHeldReply = resolve;
    });
  };

  public async settleHeldReply(enabled: boolean): Promise<void> {
    this.#releaseHeldReply?.({ enabled });
    this.#releaseHeldReply = undefined;
    await Promise.resolve();
    await Promise.resolve();
  }
}

/** The real fixture bridge with its daemon call replaced by the scripted one. */
function bridgeCalling(daemon: PeerInvocationDaemon): ConsoleBridge {
  const fixture = fixtureBridgeWithGrowth(unscriptedScenario("agent-console-peers"), {
    sessionRead: growthRefusing("sessionRead"),
  });
  return {
    ...fixture,
    sidekicks: {
      ...fixture.sidekicks,
      daemon: {
        ...fixture.sidekicks.daemon,
        // The `DaemonMethod` brand no string literal satisfies, cast once here for
        // `seats/wire-access.ts`' reason.
        call: daemon.call as unknown as ConsoleBridge["sidekicks"]["daemon"]["call"],
      },
    },
  };
}

/** A store whose session projection reports the grant, so the switch is drawn. */
function storeProjecting(sessionId: string, peerInvocationEnabled: boolean): SessionStore {
  const sessionStore = new SessionStore({ sessionId, projectors: RUN_LIFECYCLE_PROJECTORS });
  sessionStore.initialise({
    cursor: 4,
    entities: [{ kind: "session", id: sessionId, body: { peerInvocationEnabled } }],
    participantJoinLog: [],
  });
  return sessionStore;
}

/** Let the mount's effects, the frozen clock, and every settled reply land. */
async function settleReads(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(500);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
}

/** Whether the grant switch is drawn, and where it stands. */
function switchState(container: HTMLElement): boolean | undefined {
  const control = container.querySelector<HTMLInputElement>(".meridian-peer__switch input");
  return control === null ? undefined : control.checked;
}

function pane(bridge: ConsoleBridge, sessionStore: SessionStore): React.JSX.Element {
  return (
    <AgentConsolePane
      sessionId={sessionStore.sessionId}
      agentId={OWNED_AGENT_ID}
      bridge={bridge}
      sessionStore={sessionStore}
    />
  );
}

/** Turn the grant on, through the control a person presses. */
async function pressGrantOn(container: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(container.querySelector(".meridian-peer__switch input") as HTMLElement);
  });
}

describe("agent console — the peer-invocation settlement belongs to one session", () => {
  it("shows the session it moved to, not the one it settled in", async () => {
    const daemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(daemon);
    const { container, rerender } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);
    expect(switchState(container)).toBe(true);

    rerender(pane(bridge, storeProjecting(SECOND_SESSION_ID, false)));
    await settleReads(bridge);

    expect(switchState(container)).toBe(false);
  });

  it("drops a reply from the session it has left", async () => {
    const daemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(daemon);
    daemon.holdNextReply();
    const { container, rerender } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);
    await pressGrantOn(container);

    rerender(pane(bridge, storeProjecting(SECOND_SESSION_ID, false)));
    await settleReads(bridge);
    await act(async () => {
      await daemon.settleHeldReply(true);
    });
    await settleReads(bridge);

    expect(switchState(container)).toBe(false);
  });

  it("negative control: the settlement does win for the session it was asked of", async () => {
    // Without this, both cases above would pass over a control that ignored every
    // settlement — which would leave a person's accepted choice invisible until
    // something else re-read the projection.
    const daemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(daemon);
    const { container } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);
    expect(switchState(container)).toBe(false);

    await pressGrantOn(container);
    await settleReads(bridge);

    expect(switchState(container)).toBe(true);
  });
});
