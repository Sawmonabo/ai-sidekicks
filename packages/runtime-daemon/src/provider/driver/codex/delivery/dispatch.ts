// Hands each delivery the Codex driver produces to the run engine's inbound dispatch. The call is
// made at once, in the order the driver produced the deliveries, because the dispatch attributes a
// delivery when it is called; a refusal goes to the daemon's log and is never dropped unrecorded.

import type { SessionNoticePayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type {
  InboundDelivery,
  InboundOutcome,
  RunInboundDispatch,
} from "../../../../session/run/inbound.js";
import { normalizeProviderFailureDetail } from "../session/errors.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";

/** The run engine's inbound dispatch, as the driver calls it. */
export type CodexInboundDispatchPort = Pick<RunInboundDispatch, "dispatch">;

/** The one path every Codex delivery takes to the run engine. */
export class CodexDeliveryDispatch {
  readonly #inbound: CodexInboundDispatchPort;
  readonly #reportDiagnostic: CodexDiagnosticSink;

  constructor(inbound: CodexInboundDispatchPort, reportDiagnostic: CodexDiagnosticSink) {
    this.#inbound = inbound;
    this.#reportDiagnostic = reportDiagnostic;
  }

  /**
   * Dispatches `delivery` now and resolves with its outcome, or with `undefined` once a refusal is
   * recorded. `method` names the provider frame it came from, or `null` for the driver's own.
   */
  async send(
    sessionId: SessionId,
    delivery: InboundDelivery,
    method: string | null,
  ): Promise<InboundOutcome | undefined> {
    // Called before any await, so the dispatch attributes it in this call's order.
    const dispatched = this.#inbound.dispatch(delivery);
    try {
      return await dispatched;
    } catch (cause) {
      reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, {
        kind: "delivery-dispatch-failed",
        method,
        deliveryKind: delivery.kind,
        sessionId,
        detail: normalizeProviderFailureDetail(cause),
      });
      return undefined;
    }
  }

  /** Appends a notice about a session, on no binding; a refusal is recorded. */
  sendNotice(notice: SessionNoticePayload, method: string | null): void {
    void this.send(notice.sessionId, { kind: "session_notice", notice }, method);
  }
}
