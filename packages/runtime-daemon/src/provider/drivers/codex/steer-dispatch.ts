// Steering a Codex run's active turn: composing and registering the steer frame, writing
// `turn/steer`, and moving or ruling the frame by what the provider acknowledged.

import type {
  OutboundFrameTripwire,
  OutboundTextFrame,
  OutboundTextFrameWriter,
} from "../../outbound-frame.js";
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";
import type { CodexSessionRecord } from "./session-state.js";
import type { CodexRequestAttempt } from "./app-server-connection.js";
import { readSteeredTurnId } from "./thread-view.js";
import type { CodexTextNeutralization } from "./text-neutralization.js";

/** The frame machinery a steer writes through and the tripwire rulings it applies. */
export interface CodexSteerDispatchDependencies {
  readonly outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly outboundFrameTripwire: OutboundFrameTripwire;
  readonly textNeutralization: CodexTextNeutralization;
}

/** Writes each steer as a registered, tripwire-watched frame joining the run's live turn. */
export class CodexSteerDispatch {
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #textNeutralization: CodexTextNeutralization;

  constructor(dependencies: CodexSteerDispatchDependencies) {
    this.#outboundTextFrameWriter = dependencies.outboundTextFrameWriter;
    this.#outboundFrameTripwire = dependencies.outboundFrameTripwire;
    this.#textNeutralization = dependencies.textNeutralization;
  }

  /**
   * Steers `turnId` on `record`, or the turn the request expects. Throws the request's failure
   * after ruling the frame by how far its bytes got.
   */
  async steerActiveTurn(
    record: CodexSessionRecord,
    turnId: string,
    request: CodexSteerRunRequest,
  ): Promise<CodexSteerAcknowledgement> {
    // A caller-supplied expectation wins, so the provider refuses a stale steer rather than
    // retargeting it; kept local because the dispatcher grades against what went on the wire.
    const targetedTurnId = request.expectedTurnId ?? turnId;
    // Registered against the targeted turn: a steer joins an existing turn and is never re-keyed.
    const steerFrame = this.#outboundTextFrameWriter.compose({
      text: request.content,
      origin: request.frameOrigin,
    });
    // Refuses before the write: a steer the tripwire cannot watch could be swallowed invisibly.
    this.#outboundFrameTripwire.register({
      scopeKey: record.sessionId,
      joinKey: targetedTurnId,
      // No stream item vouches for a steer; it is consumed on its own request's answer.
      frameRole: "turn-joining",
      frame: steerFrame,
    });
    // Pins the settled-turn memory across the whole round trip, acknowledgement read included.
    record.inFlightSteers += 1;
    try {
      const attempt = await this.#requestTurnSteer(record, request, steerFrame, targetedTurnId);
      if (attempt.settled === "answered") {
        const acknowledgedTurnId = readSteeredTurnId(attempt.result);
        // The answer proves the provider took the frame; stream items credit only the opening
        // frame, so without this every steer would trip a healthy session. Also for a null ack.
        this.#outboundFrameTripwire.recordRequestAnswered(steerFrame);
        if (acknowledgedTurnId !== null && acknowledgedTurnId !== targetedTurnId) {
          // The provider says where the bytes went, so the frame follows the acknowledged turn;
          // left on the wrong turn it would trip a turn that swallowed nothing. A settled turn
          // emits no second terminal, so its frame is consumed on its recorded acknowledgment.
          if (this.#textNeutralization.canStillRuleFrameOnTurn(record, acknowledgedTurnId)) {
            this.#outboundFrameTripwire.recorrelateFrame(steerFrame, acknowledgedTurnId);
          } else {
            this.#textNeutralization.consumeAnsweredSteerFrame(record, request.runId, steerFrame);
          }
        }
        return { targetedTurnId, acknowledgedTurnId };
      }
      this.#textNeutralization.ruleFailedSteerFrame(
        record,
        request.runId,
        steerFrame,
        attempt.delivery,
      );
      throw attempt.cause;
    } finally {
      record.inFlightSteers -= 1;
    }
  }

  async #requestTurnSteer(
    record: CodexSessionRecord,
    request: CodexSteerRunRequest,
    steerFrame: OutboundTextFrame,
    targetedTurnId: string,
  ): Promise<CodexRequestAttempt> {
    // The classifying entry point: a rejection from `request` cannot say whether the provider
    // acted.
    return await record.connection.attemptRequest("turn/steer", {
      threadId: record.threadId,
      input: [{ type: "text", text: steerFrame.wireText, text_elements: [] }],
      expectedTurnId: targetedTurnId,
      // The requester's key, verbatim and never re-minted, or the intervention dedupe guard is
      // defeated. `clientUserMessageId` is the provider's caller-supplied message id field, as on
      // `turn/start`.
      clientUserMessageId: request.clientIdempotencyKey,
    });
  }
}
