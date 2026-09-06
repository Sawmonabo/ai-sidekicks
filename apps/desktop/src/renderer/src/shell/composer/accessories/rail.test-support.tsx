// What every accessory-rail suite needs before it can mount the rail.
//
// The rail is one component with five independent subjects on it — the context
// meter, the queue shelf, the compaction control, the quota chips, and the seats
// and menu — and each has a file of its own beside this one. What they share is
// the mount and the session it is mounted over, so that lives here once: a store
// with real events applied, a real fixture bridge, and the two entities a composer
// has to be addressed to before any run-scoped reading exists at all.
//
// It holds nothing a single suite uses. The capability reports only the compaction
// suite builds, the goal-shaped scenarios only the quota suite needs, and every
// assertion stay beside their reader.

import { act, render } from "@testing-library/react";

import {
  bridgeAnswering,
  type RecordedDaemonCall,
} from "../../../console/bridge/fixture/fixture-bridge.test-support.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import type { ConsoleScenario } from "../../../console/bridge/scenario-runtime/scenario.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import {
  SessionStore,
  type ConsoleEntity,
  type ConsoleSessionEvent,
} from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { ComposerAccessoryRail } from "./ComposerAccessoryRail.js";
import { CONTEXT_WINDOW_EVENT_KIND } from "./usage-readings.js";

/**
 * The rail's session, as a registered `SessionId` — a UUID, not a readable name.
 *
 * Two of the rail's seats parse it against the wire's own brand before they send
 * anything: the queue feed opens no stream over any other shape, and the compaction
 * dispatch refuses at the address rather than reaching the call. A readable name
 * here would leave both of them refusing for a reason no case is about.
 */
export const SESSION_ID = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

/** The registered list reply for a node with nothing registered on it. */
export const EMPTY_REGISTRY: unknown = { accounts: [], usageWindows: [], readiness: [] };

/** One account and one window against it, in the registered shapes. */
export const ONE_URGENT_QUOTA: unknown = {
  accounts: [
    {
      accountId: "acct-rail",
      provider: "claude",
      displayLabel: "Rail team",
      credentialGeneration: 1,
      billingMode: "subscription",
      isDefault: true,
      healthState: "authenticated",
      healthObservedAt: "2026-01-01T00:00:00.000Z",
      observedAuthMode: "oauth_subscription",
      loggedInAt: null,
      expectedReloginAtEstimate: null,
      probeEnabled: true,
    },
  ],
  usageWindows: [
    {
      accountId: "acct-rail",
      limitId: "weekly-all",
      windowMins: 10_080,
      label: "Weekly, all models",
      // Deep in the urgent band, so the chip is on screen at all: the healthy band
      // renders nothing by design.
      usedPercent: 94,
      observedAt: "2026-01-01T00:00:00.000Z",
      observedCredentialGeneration: 1,
      source: "probe",
    },
  ],
  readiness: [],
};

export const RAIL_SCENARIO: ConsoleScenario = {
  id: "rail-unit",
  label: "Rail unit",
  purpose: "A bridge for the rail's mount; the rail's own reads come from the store.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T00:00:00.000Z",
  beats: [],
  // The rail's quota chips are a NODE-scoped read and not a store selection, so a
  // scenario the rail mounts against has to answer it: an unscripted call is a
  // fixture authoring error, which would put a refusal in every case below. This
  // node has no account registered, which is an answered read and not a failure.
  replies: [{ call: "providerAccount.list", result: EMPTY_REGISTRY }],
};

/** The rail's own scenario with the node registry answering `reply` instead. */
export function railScenarioAnsweringRegistry(reply: unknown): ConsoleScenario {
  return { ...RAIL_SCENARIO, replies: [{ call: "providerAccount.list", result: reply }] };
}

/**
 * The rail's fixture bridge with one call arm this suite decides the answer for.
 *
 * The bridge family's own helper rather than a spread of this file's: the call
 * door's chokepoint gate holds that a test outside `bridge/` stands in for a
 * surface, and a surface goes through the door. `forward` is the fixture's own
 * answer, so an arm intercepts the one method its case is about and leaves the
 * node registry read scripted.
 */
export function railBridgeAnswering(
  answer: (call: RecordedDaemonCall, forward: () => Promise<unknown>) => Promise<unknown>,
): ConsoleBridge {
  return bridgeAnswering(answer, RAIL_SCENARIO).bridge;
}

export const AGENT_ID = "agent-implementer";
export const RUN_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

export const AGENT: ConsoleEntity = {
  kind: "agent",
  id: AGENT_ID,
  state: "running",
  body: { name: "Ada", driverName: "claude" },
};

export const RUNNING_RUN: ConsoleEntity = {
  kind: "run",
  id: RUN_ID,
  state: "running",
  touchedAt: "2026-01-01T11:05:00.000Z",
  body: { agentId: AGENT_ID, runVersion: 4 },
};

export const ON_THE_AGENT: ConsolePaneAddress = {
  kind: "agent-console",
  entity: { kind: "agent", id: AGENT_ID },
};

export interface RailAddressing {
  readonly bridge?: ConsoleBridge;
  readonly entities?: readonly ConsoleEntity[];
  readonly focusedPane?: ConsolePaneAddress | undefined;
  readonly sessionId?: string;
}

/**
 * The addressing every meter case needs: a composer pointed at a run.
 *
 * Both usage folds are run-scoped, so an unaddressed rail reports no fullness at
 * all — which is its own case and not the state a case about the METER wants to be
 * in.
 */
export const ADDRESSED: RailAddressing = {
  entities: [AGENT, RUNNING_RUN],
  focusedPane: ON_THE_AGENT,
};

export function mountRail(
  events: readonly ConsoleSessionEvent[],
  addressing: RailAddressing = {},
): HTMLElement {
  const sessionStore = new SessionStore({ sessionId: addressing.sessionId ?? SESSION_ID });
  sessionStore.initialise({
    cursor: 0,
    entities: [...(addressing.entities ?? [])],
    participantJoinLog: ["participant-you"],
  });
  sessionStore.applyBatch(events);
  const { container } = render(
    <ComposerAccessoryRail
      sessionStore={sessionStore}
      bridge={addressing.bridge ?? createFixtureBridge({ scenario: RAIL_SCENARIO })}
      draftStore={new DraftStore()}
      route={DEFAULT_ROUTE}
      focusedPane={addressing.focusedPane}
    />,
  );
  return container;
}

/** Mount inside `act`, for the cases whose reads settle on the way in. */
export async function mountRailSettled(
  events: readonly ConsoleSessionEvent[],
  addressing: RailAddressing = {},
): Promise<HTMLElement> {
  let container: HTMLElement = document.createElement("div");
  await act(async () => {
    container = mountRail(events, addressing);
  });
  return container;
}

/** One context-window reading, positioned so two rows of one session never collide. */
export function contextWindowEvent(sequence: number): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    kind: CONTEXT_WINDOW_EVENT_KIND,
    occurredAt: "2026-01-01T00:00:10.000Z",
    payload: {
      runId: RUN_ID,
      windowUsedTokens: 168_000,
      windowMaxTokens: 200_000,
      windowSource: "provider_reported",
      exceeded: false,
    },
  };
}
