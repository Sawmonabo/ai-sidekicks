// Steering a Codex run's active turn: writing the person's words to `turn/steer`, as typed, and
// reading which turn the provider says took them. Steers on one conversation go out one at a time,
// each once Codex answered the one before, in the order they were handed over.

import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";
import { CodexTransportError } from "./session/errors.js";
import type { CodexSessionRecord } from "./session/state.js";
import { readSteeredTurnId } from "./thread/view.js";

/**
 * Steers `turnId` on `record`, or the turn the request expects, and reports both the turn it
 * targeted and the turn the provider acknowledged. Sent once the conversation's previous steer
 * settled. Throws the request's failure, and `CodexTransportError` when the turn is no longer the
 * run's live one by then.
 */
export async function steerActiveTurn(
  record: CodexSessionRecord,
  turnId: string,
  request: CodexSteerRunRequest,
): Promise<CodexSteerAcknowledgement> {
  // A caller-supplied expectation wins, so the provider refuses a stale steer rather than
  // retargeting it; kept local because the dispatcher grades against what went on the wire.
  const targetedTurnId = request.expectedTurnId ?? turnId;
  const send = record.lastSteerSend.then(() => {
    // A steer that waited behind another is sent only while its turn is still the run's live one,
    // never into a turn an interrupt retired or a conversation the session has left.
    if (!record.runIdByActiveTurnId.has(turnId)) {
      throw new CodexTransportError("The turn ended before the steer was sent.", {
        threadId: record.threadId,
      });
    }
    return record.service.request("turn/steer", {
      threadId: record.threadId,
      input: [{ type: "text", text: request.content, text_elements: [] }],
      expectedTurnId: targetedTurnId,
      // The requester's key, verbatim and never re-minted, or the intervention dedupe guard is
      // defeated. `clientUserMessageId` is the provider's caller-supplied message id field, as on
      // `turn/start`.
      clientUserMessageId: request.clientIdempotencyKey,
    });
  });
  // The next steer waits for this one either way; its failure reaches its own caller below.
  record.lastSteerSend = send.then(
    () => undefined,
    () => undefined,
  );
  const result = await send;
  return { targetedTurnId, acknowledgedTurnId: readSteeredTurnId(result) };
}
