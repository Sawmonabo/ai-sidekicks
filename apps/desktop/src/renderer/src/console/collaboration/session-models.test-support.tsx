// The cast both session-model suites read their two instruments through.
//
// The claim under test is a LIFECYCLE claim, so every case reads two instruments at
// once: the holder's own outstanding-lease count, and the number of daemon
// subscriptions the fixture bridge still has open. A count that moved without a
// subscription behind it would be bookkeeping, and a subscription with no lease
// behind it is the leak this module exists to make unrepresentable. Both halves —
// when a set is acquired, and which triple it answers for — read both.

import type {
  DaemonEvent,
  DaemonEventPayload,
  SidekicksBridge,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";

import { SessionStore } from "../store/index.js";
import { CollaborationSessionModelHolder, useSessionModels } from "./session-models.js";

export const RENDER_FAILURE_MESSAGE = "this section could not render";

/** The fixture bridge, with every daemon subscription it opens counted. */
export interface CountedBridge {
  readonly bridge: ConsoleBridge;
  /** Subscriptions opened and not yet released. The leak instrument. */
  readonly liveSubscriptionCount: () => number;
}

export function countedFixtureBridge(sessionId: string): CountedBridge {
  const fixture = createFixtureBridge({
    scenario: {
      id: `collaboration-session-models-${sessionId}`,
      label: "Nothing scripted",
      purpose: "Drives the sidebar's model lifecycle against a bridge that plays no beat.",
      sessionId,
      participantIdsInJoinOrder: [],
      beats: [],
      replies: [],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  });
  let liveSubscriptionCount = 0;
  const daemon: SidekicksBridge["daemon"] = {
    call: fixture.sidekicks.daemon.call,
    subscribe: <EventName extends DaemonEvent>(
      event: EventName,
      handler: (payload: DaemonEventPayload<EventName>) => void,
    ): Unsubscribe => {
      liveSubscriptionCount += 1;
      const release = fixture.sidekicks.daemon.subscribe(event, handler);
      return () => {
        liveSubscriptionCount -= 1;
        release();
      };
    },
  };
  return {
    bridge: { ...fixture, sidekicks: { ...fixture.sidekicks, daemon } },
    liveSubscriptionCount: () => liveSubscriptionCount,
  };
}

/** What the holder reported while a render body was running. */
export interface RenderPhaseReading {
  readonly leaseCount: number;
  readonly liveSubscriptionCount: number;
}

/** Which session a committed frame drew, beside the store that frame was handed. */
export interface FramePairing {
  readonly modelsSessionId: string | undefined;
  readonly storeSessionId: string | undefined;
}

export function LeaseProbe(props: {
  readonly holder: CollaborationSessionModelHolder;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly onRender?: (reading: RenderPhaseReading) => void;
  readonly onFrame?: (pairing: FramePairing) => void;
  readonly liveSubscriptionCount?: () => number;
}): React.JSX.Element {
  const models = useSessionModels(props.holder, props.bridge, props.sessionStore);
  props.onRender?.({
    leaseCount: props.holder.outstandingLeaseCount,
    liveSubscriptionCount: props.liveSubscriptionCount?.() ?? 0,
  });
  const modelsSessionId = models?.subject.sessionStore.sessionId;
  props.onFrame?.({
    modelsSessionId,
    storeSessionId: props.sessionStore.sessionId,
  });
  return <p>{modelsSessionId ?? "waiting"}</p>;
}

/** A section body that fails the way a real one does: during its own render. */
export function ExplodingProbe(props: {
  readonly holder: CollaborationSessionModelHolder;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  useSessionModels(props.holder, props.bridge, props.sessionStore);
  throw new Error(RENDER_FAILURE_MESSAGE);
}

/**
 * The shape this finding replaced: the models taken during the render body itself.
 *
 * The negative control. It exists so the two instruments above are shown to REPORT a
 * leak when there is one — without it, every clean assertion here would also pass
 * against a holder that never started anything at all.
 */
export function RenderTimeAcquisitionProbe(props: {
  readonly holder: CollaborationSessionModelHolder;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  props.holder.acquire(props.bridge, props.sessionStore);
  throw new Error(RENDER_FAILURE_MESSAGE);
}
