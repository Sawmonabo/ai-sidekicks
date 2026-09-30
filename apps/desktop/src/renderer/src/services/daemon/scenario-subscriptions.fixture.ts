// What a fixture subscriber is handed, and when. `daemon.subscribe` hands beats as they fall due on
// the frozen clock, only to a subscriber the seam says they reach and in the shape that
// subscription registers. `session-event-streams.ts` routes, `run-stream-projection.fixture.ts`
// projects and `event-envelope.fixture.ts` composes. The whole-session stream is
// replay-then-tail, so a store opened mid-scenario does not read the next beat as a sequence
// gap. `daemon.fixture.ts` composes this function.
import type { Unsubscribe } from "@shared/preload-api.js";

import { FixtureBridgeError } from "./refusal.fixture.js";
import { isWireRecord } from "@renderer/lib/wire-record.js";
import { projectRunStreamDelivery } from "../run-streams/run-stream-projection.fixture.js";
import { ScenarioEngine } from "./engine.fixture.js";
import {
  composeScenarioEventEnvelope,
  composeScenarioSessionFrames,
} from "./event-envelope.fixture.js";
import { sessionEventStreamFor, subscriptionDeliversEventKind } from "./session-event-streams.js";

/**
 * Deliver a scenario's beats to one subscriber, filtered by what it subscribed to.
 *
 * `session-event-streams.ts` owns which names are streams and what each carries; this function
 * does no routing of its own. `session.subscribe` is the replay-then-tail stream of the whole log,
 * delivered in the frames `event-envelope.fixture.ts` composes. A bare event-type name carries
 * only itself, one envelope per beat. The two `run.*` streams are registered projections
 * (`RunStateChangeEvent | RunRolledBackEvent` and `QueueItemSummary`) built by
 * `run-stream-projection.fixture.ts`, with no replay because they are live; the envelope would
 * teach subscribers a frame the live bridge cannot send. A beat the projection cannot build throws,
 * and `lib/emitter.ts` re-raises after every sink has run, so the authoring error reaches whoever
 * advanced the clock without silencing other subscribers. The presence subscription is not an
 * event feed: the fixture scripts no device, so it is accepted and never delivers.
 */
export function subscribeToScenario(
  engine: ScenarioEngine,
  subscriptionName: string,
  deliver: (delivered: unknown) => void,
): Unsubscribe {
  // Only the whole-session stream replays; the stream's `scope` from `session-event-streams.ts`
  // is that distinction, and the run streams and bare event types are live.
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream?.scope === "machine-presence") {
    return () => undefined;
  }
  if (stream?.scope === "whole-session") {
    return engine.subscribe(
      (events) => {
        for (const frame of composeScenarioSessionFrames(events)) {
          deliver(frame);
        }
      },
      { replayDeliveredPrefix: true },
    );
  }
  return engine.subscribe((events) => {
    for (const event of events) {
      if (!subscriptionDeliversEventKind(subscriptionName, event.kind)) {
        continue;
      }
      // The queue payload projects the queue row, whose stand-in is the reply the scenario
      // scripts for that read. Resolved per beat, so a replaced scenario is read afresh.
      const projection = projectRunStreamDelivery(subscriptionName, event, (queueItemId) =>
        scriptedQueueRowFor(engine, queueItemId),
      );
      if (projection === undefined) {
        deliver(composeScenarioEventEnvelope(event));
        continue;
      }
      if (projection.status === "unprojectable") {
        throw new FixtureBridgeError(subscriptionName, "beat-unprojectable", projection.detail);
      }
      deliver(projection.delivery);
    }
  });
}

/** The registered read whose reply carries the queue rows, `QueueItemListResponse`. */
const RUN_QUEUE_ROW_READ = "run.queueList";

/**
 * The row for one queue item in the scenario's scripted queue read, or `undefined`
 * when the scenario scripts no such read or its rows do not include this item.
 */
function scriptedQueueRowFor(
  engine: ScenarioEngine,
  queueItemId: string,
): Readonly<Record<string, unknown>> | undefined {
  const scriptedReadResult = engine.replyFor(RUN_QUEUE_ROW_READ)?.result;
  if (!isWireRecord(scriptedReadResult)) {
    return undefined;
  }
  const items = scriptedReadResult["items"];
  if (!Array.isArray(items)) {
    return undefined;
  }
  return items.filter(isWireRecord).find((row) => row["id"] === queueItemId);
}
