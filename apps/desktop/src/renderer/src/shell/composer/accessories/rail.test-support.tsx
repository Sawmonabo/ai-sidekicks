// What every accessory-rail suite needs before it can mount the rail.
//
// The rail has two subjects, the attachment strip and the context meter, and each has
// a file of its own beside this one. What they share is the mount and the session it
// is mounted over, so that lives here once: a store with real events applied, a real
// fixture bridge, and the two entities a composer has to be addressed to before any
// run-scoped reading exists at all.

import { useRef } from "react";
import { render } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import type { ConsoleScenario } from "../../../console/bridge/scenario/runtime/vocabulary.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../console/core/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import {
  FrameStore,
  SessionStore,
  type ConsoleEntity,
  type ConsoleSessionEvent,
} from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { ComposerAccessoryRail } from "./ComposerAccessoryRail.js";
import { CONTEXT_WINDOW_EVENT_KIND } from "./usage-readings.js";

/** The rail's session, as a registered `SessionId`: a UUID, not a readable name. */
export const SESSION_ID = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

export const RAIL_SCENARIO: ConsoleScenario = {
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
  /** The focused pane as a handle, which is what a `+` menu row addresses. */
  readonly focusedPaneId?: string | undefined;
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
    userJoinLog: ["user-you"],
  });
  sessionStore.applyBatch(events);
  const { container } = render(
    <RailHost
      sessionStore={sessionStore}
      bridge={addressing.bridge ?? createFixtureBridge({ scenario: RAIL_SCENARIO })}
      // Built here rather than in the host's render body: a store minted per render
      // would be a fresh one on every pass, which is the construction-in-a-render
      // defect the package's own rule names.
      draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
      frameStore={new FrameStore()}
      focusedPane={addressing.focusedPane}
      focusedPaneId={addressing.focusedPaneId}
    />,
  );
  return container;
}

/**
 * The rail inside the region the composer's host would own.
 *
 * A HOST AND NOT A BARE MOUNT, because one of the rail's inputs is that region: drop
 * and paste are bound to the whole composer, and a harness that handed the rail a ref
 * pointing at nothing would exercise a binding that never attached — green, and about
 * nothing. The section wears the production class so a suite can find the region the
 * same way a person's pointer does.
 */
function RailHost(props: {
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  readonly draftStore: DraftStore;
  readonly frameStore: FrameStore;
  readonly focusedPane: ConsolePaneAddress | undefined;
  readonly focusedPaneId: string | undefined;
}): React.JSX.Element {
  const regionRef = useRef<HTMLElement | null>(null);
  return (
    <section className="meridian-composer" ref={regionRef}>
      <ComposerAccessoryRail
        sessionStore={props.sessionStore}
        bridge={props.bridge}
        draftStore={props.draftStore}
        frameStore={props.frameStore}
        route={DEFAULT_ROUTE}
        focusedPane={props.focusedPane}
        focusedPaneId={props.focusedPaneId}
        region={regionRef}
      />
    </section>
  );
}

/** The composer region a mounted rail is bound to, for the drop-and-paste cases. */
export function railRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector("section.meridian-composer");
  if (region === null) {
    throw new Error("the rail harness mounted no composer region");
  }
  return region as HTMLElement;
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
