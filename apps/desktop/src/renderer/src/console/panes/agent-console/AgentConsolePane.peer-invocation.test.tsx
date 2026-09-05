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

import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  growthRefusing,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { RUN_LIFECYCLE_PROJECTORS } from "../../frame/run-lifecycle-projector.js";
import { SessionStore } from "../../store/index.js";
import { settleReads } from "./agent-console.test-support.js";
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
 *
 * Its one operation is `answer` rather than `call`, and held to that name
 * deliberately: this is a per-method reply script, not the bridge every surface
 * shares. A stand-in whose operation were named `call` on a holder named for the
 * daemon would be indistinguishable in source text from a surface reaching the real
 * call door — which is what
 * `test/console/architecture/daemon-reply-chokepoint.test.ts` scans for.
 */
class PeerInvocationDaemon {
  readonly #heldReplies: ((reading: unknown) => void)[] = [];
  #holdsNextReply = false;
  #callCount = 0;

  /** Mutations this daemon was actually asked to perform. The latch's instrument. */
  public get callCount(): number {
    return this.#callCount;
  }

  /** Hold the next mutation open until one of the settle methods releases it. */
  public holdNextReply(): void {
    this.#holdsNextReply = true;
  }

  public readonly answer = async (method: string, params?: unknown): Promise<unknown> => {
    if (method !== "sidekick.peerInvocationSet") {
      // Every other read this pane performs refuses, exactly as the shipped fixture
      // refuses a call its scenario scripts no reply for.
      throw new Error(`this daemon scripts no reply for ${method}`);
    }
    this.#callCount += 1;
    const requested = (params as { readonly enabled: boolean }).enabled;
    if (!this.#holdsNextReply) {
      return { enabled: requested };
    }
    this.#holdsNextReply = false;
    return await new Promise<unknown>((resolve) => {
      this.#heldReplies.push(resolve);
    });
  };

  /** Settle the OLDEST held reply — the one a reversed order lands last. */
  public async settleHeldReply(enabled: boolean): Promise<void> {
    await this.#release(this.#heldReplies.shift(), enabled);
  }

  /** Settle the NEWEST held reply, leaving anything older still outstanding. */
  public async settleNewestHeldReply(enabled: boolean): Promise<void> {
    await this.#release(this.#heldReplies.pop(), enabled);
  }

  async #release(
    resolve: ((reading: unknown) => void) | undefined,
    enabled: boolean,
  ): Promise<void> {
    resolve?.({ enabled });
    await Promise.resolve();
    await Promise.resolve();
  }
}

/**
 * The real fixture bridge, with the grant answered by this suite's scripted daemon.
 *
 * `sidekick.peerInvocationSet` has no registered request/response pair anywhere in
 * the corpus, so it is a growth operation and the override is where a suite decides
 * its answer. Every OTHER read this pane performs is left refusing, exactly as the
 * shipped fixture refuses a call its scenario scripts no reply for — which is the
 * state the pane has to draw around the one control this file is about.
 */
function bridgeCalling(scriptedDaemon: PeerInvocationDaemon): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("agent-console-peers"), {
    sessionRead: growthRefusing("sessionRead"),
    sidekickPeerInvocationSet: growthAnswering(
      async (request) => await scriptedDaemon.answer("sidekick.peerInvocationSet", request),
    ),
  });
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
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
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
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    scriptedDaemon.holdNextReply();
    const { container, rerender } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);
    await pressGrantOn(container);

    rerender(pane(bridge, storeProjecting(SECOND_SESSION_ID, false)));
    await settleReads(bridge);
    await act(async () => {
      await scriptedDaemon.settleHeldReply(true);
    });
    await settleReads(bridge);

    expect(switchState(container)).toBe(false);
  });

  it("shows what the projection says once it has moved past the reply", async () => {
    // The session stamp only reaches a move BETWEEN sessions. Within one session the
    // reply used to win forever, so a grant another participant turned off — or a
    // reconnect read that answered differently — never reached the switch, and the
    // control sat on a value nothing on the wire claimed any more.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);
    expect(switchState(container)).toBe(true);

    // The projection moving is a read landing in the store, which is exactly what a
    // reconnect and another participant's event both are.
    await act(async () => {
      sessionStore.initialise({
        cursor: 9,
        entities: [
          { kind: "session", id: FIRST_SESSION_ID, body: { peerInvocationEnabled: false } },
        ],
        participantJoinLog: [],
      });
      await Promise.resolve();
    });

    expect(switchState(container)).toBe(false);
  });

  it("negative control: a projection that has not moved leaves the reply standing", async () => {
    // Without this the case above would pass over a control that retired every
    // settlement on the next render, which would put a person's accepted choice back
    // to the projection's older answer a frame after they made it.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container, rerender } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);

    rerender(pane(bridge, sessionStore));
    await settleReads(bridge);

    expect(switchState(container)).toBe(true);
  });

  it("negative control: the settlement does win for the session it was asked of", async () => {
    // Without this, both cases above would pass over a control that ignored every
    // settlement — which would leave a person's accepted choice invisible until
    // something else re-read the projection.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);
    expect(switchState(container)).toBe(false);

    await pressGrantOn(container);
    await settleReads(bridge);

    expect(switchState(container)).toBe(true);
  });
});

/** The grant switch itself, so a case can read what it is doing. */
function grantSwitch(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(
    ".meridian-peer__switch input",
  ) as HTMLInputElement;
}

/** Move the projected row, which is what this control's own append does when it lands. */
async function projectGrant(sessionStore: SessionStore, enabled: boolean): Promise<void> {
  await act(async () => {
    sessionStore.initialise({
      cursor: 9,
      entities: [
        { kind: "session", id: sessionStore.sessionId, body: { peerInvocationEnabled: enabled } },
      ],
      participantJoinLog: [],
    });
    await Promise.resolve();
  });
}

describe("agent console — one peer-invocation change at a time", () => {
  it("takes no second change while the daemon has not answered the first", async () => {
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    scriptedDaemon.holdNextReply();
    const { container } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);

    await pressGrantOn(container);
    await settleReads(bridge);

    // The grant is durable: a second appended record for one intended act is two
    // records, and their replies race to decide which settlement is shown.
    expect(grantSwitch(container).disabled).toBe(true);
    await pressGrantOn(container);
    expect(scriptedDaemon.callCount).toBe(1);
  });

  it("discards a reply whose round the projection had already replaced", async () => {
    // The race the latch alone does not reach. This control's own append lands in
    // the store as a projected row BEFORE its reply comes back; the projection
    // moving retires that round and hands the switch back, so a second change is
    // admitted and the two replies may land in either order.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const sessionStore = storeProjecting(FIRST_SESSION_ID, false);
    const { container } = render(pane(bridge, sessionStore));
    await settleReads(bridge);

    scriptedDaemon.holdNextReply();
    await pressGrantOn(container);
    await projectGrant(sessionStore, true);
    expect(grantSwitch(container).disabled).toBe(false);

    scriptedDaemon.holdNextReply();
    await pressGrantOn(container);
    await act(async () => {
      await scriptedDaemon.settleNewestHeldReply(false);
    });
    await settleReads(bridge);
    expect(switchState(container)).toBe(false);

    // The older reply lands last and says the opposite of the settlement on screen.
    await act(async () => {
      await scriptedDaemon.settleHeldReply(true);
    });
    await settleReads(bridge);

    expect(switchState(container)).toBe(false);
  });

  it("negative control: with no change outstanding the switch is live", async () => {
    // Without this, the disabled case above would hold for a control that never
    // takes a press at all, which is a switch nobody can use rather than one that
    // refuses a second change.
    const scriptedDaemon = new PeerInvocationDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(pane(bridge, storeProjecting(FIRST_SESSION_ID, false)));
    await settleReads(bridge);

    expect(grantSwitch(container).disabled).toBe(false);
    await pressGrantOn(container);
    await settleReads(bridge);

    expect(scriptedDaemon.callCount).toBe(1);
    expect(grantSwitch(container).disabled).toBe(false);
  });
});
