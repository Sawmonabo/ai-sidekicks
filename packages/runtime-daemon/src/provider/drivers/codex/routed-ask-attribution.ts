// Attributing each routed ask (an approval or callback-tool request) on the Codex leg to the run
// that raised it, before the daemon's responder adjudicates it.

import type { RunId, SessionId } from "@ai-sidekicks/contracts";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import {
  type CodexLifecycleOptions,
  type CodexSessionRecord,
  soleActiveRunIdIn,
} from "./session-state.js";
import {
  type CodexInboundServerRequest,
  type CodexRoutedAskAttribution,
  type CodexRoutedAskTurnIdReading,
  type CodexServerRequestDecision,
  type CodexServerRequestResponder,
  type CodexSessionServerRequestResponder,
  composeRoutedAskRefusalReason,
  readRoutedAskTurnId,
} from "./server-requests.js";
import { CODEX_ASK_OPTION_SET_MAX, readCodexAskOptionSet } from "./ask-option-sets.js";
import { reportDiagnosticFromDetachedFrame } from "./transport-diagnostics.js";

/** Attributes each routed ask to a run by the turn it names, then hands it to the responder. */
export class CodexRoutedAskAttributor {
  readonly #options: Pick<CodexLifecycleOptions, "diagnostics" | "reportDiagnostic">;
  readonly #sessions: ReadonlyMap<SessionId, CodexSessionRecord>;

  constructor(
    options: Pick<CodexLifecycleOptions, "diagnostics" | "reportDiagnostic">,
    sessions: ReadonlyMap<SessionId, CodexSessionRecord>,
  ) {
    this.#options = options;
    this.#sessions = sessions;
  }

  /**
   * One session's transport responder: attributes each ask, refuses one that cannot be attributed,
   * and forwards the rest with the session, run and option set. The run id is resolved at answer
   * time, since one captured at connection build could name a retired turn.
   */
  composeServerRequestResponder(
    sessionId: SessionId,
    answerServerRequest: CodexSessionServerRequestResponder,
  ): CodexServerRequestResponder {
    return {
      answer: async (request: CodexInboundServerRequest): Promise<CodexServerRequestDecision> => {
        const attribution = this.#attributeRoutedAsk(sessionId, request);
        if (attribution.outcome === "refused") {
          // Refused before adjudication and before the option-set read: an ask that
          // cannot be attributed is not decided.
          return { decision: "refuse", reason: attribution.reason };
        }
        // Normalized where both the raw ask and the session the diagnostic names are
        // known; `params` still travels verbatim.
        const optionSet = readCodexAskOptionSet(request.method, request.params);
        if (optionSet.kind === "dropped") {
          // Never silent, never a refusal: the ask stays answerable through the free-text
          // arm, so dropping the options degrades the card, not the turn.
          this.#options.diagnostics.emit({
            provider: CODEX_DRIVER_NAME,
            kind: "interactive_request_option_set_dropped",
            rawWireType: request.method,
            dispositionReason: optionSet.reason,
            details: {
              sessionId,
              declaredOptionCount: optionSet.declaredCount,
              optionSetMax: CODEX_ASK_OPTION_SET_MAX,
            },
          });
        }
        return await answerServerRequest.answer({
          ...request,
          sessionId,
          runId: attribution.runId,
          // Conditionally spread: under `exactOptionalPropertyTypes` an absent key
          // differs from undefined.
          ...(optionSet.kind === "read" ? { options: optionSet.options } : {}),
        });
      },
    };
  }

  /**
   * Attributes one routed ask to the run that raised it, by the turn the ask names, before the
   * daemon's responder sees it. A named turn that cannot be resolved is refused, never attributed
   * to the sole active run.
   */
  #attributeRoutedAsk(
    sessionId: SessionId,
    request: CodexInboundServerRequest,
  ): CodexRoutedAskAttribution {
    const turnIdReading = readRoutedAskTurnId(request.params);
    const resolvableTurnId = turnIdReading.resolvableTurnId;
    if (resolvableTurnId !== null) {
      const routedRunId = this.#sessions.get(sessionId)?.runIdByActiveTurnId.get(resolvableTurnId);
      if (routedRunId !== undefined) {
        return { outcome: "attributed", runId: routedRunId };
      }
    }
    if (turnIdReading.recordedTurnId === null && request.askKind !== "callback-tool") {
      // No turn claim on a shape whose params need none (a legacy approval, an elicitation with a
      // `null` turn id): the sole-active fallback applies. `callback-tool` requires a turn, so
      // its absence is itself the fault and refuses.
      return { outcome: "unattributed", runId: this.#activeRunIdFor(sessionId) };
    }
    this.#reportRoutedAskTurnUnresolved(sessionId, request.method, turnIdReading, request.askKind);
    return {
      outcome: "refused",
      // Refused for every kind: the sole-active run would judge the ask under a newer run's
      // identity, and a decline is retryable where a wrong approval is not. An over-bound
      // `turnId` counts as named, since a truncated prefix could match another live turn. The
      // provider reads the reason.
      reason: composeRoutedAskRefusalReason(request.method, turnIdReading),
    };
  }

  /**
   * Records one refused routed ask that named an unresolvable turn. The transport arm takes every
   * refusal; the shared diagnostic kind only callback-tool ones, since
   * `callback_tool_invocation_refused` counts those and other refusals would corrupt that count.
   */
  #reportRoutedAskTurnUnresolved(
    sessionId: SessionId,
    method: string,
    turnIdReading: CodexRoutedAskTurnIdReading,
    askKind: "callback-tool" | "approval",
  ): void {
    const turnId = turnIdReading.recordedTurnId;
    const turnIdTruncated = turnIdReading.recordedTurnIdTruncated;
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "routed-ask-turn-unresolved",
      method,
      turnId,
      turnIdTruncated,
      disposition: "refused",
    });
    if (askKind !== "callback-tool") {
      return;
    }
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "callback_tool_invocation_refused",
      rawWireType: method,
      dispositionReason:
        "the invocation named no turn this daemon holds a live route for, so no run's tool registry could adjudicate it",
      // Untrusted provider text, bounded at the reader, carried verbatim to correlate with its
      // log.
      details: { sessionId, method, turnId, turnIdTruncated },
    });
  }

  /**
   * The run that owns every live turn on a session, or `null` when none does or two runs are
   * live. The id-keyed form of {@link soleActiveRunIdIn}; a caller holding the record calls that
   * directly, since re-resolving by id after an await can answer about a successor record.
   */
  #activeRunIdFor(sessionId: SessionId): RunId | null {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return null;
    }
    return soleActiveRunIdIn(record);
  }
}
