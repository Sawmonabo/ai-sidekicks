// Which run an event payload names. It reads the open record every event carries, so the daemon's
// projection and any client reading raw events file a row under the same run.

import { TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS } from "./row.js";

/**
 * The run a payload belongs to: the first non-empty string among `runId` and `targetRunId`, or
 * `undefined` when it names none. An event belongs to a run exactly when this answers a run id.
 */
export function transcriptRunIdOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  for (const payloadKey of TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS) {
    const candidate = payload?.[payloadKey];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}
