// What the lease line suites share: a lease state built directly (`state.test.ts` holds the fold
// to the wire), a third device, and the line rendered with its take over a bridge.

import { render, type RenderResult } from "@testing-library/react";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useTakeShell } from "../hooks/useTakeShell.js";
import { HeldTakes, TAKE_TARGET } from "../hooks/useTakeShell.test-support.js";
import { UNREAD_TERMINAL_LEASE, type TerminalLeaseState } from "../state.js";
import { LeaseLine } from "./LeaseLine.js";

/** A third device, beside this one and the scenario's other, for a hold that moves between two. */
export const THIRD_DEVICE_ID = "019b7b30-0280-79a4-8110-cca0117a0133";

/** A lease state with the given members over the not-yet-read one. */
export function leaseState(overrides: Partial<TerminalLeaseState>): TerminalLeaseState {
  return { ...UNREAD_TERMINAL_LEASE, ...overrides };
}

/** The lease line for `TAKE_TARGET`, with its take over the given bridge, for a render or rerender. */
export function leaseLineWithTake(
  state: TerminalLeaseState,
  holderName: string | undefined,
  bridge: PlatformBridge,
): React.JSX.Element {
  return <LeaseLineWithTake bridge={bridge} state={state} holderName={holderName} />;
}

/** Render the lease line for `TAKE_TARGET`, with its take over the given bridge. */
export function renderLease(
  state: TerminalLeaseState,
  holderName: string | undefined,
  bridge: PlatformBridge = new HeldTakes().bridge,
): RenderResult {
  return render(leaseLineWithTake(state, holderName, bridge));
}

function LeaseLineWithTake(props: {
  readonly bridge: PlatformBridge;
  readonly state: TerminalLeaseState;
  readonly holderName: string | undefined;
}): React.JSX.Element {
  const takeShell = useTakeShell(props.bridge, TAKE_TARGET, props.state.holderDeviceId);
  return <LeaseLine state={props.state} holderName={props.holderName} takeShell={takeShell} />;
}
