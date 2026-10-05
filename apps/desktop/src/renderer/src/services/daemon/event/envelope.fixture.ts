// One authored beat composed into the wire envelope the daemon would have sent, and a run of them
// into the `session.subscribe` frames that carry them. A scenario is authored in
// `ProjectedSessionEvent`s, but `session.subscribe` carries the canonical `EventEnvelope`
// (`packages/contracts/src/event/envelope.ts`), whose event type is `type` and whose attribution
// is `actor`.
// A fixture that delivered the authoring shape would agree with the app's decode boundary and
// with nothing the daemon sends, so this is the one place the first becomes the second.
//
// Composing is not judging: the result is a candidate that carries only what the beat states, so a
// kind outside the census composes with no `category`, which `EventEnvelopeSchema` refuses. The
// judges are the schemas, run by `tests/helpers/scenario-contract-check/contract-check.ts` on every
// beat before a scenario ships and by `session/event/payload.ts` on every delivery.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session-event";
import {
  STREAM_FRAME_MAX_CHANGES,
  type StreamFrame,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";

/**
 * The envelope version every composed beat carries, as `"MAJOR.MINOR"`. No beat states it and no
 * view reads it, so the composer supplies it; the contract check and the delivery both compose
 * through here and so agree.
 */
export const SCENARIO_ENVELOPE_VERSION: string = "1.0";

/**
 * Every canonical envelope member, at the type an authored beat can supply. Not `EventEnvelope`,
 * whose branded `sessionId` and `version` and required `category` would claim what the schemas
 * are run to find out. `category` is optional because a kind outside the census has none, which
 * reports that no daemon emits the beat.
 */
export interface ScenarioEventEnvelopeCandidate {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  /** Absent when the beat's kind is not a registered event type. */
  readonly category?: EventCategory;
  readonly type: string;
  /** Absent when the beat attributes itself to nobody (the system arm). */
  readonly actor?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly version: string;
}

/** One composed change on the session stream: a beat's envelope and its cursor. */
export interface ScenarioSessionStreamChange {
  readonly cursor: string;
  readonly event: ScenarioEventEnvelopeCandidate;
}

/** One composed `session.subscribe` frame. */
export type ScenarioSessionStreamFrame = StreamFrame<ScenarioSessionStreamChange, string>;

/**
 * Compose the wire envelope one beat is delivered as. Total: every beat composes, including a
 * malformed one, since the schema judges it. `payload` defaults to an empty record because the
 * wire never omits it; `actor` stays absent when unstated, since absent and present-null differ on
 * the wire.
 */
export function composeScenarioEventEnvelope(
  event: ProjectedSessionEvent,
): ScenarioEventEnvelopeCandidate {
  const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(event.kind as SessionEventType);
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    ...(category === undefined ? {} : { category }),
    type: event.kind,
    ...(event.actorId === undefined ? {} : { actor: event.actorId }),
    payload: event.payload ?? {},
    version: SCENARIO_ENVELOPE_VERSION,
  };
}

/**
 * Compose the `session.subscribe` frames one batch of beats is delivered in: frames of at most
 * `STREAM_FRAME_MAX_CHANGES`, oldest first. The fixture never falls behind, so no frame carries
 * the drop mark, and an empty batch is no frame at all. Each change carries its beat's cursor.
 */
export function composeScenarioSessionFrames(
  events: readonly ProjectedSessionEvent[],
): readonly ScenarioSessionStreamFrame[] {
  const frames: ScenarioSessionStreamFrame[] = [];
  for (let start = 0; start < events.length; start += STREAM_FRAME_MAX_CHANGES) {
    frames.push({
      changes: events.slice(start, start + STREAM_FRAME_MAX_CHANGES).map((event) => ({
        cursor: event.cursor,
        event: composeScenarioEventEnvelope(event),
      })),
    });
  }
  return frames;
}
