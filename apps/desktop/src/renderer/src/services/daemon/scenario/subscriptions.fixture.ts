// What a fixture subscriber is handed, and when. `daemon.subscribe` hands beats as they fall due on
// the frozen clock, only to a subscriber the seam says they reach and in the shape that
// subscription registers. `services/daemon/session/event/streams.ts` routes,
// `projection.fixture.ts` projects and `event/envelope.fixture.ts` composes. The whole-session
// stream is catch up, then follow, so a store opened mid-scenario does not read the next beat as a
// sequence gap, and one re-opened after a cursor catches up only past it; each change carries the
// run stamp `turn-attribution.fixture.ts` folds. `wire.fixture.ts` composes this function.
import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/session/event-cursor";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";

import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { Unsubscribe } from "#shared/preload-api.js";

import { FixtureBridgeError } from "../refusal.fixture.js";
import { isWireRecord } from "#renderer/lib/wire/record.js";
import { projectRunStreamDelivery } from "../../run-streams/projection.fixture.js";
import { ScenarioEngine } from "../engine.fixture.js";
import { assertOpeningOnContract, requestStampReaderFor } from "../scripted/reply.fixture.js";
import {
  composeScenarioEventEnvelope,
  composeScenarioSessionFrames,
} from "../event/envelope.fixture.js";
import { sessionEventStreamFor, subscriptionDeliversEventKind } from "../session/event/streams.js";
import { ScenarioTurnAttribution } from "./turn-attribution.fixture.js";

const START_OF_LOG_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

/**
 * Deliver a scenario's beats to one subscriber, filtered by what it subscribed to.
 *
 * `services/daemon/session/event/streams.ts` owns which names are streams and what each carries;
 * this function does no routing of its own. `session.subscribe` streams the whole log, catch up,
 * then follow, in the frames `event/envelope.fixture.ts` composes; opened with an `afterCursor` it
 * catches up on what follows that change alone (on the whole log after the start-of-log cursor),
 * and one this playback never delivered ends the subscription refused, as the daemon refuses a
 * cursor it cannot resolve. A bare event-type name carries only itself, one envelope per beat. The
 * two `run.*` streams are registered projections (`RunStateChangeEvent | RunRolledBackEvent` and
 * `QueueItemSummary`) built by `projection.fixture.ts`, with no catch-up because they are live; the
 * envelope would teach subscribers a frame the live bridge cannot send. A beat the projection
 * cannot build throws, and `lib/emitter.ts` re-raises after every sink has run, so the authoring
 * error reaches whoever advanced the clock without silencing other subscribers. The presence
 * subscription is not an event feed: the fixture scripts no device, so it is accepted and never
 * delivers. The machine's notice streams deliver the frame the scenario opens them with, then the
 * notices its settled replies push, live, with no catch-up.
 */
export function subscribeToScenario(
  engine: ScenarioEngine,
  subscriptionName: string,
  request: unknown,
  deliver: (delivered: unknown) => void,
  onEnded: ((end: DaemonSubscriptionEnd) => void) | undefined,
): Unsubscribe {
  // Only the whole-session stream catches up; the stream's `scope` from
  // `services/daemon/session/event/streams.ts` is that distinction, and the run streams and bare
  // event types are live.
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream?.scope === "machine-presence") {
    return () => undefined;
  }
  if (stream?.scope === "machine-notices") {
    const unsubscribe = engine.subscribeToNotices(subscriptionName, deliver);
    for (const opening of engine.scenario.openingNotices ?? []) {
      if (opening.stream === subscriptionName) {
        const payload = opening.payloadAtOpen(
          (...calls) => engine.answeredRequests(...calls),
          requestStampReaderFor(opening.stream),
        );
        deliver(assertOpeningOnContract(opening.stream, payload));
      }
    }
    return unsubscribe;
  }
  if (stream?.scope === "whole-session") {
    const afterCursor = isWireRecord(request) ? request["afterCursor"] : undefined;
    // The start-of-log cursor, which a read hands out as `earliest`, names the position before
    // the first beat, so it catches up on the whole log as an absent cursor does.
    const isFromStart = afterCursor === undefined || afterCursor === START_OF_LOG_CURSOR;
    const caughtUp = engine.deliveredEvents();
    const resumeAt = isFromStart
      ? 0
      : caughtUp.findIndex((event) => event.cursor === afterCursor) + 1;
    if (resumeAt === 0 && !isFromStart) {
      queueMicrotask(() => {
        onEnded?.({
          reason: "refused",
          refusal: {
            code: JsonRpcErrorCode.InvalidParams,
            message: "That cursor is not in this session's log.",
            data: { type: EVENT_CURSOR_UNRESOLVABLE_CODE },
          },
        });
      });
      return () => undefined;
    }
    // The catch-up is the first delivery, made before `subscribe` returns; it starts past the
    // cursor. Every beat is folded for its run stamp, the skipped ones too, since a run's turn
    // depends on the log before it.
    let skippedCount = resumeAt;
    const attribution = new ScenarioTurnAttribution();
    return engine.subscribe(
      (events) => {
        const stamped = events.map((event) => {
          const runStamp = attribution.attribute(event)?.stamp;
          return runStamp === undefined ? event : { ...event, runStamp };
        });
        const following = stamped.slice(skippedCount);
        skippedCount = 0;
        for (const frame of composeScenarioSessionFrames(following)) {
          deliver(frame);
        }
      },
      { catchUp: true },
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
