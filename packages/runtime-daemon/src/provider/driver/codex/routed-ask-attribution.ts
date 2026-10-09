// Attributing each routed ask on the Codex leg (an approval, a question or a callback tool call) to
// the run that raised it, then handing it on: an approval or a question is held for its card, a
// callback tool call goes to the daemon's callback-tool host.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import type { CodexSessionSlots } from "./session/slots.js";
import {
  type CodexLifecycleOptions,
  readCodexFrameThreadId,
  soleActiveRunIdIn,
} from "./session/state.js";
import {
  type CodexAskOwner,
  type CodexInboundServerRequest,
  type CodexRoutedAskAttribution,
  type CodexRoutedAskTurnIdReading,
  type CodexServerRequestDecision,
  type CodexServerRequestResponder,
  type CodexAskKind,
  composeRoutedAskRefusalReason,
  readRoutedAskTurnId,
} from "./server-requests.js";
import { readCodexAskOptionSet } from "./ask-option-sets.js";
import type { CodexAskHandOff } from "./delivery/asks.js";
import { reportDiagnosticFromDetachedFrame } from "./transport/diagnostics.js";

/** What the attributor reads and hands asks to. */
export interface CodexRoutedAskAttributorDependencies {
  readonly options: Pick<
    CodexLifecycleOptions,
    "diagnostics" | "reportDiagnostic" | "answerCallbackToolCall"
  >;
  readonly slots: Pick<CodexSessionSlots, "recordFor">;
  readonly askHandOff: CodexAskHandOff;
  readonly bindingIdFor: (runId: RunId) => string | undefined;
}

/** Attributes each routed ask to a run by the turn it names, then hands it on. */
export class CodexRoutedAskAttributor {
  readonly #options: CodexRoutedAskAttributorDependencies["options"];
  readonly #slots: Pick<CodexSessionSlots, "recordFor">;
  readonly #askHandOff: CodexAskHandOff;
  readonly #bindingIdFor: (runId: RunId) => string | undefined;

  constructor(dependencies: CodexRoutedAskAttributorDependencies) {
    this.#options = dependencies.options;
    this.#slots = dependencies.slots;
    this.#askHandOff = dependencies.askHandOff;
    this.#bindingIdFor = dependencies.bindingIdFor;
  }

  /**
   * One session's responder: attributes each ask, refuses one that cannot be attributed, holds an
   * approval or a question for its card, and hands a callback tool call to the host with the
   * session, run and option set. The run id is resolved at answer time, since one captured
   * earlier could name a retired turn.
   */
  composeServerRequestResponder(sessionId: SessionId): CodexServerRequestResponder {
    return {
      answer: async (request: CodexInboundServerRequest): Promise<CodexServerRequestDecision> => {
        const attribution = await this.#attributeRoutedAsk(sessionId, request);
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
            details: { sessionId, declaredOptionCount: optionSet.declaredCount },
          });
        }
        if (request.askKind !== "callback-tool") {
          return await this.#askHandOff.hold(sessionId, attribution.owner, request);
        }
        const answerCallbackToolCall = this.#options.answerCallbackToolCall;
        if (answerCallbackToolCall === undefined) {
          return {
            decision: "refuse",
            reason: `The daemon has no callback-tool host for "${request.method}".`,
          };
        }
        return await answerCallbackToolCall.answer({
          ...request,
          sessionId,
          runId: attribution.owner?.runId ?? null,
          // Conditionally spread: under `exactOptionalPropertyTypes` an absent key
          // differs from undefined.
          ...(optionSet.kind === "read" ? { options: optionSet.options } : {}),
        });
      },
    };
  }

  /**
   * Attributes one routed ask to the run that raised it before the daemon's responder sees it: a
   * helper's ask to the helper's child run, else by the turn the ask names, once the run of a turn
   * Codex started by itself has opened. A named turn that cannot be resolved is refused, never
   * attributed to the sole active run.
   */
  async #attributeRoutedAsk(
    sessionId: SessionId,
    request: CodexInboundServerRequest,
  ): Promise<CodexRoutedAskAttribution> {
    // The ask may belong to the turn whose run is opening; its route stands once that settles.
    await this.#slots.recordFor(sessionId)?.delivery.selfStartedTurnOpening?.opened;
    const record = this.#slots.recordFor(sessionId);
    const threadId = readCodexFrameThreadId(request.method, request.params);
    const child =
      threadId === null || threadId === record?.threadId
        ? undefined
        : record?.delivery.childRunByThreadId.get(threadId);
    if (child !== undefined) {
      const started = await child.started;
      if (started === undefined) {
        return {
          outcome: "refused",
          reason:
            `The provider's "${request.method}" request came from a helper whose run did not ` +
            `start, so no one can answer it.`,
        };
      }
      return {
        outcome: "attributed",
        owner: { runId: started.childRunId, bindingId: child.bindingId },
      };
    }
    const turnIdReading = readRoutedAskTurnId(request.params);
    const resolvableTurnId = turnIdReading.resolvableTurnId;
    if (resolvableTurnId !== null) {
      const routedRunId = record?.runIdByActiveTurnId.get(resolvableTurnId);
      const owner = routedRunId === undefined ? null : this.#ownerOf(routedRunId);
      if (owner !== null) {
        return { outcome: "attributed", owner };
      }
    }
    if (turnIdReading.recordedTurnId === null && request.askKind !== "callback-tool") {
      // No turn claim on a shape whose params need none (a legacy approval, an elicitation with a
      // `null` turn id): the sole-active fallback applies. `callback-tool` requires a turn, so
      // its absence is itself the fault and refuses.
      const activeRunId = record === undefined ? null : soleActiveRunIdIn(record);
      return {
        outcome: "unattributed",
        owner: activeRunId === null ? null : this.#ownerOf(activeRunId),
      };
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
    askKind: CodexAskKind,
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
        "the invocation named no turn this daemon holds a live route for, so no run's tool " +
        "registry could adjudicate it",
      // Untrusted provider text, bounded at the reader, carried verbatim to correlate with its
      // log.
      details: { sessionId, method, turnId, turnIdTruncated },
    });
  }

  // A run and its binding; `null` for a run whose binding is gone.
  #ownerOf(runId: RunId): CodexAskOwner | null {
    const bindingId = this.#bindingIdFor(runId);
    return bindingId === undefined ? null : { runId, bindingId };
  }
}
