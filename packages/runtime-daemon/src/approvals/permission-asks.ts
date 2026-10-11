// The approval pipeline's intake of provider permission asks, and the way back of each answer. Each
// ask passes the permission check, which answers it itself where the daemon has an answer (the
// refusal of a background Claude Code command, the allow of an agent's own memory note, a rule in
// force on its subject) and else raises its card. An answer the daemon gives goes straight back to
// its provider with no record, and an allow among them marks the session's working folder stale,
// as an approved card does. A card's answer is recorded, then goes back to the provider that holds
// the call, decision first, with the rule it made, which is recorded once the provider kept it.

import type {
  ApprovalResolveRequest,
  ApprovalResolveResponse,
} from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type {
  PermissionCheckResponse,
  PermissionCheckService,
} from "../policy/permission-check.js";
import type { RespondToRequestParams } from "../provider/driver/contract.js";
import {
  ProviderRuleNotKeptError,
  type PermissionAskPort,
  type ProviderAnswerRule,
  type ProviderAskAction,
  type ProviderPermissionAnswer,
  type ProviderPermissionAsk,
} from "../provider/port/permission-ask.js";
import { mintUuidV7 } from "../uuid-v7.js";
import { ApprovalRuleNotKeptError } from "./refusals.js";
import type { ApprovalRules } from "./rules.js";
import type { ApprovalService } from "./service.js";

/** What the intake raises cards through and answers providers with. */
export interface PermissionAsksDeps {
  readonly approvals: Pick<
    ApprovalService,
    "resolve" | "withdraw" | "readRequest" | "readAskRequest" | "markAllowed"
  >;
  readonly permissionCheck: Pick<PermissionCheckService, "check">;
  readonly rules: Pick<ApprovalRules, "record" | "readProjectFolders">;
  /** Hands an answer to the driver that runs the run holding the ask. */
  readonly respondToRequest: (params: RespondToRequestParams) => Promise<void>;
}

// A provider's ask from the moment its card is being raised until its answer goes back or the
// provider takes it back; one taken back while its card was being raised is canceled once it is.
interface HeldAsk {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly requestId: string;
  readonly askId: string;
  readonly action: ProviderAskAction;
  // Aborted once the provider takes the ask back.
  readonly withdrawal: AbortController;
}

/** Takes each admitted provider ask and carries each card's answer back to its provider. */
export class PermissionAsks implements PermissionAskPort {
  readonly #deps: PermissionAsksDeps;
  // By run and the provider's request id, which names one ask only while it is held: a delivery
  // of an ask still held is that ask again, and once it is settled the same id names a new one.
  readonly #heldByKey = new Map<string, HeldAsk>();

  constructor(deps: PermissionAsksDeps) {
    this.#deps = deps;
  }

  /**
   * Answers the ask itself where the permission check has an answer for it, else raises its card
   * under an ask id the daemon mints, so a provider that numbers its asks afresh after a restart
   * never reaches a card already settled; the same ask delivered again while held raises nothing.
   * Rejects when the card could not be raised, as the approval service's create does.
   */
  async takeAsk(ask: ProviderPermissionAsk): Promise<void> {
    const key = heldKeyOf(ask.runId, ask.requestId);
    if (this.#heldByKey.has(key)) {
      return;
    }
    const askId = mintUuidV7();
    const held: HeldAsk = {
      sessionId: ask.sessionId,
      runId: ask.runId,
      requestId: ask.requestId,
      askId,
      action: ask.action,
      withdrawal: new AbortController(),
    };
    // Held from the first moment, so a withdrawal that arrives while the ask is read finds it.
    this.#heldByKey.set(key, held);
    let checked: PermissionCheckResponse;
    try {
      checked = await this.#deps.permissionCheck.check({
        kind: "provider_ask",
        ask,
        askId,
        signal: held.withdrawal.signal,
      });
    } catch (error) {
      this.#heldByKey.delete(key);
      // Taken back before its card was raised: there is no card and no one to answer.
      if (held.withdrawal.signal.aborted && error === held.withdrawal.signal.reason) {
        return;
      }
      throw error;
    }
    if (checked.reason === "pending_approval") {
      if (held.withdrawal.signal.aborted) {
        await this.#deps.approvals.withdraw(checked.approvalRequestId);
      }
      return;
    }
    this.#heldByKey.delete(key);
    if (held.withdrawal.signal.aborted) {
      return;
    }
    await this.#deps.respondToRequest({
      runId: ask.runId,
      requestId: ask.requestId,
      response: providerAnswerOf(checked),
    });
    if (checked.allowed) {
      await this.#deps.approvals.markAllowed(ask.sessionId);
    }
  }

  /**
   * Settles the card of an ask its provider took back, canceled; an answered one keeps its answer.
   */
  async withdrawAsk(withdrawal: { sessionId: SessionId; requestId: string }): Promise<void> {
    for (const [key, held] of this.#heldByKey) {
      if (held.sessionId === withdrawal.sessionId && held.requestId === withdrawal.requestId) {
        this.#heldByKey.delete(key);
        held.withdrawal.abort(new Error("The provider took the ask back"));
        const stored = this.#deps.approvals.readAskRequest(held.runId, held.askId);
        if (stored !== undefined) {
          await this.#deps.approvals.withdraw(stored.approvalRequestId);
        }
        return;
      }
    }
  }

  /**
   * Records one answer, then hands it to the provider that holds the call, decision first, then
   * records the rule it made once the provider kept it. The same answer sent again is answered
   * with what was saved and hands the provider nothing a second time. Throws the approval
   * service's refusals; `approval.rule_not_kept` when the call was answered but its provider could
   * not keep the rule, which is then not recorded; and what reaching a provider or recording the
   * rule throws, with the answer kept.
   */
  async resolve(
    request: ApprovalResolveRequest,
    answeringDeviceId: DeviceId,
  ): Promise<ApprovalResolveResponse> {
    const { response, wasRecorded } = await this.#deps.approvals.resolve(
      request,
      answeringDeviceId,
    );
    const stored = this.#deps.approvals.readRequest(request.approvalRequestId);
    const held =
      !wasRecorded || stored?.askId === undefined
        ? undefined
        : this.#findHeld(stored.runId, stored.askId);
    // A replay of an answer already handed on, or a card no provider raised: nothing goes back.
    if (stored === undefined || held === undefined) {
      return response;
    }
    this.#heldByKey.delete(heldKeyOf(held.runId, held.requestId));
    const scope = request.rememberedScope;
    const madeRule: ProviderAnswerRule | undefined =
      scope === undefined
        ? undefined
        : {
            rule: {
              kind: scope.kind,
              sense: scope.sense,
              action: held.action.kind,
              subject: scope.pattern,
            },
            projectFolders:
              scope.kind === "project" ? this.#deps.rules.readProjectFolders(held.sessionId) : [],
          };
    try {
      await this.#deps.respondToRequest({
        runId: held.runId,
        requestId: held.requestId,
        response: composeAnswer(request, madeRule),
      });
    } catch (error) {
      throw error instanceof ProviderRuleNotKeptError
        ? new ApprovalRuleNotKeptError(request.approvalRequestId, error.cause)
        : error;
    }
    if (madeRule !== undefined) {
      await this.#deps.rules.record(stored, madeRule);
    }
    return response;
  }

  /** Lets go of the asks of a run that ended, whose cards its approval service cancels. */
  forgetRun(runId: RunId): void {
    for (const [key, held] of this.#heldByKey) {
      if (held.runId === runId) {
        this.#heldByKey.delete(key);
      }
    }
  }

  #findHeld(runId: RunId, askId: string): HeldAsk | undefined {
    for (const held of this.#heldByKey.values()) {
      if (held.runId === runId && held.askId === askId) {
        return held;
      }
    }
    return undefined;
  }
}

function heldKeyOf(runId: RunId, requestId: string): string {
  return `${runId}\u0000${requestId}`;
}

// The provider's answer to an ask the permission check settled without a card.
function providerAnswerOf(
  checked: Exclude<PermissionCheckResponse, { reason: "pending_approval" }>,
): ProviderPermissionAnswer {
  if (!checked.allowed) {
    return { decision: "refuse", reason: checked.refusal };
  }
  return checked.reason === "remembered_rule"
    ? { decision: "allow", answeredByRule: checked.rule }
    : { decision: "allow" };
}

function composeAnswer(
  request: ApprovalResolveRequest,
  madeRule: ProviderAnswerRule | undefined,
): ProviderPermissionAnswer {
  if (request.decision === "approved") {
    return {
      decision: "allow",
      ...(request.editedAction === undefined ? {} : { editedAction: request.editedAction }),
      ...(madeRule === undefined ? {} : { madeRule }),
    };
  }
  return {
    decision: "refuse",
    ...(request.declineReason === undefined ? {} : { reason: request.declineReason }),
    ...(madeRule === undefined ? {} : { madeRule }),
  };
}
