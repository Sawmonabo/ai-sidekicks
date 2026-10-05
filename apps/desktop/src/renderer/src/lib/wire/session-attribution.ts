// Holds an event payload's own `sessionId` against the envelope that delivered it.
//
// The store checks only the envelope's `sessionId`, and events are parsed through the tolerant
// envelope, so a payload naming another session would otherwise reach a fold and land that
// session's entity in this session's partition.
//
// The rule is for payloads whose `sessionId` is required (the run and approval folds), where
// absence fails. It compares the raw member, so a non-string `sessionId` fails instead of reading
// as absent. `refuseSessionDisagreement` in `services/run-streams/run-stream-shapes.ts` keeps its
// own check because it needs two distinct refusal sentences.

/**
 * Does this payload state the session its envelope was delivered on? For payloads whose
 * `sessionId` is required, so absence fails. A type predicate, since a payload that names the
 * session exists and callers index it next.
 */
export function payloadNamesSession(
  payload: Readonly<Record<string, unknown>> | undefined,
  envelopeSessionId: string,
): payload is Readonly<Record<string, unknown>> {
  return payload?.["sessionId"] === envelopeSessionId;
}
