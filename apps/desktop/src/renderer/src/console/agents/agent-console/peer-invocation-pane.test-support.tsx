// The scripted daemon, the projected store, and the switch both peer-invocation
// suites drive the grant through.
//
// Hoisted on the second use, per `apps/desktop/AGENTS.md`: the suite split on the
// seam its own header draws — what a pane that MOVES gets wrong, and what one round
// of the mutation may do while another is outstanding — and both halves press the
// same switch through the same held-reply daemon. Two copies of a reply script are
// two files disagreeing about what the daemon answers, which is what every case in
// both files is actually asserting against.
//
// The method name is imported from the agents family's own wire module rather than
// written out: what the daemon answers is a suite's claim, but WHICH call it answers
// is the console's, and a literal here would be a second copy of a wire string.

import { act, fireEvent } from "@testing-library/react";

import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  growthRefusing,
  unscriptedScenario,
} from "../../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { RUN_LIFECYCLE_PROJECTORS } from "../../frame/run-lifecycle-projector.js";
import { SessionStore } from "../../store/index.js";
import { OWNED_AGENT_ID } from "./agent-console-body.test-support.js";
import { AgentConsoleBody } from "./AgentConsoleBody.js";

/** The two sessions a moving pane goes between. */
export const FIRST_SESSION_ID = "session-first";
export const SECOND_SESSION_ID = "session-second";

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
export class PeerInvocationDaemon {
  readonly #heldReplies: ((reading: unknown) => void)[] = [];
  #holdsNextReply = false;
  #refusesNextReply: string | undefined = undefined;
  #callCount = 0;

  /** Mutations this daemon was actually asked to perform. The latch's instrument. */
  public get callCount(): number {
    return this.#callCount;
  }

  /** Hold the next mutation open until one of the settle methods releases it. */
  public holdNextReply(): void {
    this.#holdsNextReply = true;
  }

  /** Refuse the next mutation, in the daemon's own words. */
  public refuseNextReply(detail: string): void {
    this.#refusesNextReply = detail;
  }

  public readonly answer = async (method: string, params?: unknown): Promise<unknown> => {
    if (method !== "sidekick.peerInvocationSet") {
      // Every other read this pane performs refuses, exactly as the shipped fixture
      // refuses a call its scenario scripts no reply for.
      throw new Error(`this daemon scripts no reply for ${method}`);
    }
    this.#callCount += 1;
    const refusal = this.#refusesNextReply;
    if (refusal !== undefined) {
      this.#refusesNextReply = undefined;
      throw new Error(refusal);
    }
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
export function bridgeCalling(scriptedDaemon: PeerInvocationDaemon): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("agent-console-peers"), {
    sessionRead: growthRefusing("sessionRead"),
    sidekickPeerInvocationSet: growthAnswering(
      async (request) => await scriptedDaemon.answer("sidekick.peerInvocationSet", request),
    ),
  });
}

/** A store whose session projection reports the grant, so the switch is drawn. */
export function storeProjecting(sessionId: string, peerInvocationEnabled: boolean): SessionStore {
  const sessionStore = new SessionStore({ sessionId, projectors: RUN_LIFECYCLE_PROJECTORS });
  sessionStore.initialise({
    cursor: 4,
    entities: [{ kind: "session", id: sessionId, body: { peerInvocationEnabled } }],
    participantJoinLog: [],
  });
  return sessionStore;
}

/** Whether the grant switch is drawn, and where it stands. */
export function switchState(container: HTMLElement): boolean | undefined {
  const control = container.querySelector<HTMLInputElement>(".meridian-peer__switch input");
  return control === null ? undefined : control.checked;
}

export function pane(bridge: ConsoleBridge, sessionStore: SessionStore): React.JSX.Element {
  return (
    <AgentConsoleBody
      sessionId={sessionStore.sessionId}
      agentId={OWNED_AGENT_ID}
      bridge={bridge}
      sessionStore={sessionStore}
    />
  );
}

/** Turn the grant on, through the control a person presses. */
export async function pressGrantOn(container: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(container.querySelector(".meridian-peer__switch input") as HTMLElement);
  });
}

/** The grant switch itself, so a case can read what it is doing. */
export function grantSwitch(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(
    ".meridian-peer__switch input",
  ) as HTMLInputElement;
}

/** Move the projected row, which is what this control's own append does when it lands. */
export async function projectGrant(sessionStore: SessionStore, enabled: boolean): Promise<void> {
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
