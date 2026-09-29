// What every accessory-rail suite needs before it can mount the rail.
//
// The mount and the session it is mounted over, once: a store with real events applied,
// a real fixture bridge, and the two entities a composer has to be addressed to before
// any run-scoped reading exists at all.

import { render } from "@testing-library/react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import type { Scenario } from "../../../../../../fixtures/scenario.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import {
  type StoredEntity,
  type ProjectedSessionEvent,
} from "@renderer/store/session/entities/entities.js";
import type { PaneAddress } from "@renderer/console/seats/index.js";
import { ComposerToolbar } from "./ComposerToolbar.js";
import { CONTEXT_WINDOW_EVENT_KIND } from "../context-ring/context-window-reading.js";

/** The rail's session, as a registered `SessionId`: a UUID, not a readable name. */
export const SESSION_ID = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

const TOOLBAR_SCENARIO: Scenario = {
  id: "rail-unit",
  label: "Rail unit",
  purpose: "A bridge for the rail's mount; the rail's own reads come from the store.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: ["user-you"],
  startedAtIso: "2026-01-01T00:00:00.000Z",
  beats: [],
  replies: [],
};

export const AGENT_ID = "agent-implementer";
export const RUN_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

export const AGENT: StoredEntity = {
  kind: "agent",
  id: AGENT_ID,
  state: "running",
  body: { name: "Ada", driverName: "claude" },
};

export const RUNNING_RUN: StoredEntity = {
  kind: "run",
  id: RUN_ID,
  state: "running",
  touchedAt: "2026-01-01T11:05:00.000Z",
  body: { agentId: AGENT_ID, runVersion: 4 },
};

const ON_THE_AGENT: PaneAddress = {
  kind: "agents",
  entity: { kind: "agent", id: AGENT_ID },
};

/** What a rail case seeds: the session's entities, the pane the composer is addressed to. */
export interface ToolbarAddressing {
  readonly entities?: readonly StoredEntity[];
  readonly focusedPane?: PaneAddress | undefined;
  readonly sessionId?: string;
}

/**
 * The addressing every meter case needs: a composer pointed at a run.
 *
 * Both usage folds are run-scoped, so an unaddressed rail reports no fullness at
 * all — which is its own case and not the state a case about the METER wants to be
 * in.
 */
export const ADDRESSED: ToolbarAddressing = {
  entities: [AGENT, RUNNING_RUN],
  focusedPane: ON_THE_AGENT,
};

/** Mount the rail over a real session store with `events` applied; returns the container. */
export function mountToolbar(
  events: readonly ProjectedSessionEvent[],
  addressing: ToolbarAddressing = {},
): HTMLElement {
  const sessionStore = new SessionStore({ sessionId: addressing.sessionId ?? SESSION_ID });
  sessionStore.initialize({
    cursor: 0,
    entities: [...(addressing.entities ?? [])],
  });
  sessionStore.applyBatch(events);
  const { container } = render(
    <ComposerToolbar
      sessionStore={sessionStore}
      bridge={createFixtureBridge({ scenario: TOOLBAR_SCENARIO }).bridge}
      draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
      frameStore={new WindowStore()}
      route={DEFAULT_ROUTE}
      focusedPane={addressing.focusedPane}
    />,
  );
  return container;
}

/** One context-window reading, positioned so two rows of one session never collide. */
export function contextWindowEvent(sequence: number): ProjectedSessionEvent {
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
