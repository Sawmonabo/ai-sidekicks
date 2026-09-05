// The approvals hooks' shared scaffolding: a real store, a real bridge, one mount.
//
// Both suites drive hooks that are bound to a session, so both need the same thing —
// a store the hook can be mounted against and a bridge whose replies are the
// fixture's own. Written once so the reader and the mutation cannot disagree about
// what "this session" means.

import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { type ConsoleBridge, type GrowthOutcome, type ParsedRows } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port.js";
import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { useApprovalsReader } from "./approvals-hooks.js";
import { type ApprovalsReader } from "./approvals-reader.js";
import {
  createFixture,
  type RecordedDaemonCall,
} from "../../bridge/fixture-bridge.test-support.js";

export const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
export const SECOND_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b6";

export interface ObservableBridge {
  readonly bridge: ConsoleBridge;
  readonly calls: readonly RecordedDaemonCall[];
}

/**
 * A bridge whose two approvals reads answer empty and remember what they were asked.
 *
 * The reads go through the growth port — `@ai-sidekicks/contracts` publishes neither
 * half of their pairs — so the recorder sits on the port's arms and the `method` it
 * records is the OPERATION the surface called.
 *
 * A SPREAD OVER THE SHIPPED FIXTURE, and only the port is replaced. What stood here
 * was an object cast to `ConsoleBridge` carrying a hand-written daemon arm and a
 * hand-made scenario engine, which meant this file decided what every OTHER seam
 * answered too — so a hook that grew a second read was answered by whatever the cast
 * happened to contain rather than by the fixture the console really runs on. The
 * The clock goes with it, and is no longer handed back: it was a second `ManualClock`
 * this file minted and wrote onto the cast, which is a second time base in a tier
 * whose whole rule is that there is one. The reading schedules against the fixture's
 * frozen clock, and the one case that has to move it now says so through
 * `settleScheduledRead`.
 */
export function observableBridge(): ObservableBridge {
  const fixture = createFixture().bridge;
  const calls: RecordedDaemonCall[] = [];
  const recordEmptyRows = async (
    method: string,
    params: unknown,
  ): Promise<GrowthOutcome<ParsedRows<never>>> => {
    calls.push({ method, params });
    return { status: "served", value: { rows: [], unreadableCount: 0 } };
  };
  const bridge: ConsoleBridge = {
    ...fixture,
    growth: {
      ...createRefusingGrowthPort(),
      approvalProjectionRead: async (request: unknown) =>
        recordEmptyRows("approvalProjectionRead", request),
      approvalRuleList: async (request: unknown) => recordEmptyRows("approvalRuleList", request),
    },
  };
  return { bridge, calls };
}

/** A bridge that answers nothing: no read is performed by the callers of this one. */
export function silentBridge(): ConsoleBridge {
  return observableBridge().bridge;
}

export function ReaderHarness(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly onReader: (reader: ApprovalsReader) => void;
}): React.JSX.Element | null {
  const { reader } = useApprovalsReader(props.bridge, props.sessionStore);
  const { onReader } = props;
  useEffect(() => {
    onReader(reader);
  }, [onReader, reader]);
  return null;
}

export async function mountReader(sessionStore: SessionStore): Promise<ApprovalsReader> {
  let held: ApprovalsReader | undefined;
  await act(async () => {
    render(
      <ReaderHarness
        bridge={silentBridge()}
        sessionStore={sessionStore}
        onReader={(reader) => {
          held = reader;
        }}
      />,
    );
  });
  if (held === undefined) {
    throw new Error("the hook handed back no reader");
  }
  return held;
}

export function initialisedStore(sessionId: string = SESSION_ID): SessionStore {
  const store = new SessionStore({ sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

/**
 * One lifecycle signal, at the local position a relayed event would take.
 *
 * The row id is composed from the position rather than fixed, because it is the
 * event's own identifier and two rows of one session never share one.
 */
export function lifecycleEvent(sessionId: string, sequence: number): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind: "approval.requested",
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Which sessions the projection read was issued for.
 *
 * Keyed on the growth OPERATION rather than on the wire method string, because that
 * is what the surface calls: `@ai-sidekicks/contracts` publishes no pair for
 * `approval.projectionRead`, so the read never reaches the call door and no method
 * string is sent anywhere.
 */
export function sessionIdsRead(calls: readonly RecordedDaemonCall[]): readonly unknown[] {
  return calls
    .filter((call) => call.method === "approvalProjectionRead")
    .map((call) => (call.params as { readonly sessionId?: unknown }).sessionId);
}
