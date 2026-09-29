// What every `LeaseLine` suite needs before it asserts anything.
//
// The lease STATE is a value here, built directly rather than folded from a scenario,
// because `lease-model.test.ts` already holds the fold to the wire and these suites'
// subject is what each state renders. The device identity is a value for the same
// reason, and every case renders under a read one unless it is about the other arm.

import { render, type RenderResult } from "@testing-library/react";

import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { FLAGSHIP_SCENARIO } from "@renderer/console/bridge/scenario/flagship/flagship.js";
import { TERMINAL_SCENARIO } from "@renderer/console/bridge/scenario/terminal/terminal.js";
import { VIEWER_USER } from "../lease-model.test-support.js";
import type {
  TerminalLeaseCall,
  TerminalLeaseCalls,
  TerminalLeaseClaim,
} from "../hooks/useTakeShell.js";
import { LeaseClaimControl } from "./LeaseClaimControl.js";
import { LeaseLine } from "./LeaseLine.js";
import type { TerminalViewerIdentity } from "../hooks/useTerminalDeviceIdentity.js";
import { UNREAD_TERMINAL_LEASE, type TerminalLeaseState } from "../lease-model.js";

/**
 * The lease's own subject on the wire, read off the scenario rather than invented.
 *
 * `session.takeControl` takes `{ sessionId }`, and the scenario's session id is a
 * wire-declared UUID, so the request the cases below assert on is the one a daemon
 * would actually be handed.
 */
export const SESSION_ID: string = TERMINAL_SCENARIO.sessionId;

/**
 * The other session this pane can be rebound to, read off another scenario.
 *
 * A second wire-declared id rather than a readable placeholder, for the reason the
 * first one is read off a scenario: the claim's whole subject is the session it was
 * made under, so the id it is compared against has to be one a daemon could emit.
 */
export const OTHER_SESSION_ID: string = FLAGSHIP_SCENARIO.sessionId;

/**
 * The take call, held until a case settles it by name.
 *
 * A class because the state is the point: the rebind cases need more than one call out
 * at once, and a held promise is the only way to have a call genuinely still out across
 * a rerender.
 */
export class HeldLeaseCalls {
  readonly #heldSessionIds: string[] = [];
  readonly #heldResolvers: (() => void)[] = [];
  public readonly bridge: ConsoleBridge = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  public readonly calls: TerminalLeaseCalls;

  public constructor() {
    const hold: TerminalLeaseCall = async (request) => {
      this.#heldSessionIds.push(request.sessionId);
      await new Promise<void>((resolve) => {
        this.#heldResolvers.push(resolve);
      });
    };
    this.calls = { acquire: hold };
  }

  /** How many calls are out. The premise of every case that settles one. */
  public get heldCallCount(): number {
    return this.#heldResolvers.length;
  }

  /** The session a held call was made under, in the order the calls went out. */
  public sessionIdOfCall(callIndex: number): string {
    const sessionId = this.#heldSessionIds[callIndex];
    if (sessionId === undefined) {
      throw new Error(`no lease call number ${String(callIndex)} is out`);
    }
    return sessionId;
  }

  /** Settle one held call. */
  public settleCall(callIndex: number): void {
    const resolve = this.#heldResolvers[callIndex];
    if (resolve === undefined) {
      throw new Error(`no lease call number ${String(callIndex)} is out`);
    }
    resolve();
  }
}

/** A lease state with the given members over the not-yet-read one. */
export function leaseState(overrides: Partial<TerminalLeaseState>): TerminalLeaseState {
  return { ...UNREAD_TERMINAL_LEASE, ...overrides };
}

/**
 * The identity every case below renders under unless it is about the other arms.
 *
 * Read, and read as this device: the claim control is gated on the identity having
 * landed, so a default of anything else would make every case in this file about the
 * withheld state instead of about the state it names.
 */
export const VIEWER_IDENTITY_READ: TerminalViewerIdentity = {
  status: "read",
  userId: VIEWER_USER,
};

/** A claim that has dispatched nothing. */
export const IDLE_CLAIM: TerminalLeaseClaim = {
  isInFlight: false,
  acquire: () => undefined,
};

/** Render the lease line with its claim control under the given claim and identity. */
export function renderLease(
  state: TerminalLeaseState,
  claim: TerminalLeaseClaim = IDLE_CLAIM,
  viewerIdentity: TerminalViewerIdentity = VIEWER_IDENTITY_READ,
): RenderResult {
  return render(
    <LeaseLine
      state={state}
      controls={
        <LeaseClaimControl claim={claim} holding={state.holding} viewerIdentity={viewerIdentity} />
      }
    />,
  );
}

/** The single affordance the line puts in its header, as something a test can press. */
export function claimControl(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector(".meridian-lease-line__claim");
  if (!(control instanceof HTMLButtonElement)) {
    throw new Error("the lease line rendered no claim control");
  }
  return control;
}
