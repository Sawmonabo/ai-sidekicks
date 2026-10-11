// Reads a run state change back from the session event that stored it, for the readers that
// follow the log as it commits.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import {
  RUN_STATE_CHANGE_PAYLOAD_SCHEMAS,
  type RunStateChangePayload,
  type RunStateChangeState,
} from "@ai-sidekicks/contracts/run/events";

/** One stored run state change, whichever state it entered. */
export type StoredRunStateChange = RunStateChangePayload<RunStateChangeState>;

/**
 * The run state change `event` stored, or `undefined` for an event of any other type. Throws when
 * the payload does not match its contract: the log is the daemon's own, so that is a broken write.
 */
export function readStoredRunStateChange(event: EventEnvelope): StoredRunStateChange | undefined {
  if (!event.type.startsWith("run.")) {
    return undefined;
  }
  const state = event.type.slice("run.".length);
  if (!Object.hasOwn(RUN_STATE_CHANGE_PAYLOAD_SCHEMAS, state)) {
    return undefined;
  }
  return RUN_STATE_CHANGE_PAYLOAD_SCHEMAS[state as RunStateChangeState].parse(event.payload);
}
