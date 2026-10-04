// What the lease suites need before they assert anything: the line rendered over a lease state
// built directly (`lease-model.test.ts` holds the fold to the wire) under a read identity, and
// take calls held until a case settles them.

import { render, type RenderResult } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { CONCURRENT_STREAMING_SCENARIO } from "@fixtures/scenarios/concurrent-streaming.js";
import { TERMINAL_LEASE_SCENARIO } from "@fixtures/scenarios/terminal-lease.js";
import { THIS_DEVICE_ID } from "../lease-model.test-support.js";
import type {
  TerminalLeaseCall,
  TerminalLeaseCalls,
  UseTakeShellResult,
} from "../hooks/useTakeShell.js";
import { LeaseTakeControl } from "./LeaseTakeControl.js";
import { LeaseLine } from "./LeaseLine.js";
import type { TerminalDeviceIdentity } from "../hooks/useTerminalDeviceIdentity.js";
import { UNREAD_TERMINAL_LEASE, type TerminalLeaseState } from "../lease-model.js";

/**
 * The lease's subject on the wire, read off the scenario: its session id is a wire-declared
 * UUID, so the requests the cases assert on are ones a daemon would actually be handed.
 */
export const SESSION_ID: string = TERMINAL_LEASE_SCENARIO.sessionId;

/** The other session this pane can be rebound to, read off another scenario for the same reason. */
export const OTHER_SESSION_ID: string = CONCURRENT_STREAMING_SCENARIO.sessionId;

/**
 * The take call, held until a case settles it by name. A class because the rebind cases need
 * more than one call out at once across a rerender.
 */
export class HeldLeaseCalls {
  readonly #heldSessionIds: string[] = [];
  readonly #heldResolvers: (() => void)[] = [];
  public readonly bridge: PlatformBridge = createFixtureBridge({
    scenario: TERMINAL_LEASE_SCENARIO,
  }).bridge;
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
 * The identity every case renders under unless it is about the other arms: read, as this
 * device. Any other default would make every case about the absent control.
 */
const DEVICE_IDENTITY_READ: TerminalDeviceIdentity = {
  status: "read",
  deviceId: THIS_DEVICE_ID,
};

/** A take that has dispatched nothing. */
const IDLE_TAKE: UseTakeShellResult = {
  isInFlight: false,
  take: () => undefined,
};

/** Render the lease line with its take control under the given take and identity. */
export function renderLease(
  state: TerminalLeaseState,
  takeShell: UseTakeShellResult = IDLE_TAKE,
  deviceIdentity: TerminalDeviceIdentity = DEVICE_IDENTITY_READ,
): RenderResult {
  return render(
    <LeaseLine
      state={state}
      controls={
        <LeaseTakeControl
          takeShell={takeShell}
          holder={state.holder}
          deviceIdentity={deviceIdentity}
        />
      }
    />,
  );
}
