// Which run an event payload names. It reads the open record every event carries, so the daemon's
// projection and any client reading raw events file a row under the same run, and fold the same
// events into a run's own facts.

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
    const runId = runIdAt(payload, payloadKey);
    if (runId !== undefined) {
      return runId;
    }
  }
  return undefined;
}

/**
 * The run a payload names as its own, by `runId` alone, or `undefined` when it names none. An
 * intervention's `targetRunId` files its row under the run it targets but is not that run's own
 * event, so it says nothing of who acts for the run or the state it is in.
 */
export function transcriptOwnRunIdOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return runIdAt(payload, "runId");
}

function runIdAt(
  payload: Readonly<Record<string, unknown>> | undefined,
  payloadKey: string,
): string | undefined {
  const runId = payload?.[payloadKey];
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}
