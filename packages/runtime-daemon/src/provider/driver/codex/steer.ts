// Steering a Codex run's active turn: writing the person's words to `turn/steer`, as typed, with
// their picked skills and staged files, and reading which turn the provider says took them. Steers
// on one conversation go out one at a time, each once Codex answered the one before, in the order
// they were handed over.

import type { PickedSkill } from "@ai-sidekicks/contracts/provider/driver/intervention";

import type { ProviderAttachment } from "../attachments.js";
import { composeCodexMessageInput } from "./attachments.js";
import type { CodexSteerAcknowledgement } from "./intervention.js";
import { CodexTransportError } from "./session/errors.js";
import type { CodexSessionRecord } from "./session/state.js";
import { readSteeredTurnId } from "./thread/view.js";

/**
 * One steer as it goes on the wire: its words, skills and files, the turn it is pinned to, and its
 * key.
 */
export interface CodexSteerInput {
  readonly content: string;
  /** The skills picked for the message, in the order picked. */
  readonly skills: readonly PickedSkill[] | undefined;
  /** Bound from the moment the steer is handed over, so a slow binding never reorders steers. */
  readonly attachments: Promise<readonly ProviderAttachment[]>;
  /** Pins the steer to a turn; absent means the live turn. */
  readonly expectedTurnId?: string | undefined;
  /** The requester's key, placed on the wire unchanged. */
  readonly clientIdempotencyKey: string;
}

/**
 * Steers `turnId` on `record`, or the turn the steer expects, and reports both the turn it
 * targeted and the turn the provider acknowledged. Sent once the conversation's previous steer
 * settled and its files are bound. Throws the request's failure, the files' binding failure, and
 * `CodexTransportError` when the turn is no longer the run's live one by then.
 */
export async function steerActiveTurn(
  record: CodexSessionRecord,
  turnId: string,
  steer: CodexSteerInput,
): Promise<CodexSteerAcknowledgement> {
  // A caller-supplied expectation wins, so the provider refuses a stale steer rather than
  // retargeting it; kept local because the dispatcher grades against what went on the wire.
  const targetedTurnId = steer.expectedTurnId ?? turnId;
  const previousSend = record.lastSteerSend;
  // Both are awaited from here, so a binding that fails before the previous steer settles is this
  // steer's failure at once, never an unhandled one.
  const send = Promise.all([previousSend, steer.attachments]).then(([, attachments]) => {
    // A steer that waited behind another is sent only while its turn is still the run's live one,
    // never into a turn an interrupt retired or a conversation the session has left.
    if (!record.runIdByActiveTurnId.has(turnId)) {
      throw new CodexTransportError("The turn ended before the steer was sent.", {
        threadId: record.threadId,
      });
    }
    return record.service.request("turn/steer", {
      threadId: record.threadId,
      input: composeCodexMessageInput([
        { text: steer.content, skills: steer.skills ?? [], attachments },
      ]),
      expectedTurnId: targetedTurnId,
      // The requester's key, verbatim and never re-minted, or the intervention dedupe guard is
      // defeated. `clientUserMessageId` is the provider's caller-supplied message id field, as on
      // `turn/start`.
      clientUserMessageId: steer.clientIdempotencyKey,
    });
  });
  // The next steer waits for the one before this and for this one, whichever way each ends; this
  // one's failure reaches its own caller below.
  record.lastSteerSend = Promise.allSettled([previousSend, send]).then(() => undefined);
  const result = await send;
  return { targetedTurnId, acknowledgedTurnId: readSteeredTurnId(result) };
}
