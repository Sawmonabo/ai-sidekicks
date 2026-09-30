// What a fixture subscriber is handed, and when.
//
// SUBSCRIPTIONS COME FROM the scenario engine, routed by the registered
// stream table and projected into the registered payload.** `daemon.subscribe`
// hands the caller beats as they fall due on the frozen clock, so a fixture
// session is replayable tick-for-tick and a screenshot pins an exact frame — and
// it hands them only to a subscriber the seam says they reach, in the shape that
// subscription registers. A fixture that forwarded the whole script to every
// subscriber delivered `session.created` into a handler that had asked for
// `run.starting`; a fixture that recognized only ONE stream name delivered
// nothing at all to the two `run.*` streams the daemon serves, which reads
// exactly like a quiet session; a fixture that delivered the envelope to those
// two streams sent a frame with no top-level `newState` on a wire whose whole
// payload is one; and a fixture that delivered the AUTHORING RECORD to the streams that
// do carry an envelope sent a frame carrying `kind` and `actorId`
// where the wire carries `type` and `actor`, which is how the console's decode
// boundary came to read fixture-local names and refuse every live delivery with
// every fixture test green. `session-event-streams.ts` routes,
// `run-stream-projection.ts` projects, `scenario-envelope.ts` composes, and all
// four defects are gone from the three tables between them. The relay
// subscription is routed by the same discipline on its own key: it names a
// SESSION rather than an event, so it delivers only to a subscriber that
// asked for the session the scenario plays. And the whole-session stream is
// replay-then-tail as the corpus registers it: a subscriber attaching after
// beats have been delivered is handed those beats before it tails, so a store
// opened mid-scenario does not read the next beat as a sequence gap.
//
// Its own module rather than the bottom of `bridge.ts`: this is the seam with
// four named defects behind it and three tables between them, and the bridge beside it
// is a composition. The bridge imports these two functions and neither imports it.
import type { RelayEventHandler, Unsubscribe } from "@shared/preload-api.js";

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
 * `daemon.subscribe(name, handler)` names either a registered stream or one event
 * type, and `session-event-streams.ts` owns which names are which and what each
 * stream carries. This function performs no routing of its own — a fixture that
 * kept a second reading of the seam would answer a `run.*` stream with silence
 * while the binder above it was passing a name the daemon serves.
 *
 * WHAT REACHES THE HANDLER depends on which arm the name is, because the corpus
 * registers different answers. `session.subscribe` is the replay-then-tail stream of
 * the whole log, delivered in FRAMES: each batch of beats the engine hands over goes
 * out as the frames `event-envelope.fixture.ts` composes, every change carrying the
 * canonical `EventEnvelope` and its cursor, exactly as the live daemon sends it. A
 * bare event-type name carries only itself, one envelope per beat. Both are the
 * wire's own shape rather than the console's authoring record, so the decode boundary
 * above is exercised here exactly as the live bridge exercises it. The two `run.*`
 * streams are registered PROJECTIONS —
 * `RunStateChangeEvent | RunRolledBackEvent` and `QueueItemSummary` — and
 * `run-stream-projection.ts` builds one from the beat. Handing those two the
 * envelope would train every run-stream subscriber on a frame the
 * live bridge cannot send: no `kind`, no `sequence`, no nested `payload`, and
 * a top-level `newState` where the envelope has `payload.newState`.
 *
 * AND WHEN IT REACHES THE HANDLER, for the one arm where that is a second question.
 * `session.subscribe` is registered replay-then-tail, so a subscriber that attaches
 * after the frozen clock has already delivered beats is handed those beats first, in
 * log order, and then tails. Without it a store opened mid-scenario read the next
 * beat as a real sequence gap — its snapshot answers at cursor zero, so every
 * position in between counts as missing — and a store opened after the script
 * finished stayed empty for the life of the window. The two narrowed run streams take
 * no replay: they are live projections, and handing a run-stream subscriber the transitions it
 * did not subscribe in time for would be inventing a subscription the daemon does not
 * serve.
 *
 * A beat the projection cannot build REFUSES here rather than delivering a partial
 * shape, and it refuses by throwing: `core/emitter.ts` runs every sink and re-raises
 * afterwards, so one scenario's authoring error surfaces to whoever advanced the
 * clock without silencing the other subscribers on that beat.
 *
 * AND ONE REGISTERED NAME IS NOT AN EVENT FEED AT ALL. The presence subscription
 * delivers the machine's device list rather than frames, so a walk over beats cannot
 * serve it however the kinds are routed. The fixture scripts no device, so the
 * subscription is accepted and never delivers — which is what the stream row's scope
 * discriminates, rather than letting the name match as a bare event type.
 */
export function subscribeToScenario(
  engine: ScenarioEngine,
  subscriptionName: string,
  deliver: (delivered: unknown) => void,
): Unsubscribe {
  // Replay-then-tail is the whole-session stream's registered behavior and no other
  // name's, and which name is which is `session-event-streams.ts`'s answer rather
  // than a second reading taken here: its `scope` IS that distinction — a stream that
  // represents the whole log is the one a subscriber can join late and expect the log
  // from, while the two narrowed run streams and every bare event type are live.
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
      // The queue stream's payload is a projection of the queue ROW, and the
      // scenario's stand-in for the daemon's row read is the reply it scripts for
      // that read. Resolved per beat, so a scenario replaced mid-subscription is
      // read afresh.
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

/**
 * Deliver a scenario's beats to one relay subscriber, scoped to its session.
 *
 * `packages/contracts/src/desktop-bridge.ts` declares
 * `subscribeRelay(sessionId: SessionId, handler: RelayEventHandler): Unsubscribe`,
 * and the session id is the whole of that subscription's scope: main negotiates and
 * opens the relay for THAT session and forwards its frames, so a subscriber for one
 * session never receives another's. The fixture ignored the argument and forwarded
 * every beat to every handler, so a multi-session test could
 * consume a stranger session's log and pass against behavior production does not
 * exhibit.
 *
 * DECIDED ONCE AT ATTACH, NOT PER DELIVERY, and that follows from the live contract
 * rather than shortcutting it. A scenario names exactly one session and an engine's
 * scenario is fixed for its life, so every beat this engine will ever play belongs to
 * `scenario.sessionId`: the predicate cannot change between one delivery and the
 * next, and a per-event filter would re-derive one constant per beat and answer the
 * same way each time. A subscription for any other session therefore attaches
 * nothing and hands back a no-op disposer — the silence the live bridge answers with
 * for a session whose relay carries no traffic, which is a reading rather than a
 * refusal: the fixture is not declining to serve that session, it holds nothing of
 * that session's to serve.
 *
 * Composed rather than forwarded raw for the reason the two envelope arms above are:
 * the relay frame is a stub the corpus has not shaped yet, and whatever it
 * turns out to be, it is not this console's own projection type. Handing that type
 * out here would leave one path through which the fixture still teaches a view a
 * shape no wire sends.
 */
export function subscribeToScenarioRelay(
  engine: ScenarioEngine,
  sessionId: string,
  handler: RelayEventHandler,
): Unsubscribe {
  if (sessionId !== engine.scenario.sessionId) {
    return () => undefined;
  }
  return engine.subscribe((events) => {
    for (const event of events) {
      handler(composeScenarioEventEnvelope(event));
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
