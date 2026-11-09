// What the lease line suites share: a lease state built directly (`state.test.ts` holds the fold
// to the wire), a third device, and the line rendered with its take over a bridge, opening as the
// pane's first read draws it, under an announcer that records what it says. Its session holds no
// run, so the line words device holds alone.

import { render, type RenderResult } from "@testing-library/react";
import { useState } from "react";

import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { StandingContent } from "#renderer/components/LiveAnnouncer/StandingContent.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { spiedAnnouncer, type SpiedAnnouncer } from "#test/helpers/spied-announcer.js";
import { initializedStore } from "#test/helpers/session/store/fixtures.js";
import { useStopRun } from "../hooks/useStopRun.js";
import { useTakeShell } from "../hooks/useTakeShell.js";
import { HeldTakes, TAKE_TARGET } from "../hooks/useTakeShell.test-support.js";
import { UNREAD_TERMINAL_LEASE, type TerminalLeaseState } from "../state.js";
import { LeaseLine } from "./LeaseLine.js";

/** A third device, beside this one and the scenario's other, for a hold that moves between two. */
export const THIRD_DEVICE_ID = "019b7b30-0280-79a4-8110-cca0117a0133" as DeviceId;

/** The rendered line, and every sentence the window's announcer was asked to say. */
export interface RenderedLease extends RenderResult {
  readonly said: SpiedAnnouncer;
}

/** A lease state with the given members over the not-yet-read one. */
export function leaseState(overrides: Partial<TerminalLeaseState>): TerminalLeaseState {
  return { ...UNREAD_TERMINAL_LEASE, ...overrides };
}

/** The lease line for `TAKE_TARGET`, its take over the given bridge, for a render or rerender. */
export function leaseLineWithTake(
  state: TerminalLeaseState,
  deviceName: string | undefined,
  bridge: PlatformBridge,
): React.JSX.Element {
  return <LeaseLineWithTake bridge={bridge} state={state} deviceName={deviceName} />;
}

/**
 * Render the lease line for `TAKE_TARGET`, with its take over the given bridge. What it first draws
 * stands, as the pane's first read; a rerender reports a change.
 */
export function renderLease(
  state: TerminalLeaseState,
  deviceName: string | undefined,
  bridge: PlatformBridge = new HeldTakes().bridge,
): RenderedLease {
  const said = spiedAnnouncer();
  const view = render(leaseLineWithTake(state, deviceName, bridge), {
    wrapper: ({ children }) => (
      <LiveAnnouncerProvider announcer={said.announcer}>
        <StandingContent>{children}</StandingContent>
      </LiveAnnouncerProvider>
    ),
  });
  return { ...view, said };
}

function LeaseLineWithTake(props: {
  readonly bridge: PlatformBridge;
  readonly state: TerminalLeaseState;
  readonly deviceName: string | undefined;
}): React.JSX.Element {
  const [sessionStore] = useState(() => initializedStore(TAKE_TARGET.sessionId));
  const takeShell = useTakeShell(props.bridge, TAKE_TARGET, props.state.holderDeviceId);
  const stopRun = useStopRun(props.bridge, TAKE_TARGET.sessionId, props.state.holderCommandId);
  return (
    <LeaseLine
      bridge={props.bridge}
      sessionStore={sessionStore}
      state={props.state}
      deviceName={props.deviceName}
      takeShell={takeShell}
      stopRun={stopRun}
    />
  );
}
