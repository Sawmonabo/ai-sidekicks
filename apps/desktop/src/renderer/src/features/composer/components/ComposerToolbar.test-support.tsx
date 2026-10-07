// Mounts the toolbar cluster over a real session store with events applied, a fixture bridge, and
// the two entities a composer must be addressed to before any run-scoped reading exists.

import { render } from "@testing-library/react";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import type { Scenario } from "#fixtures/scenario.js";
import { DEFAULT_ROUTE } from "#renderer/routing/routes.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { SessionStore } from "#renderer/store/session/store.js";
import {
  type StoredEntity,
  type ProjectedSessionEvent,
} from "#renderer/store/session/entities/vocabulary.js";
import type { PaneAddress } from "#renderer/routing/panes/address.js";
import { ComposerToolbar } from "./ComposerToolbar.js";
import { agentPane } from "../Composer.test-support.js";
import { CONTEXT_WINDOW_EVENT_KIND } from "../context-ring/context-window-reading.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

/** The toolbar's session, as a registered `SessionId`: a UUID, not a readable name. */
const SESSION_ID = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

const TOOLBAR_SCENARIO: Scenario = {
  id: "toolbar-unit",
  label: "Rail unit",
  purpose: "A bridge for the toolbar's mount; the toolbar's own reads come from the store.",
  sessionId: SESSION_ID,
  startedAtIso: "2026-01-01T00:00:00.000Z",
  beats: [],
  replies: [],
};

/** The id of the seeded agent. */
const AGENT_ID = "agent-implementer";
/** The id of the seeded run. */
export const RUN_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

/** A running agent entity. */
const AGENT: StoredEntity = {
  kind: "agent",
  id: AGENT_ID,
  state: "running",
  body: { name: "Ada", driverName: "claude" },
};

/** A running run of the seeded agent, at run version 4. */
const RUNNING_RUN: StoredEntity = {
  kind: "run",
  id: RUN_ID,
  state: "running",
  touchedAt: "2026-01-01T11:05:00.000Z",
  body: { agentId: AGENT_ID, runVersion: 4 },
};

/** What a toolbar case seeds: the session's entities, the pane the composer is addressed to. */
export interface ToolbarAddressing {
  readonly entities?: readonly StoredEntity[];
  readonly focusedPane?: PaneAddress | undefined;
}

/** A composer pointed at a run; usage folds are run-scoped, so an unaddressed toolbar is blank. */
export const ADDRESSED: ToolbarAddressing = {
  entities: [AGENT, RUNNING_RUN],
  focusedPane: agentPane(AGENT_ID),
};

/** Mount the toolbar over a real session store with `events` applied; returns the container. */
export function mountToolbar(
  events: readonly ProjectedSessionEvent[],
  addressing: ToolbarAddressing,
): HTMLElement {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
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
    { wrapper: LiveAnnouncerProvider },
  );
  return container;
}

/** One context-window reading, positioned so two rows of one session never collide. */
export function contextWindowEvent(sequence: number): ProjectedSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    cursor: `cursor-at-${String(sequence)}`,
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
