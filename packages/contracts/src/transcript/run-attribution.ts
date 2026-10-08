// Which run an event payload names. It reads the open record every event carries, so the daemon's
// projection and any client reading raw events file a row under the same run.

/**
 * The payload keys that name a run: `runId` everywhere, and `targetRunId` on interventions.
 * Both are checked, since a guard reading only `runId` would let intervention rows through the
 * `general` arm.
 */
export const TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "runId",
  "targetRunId",
] as const);

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
