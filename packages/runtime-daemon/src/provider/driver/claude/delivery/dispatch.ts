// Hands each delivery the Claude driver produces to the run engine's inbound dispatch. The call is
// made at once, in the order the driver produced the deliveries, because the dispatch attributes a
// delivery when it is called; a refusal goes to the diagnostic channel, which the daemon log
// carries, and is never dropped unrecorded.

import type { InboundDelivery, InboundOutcome } from "../../../../session/run/inbound.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { describeFailure, sanitizeFailureDetail } from "../session/errors.js";
import type { ClaudeInboundDispatchPort } from "../session/state.js";

/** What the delivery dispatch hands deliveries to and records refusals on. */
export interface ClaudeDeliveryDispatchDependencies {
  readonly inbound: ClaudeInboundDispatchPort;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/** The one path every Claude delivery takes to the run engine. */
export class ClaudeDeliveryDispatch {
  readonly #inbound: ClaudeInboundDispatchPort;
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: ClaudeDeliveryDispatchDependencies) {
    this.#inbound = dependencies.inbound;
    this.#diagnostics = dependencies.diagnostics;
  }

  /**
   * Dispatches `delivery` now and resolves with its outcome, or with `undefined` once a refusal is
   * recorded. `rawWireType` names the provider frame it came from, or `null` for the driver's own.
   */
  async send(
    delivery: InboundDelivery,
    rawWireType: string | null,
  ): Promise<InboundOutcome | undefined> {
    // Called before any await, so the dispatch attributes it in this call's order.
    const dispatched = this.#inbound.dispatch(delivery);
    try {
      return await dispatched;
    } catch (error) {
      this.#diagnostics.emit({
        provider: CLAUDE_DRIVER_NAME,
        kind: "delivery_dispatch_failed",
        rawWireType,
        dispositionReason: sanitizeFailureDetail(describeFailure(error)),
        details: { deliveryKind: delivery.kind, ...describeDeliveryScope(delivery) },
      });
      return undefined;
    }
  }
}

// The session a delivery on no binding is about, or the binding a delivery arrived on.
function describeDeliveryScope(delivery: InboundDelivery): {
  readonly sessionId: string | null;
  readonly bindingId: string | null;
} {
  switch (delivery.kind) {
    case "session_notice":
      return { sessionId: delivery.notice.sessionId, bindingId: null };
    case "session_event":
      return { sessionId: delivery.row.payload.sessionId, bindingId: null };
    default:
      return { sessionId: null, bindingId: delivery.bindingId };
  }
}
