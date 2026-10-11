// The approval pipeline's intake of provider permission asks, and the way back of each answer. An
// ask the daemon answers itself goes straight back to its provider with no card and no record: the
// refusal of a background Claude Code command, the allow of an agent's own memory note, and an ask
// a rule in force already answers, as a Codex conversation started again asks for a subject its
// session allowed; an allow never answers a destructive git command or an ask the provider's own
// check flagged, which always reach the card. Every other ask raises a card. Its answer is
// recorded, then goes back to the provider that holds the call, decision first, with the rule it
// made, which is recorded once the provider kept it.

import type {
  ApprovalRequestId,
  ApprovalResolveRequest,
  ApprovalResolveResponse,
} from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type { PathRules } from "../path-rules/contract.js";
import { answerProviderAsk } from "../policy/provider-ask-answers.js";
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
import { deriveRuleSubject, describeProviderAsk, mayAllowStand } from "./ask-description.js";
import { ApprovalRuleNotKeptError } from "./refusals.js";
import type { ApprovalRules } from "./rules.js";
import type { ApprovalService } from "./service.js";

/** What the intake raises cards through and answers providers with. */
export interface PermissionAsksDeps {
  readonly approvals: Pick<
    ApprovalService,
    "create" | "resolve" | "withdraw" | "readRequest" | "readAskRequest"
  >;
  readonly rules: Pick<ApprovalRules, "findRule" | "record" | "readProjectFolders">;
  /** The one all-projects agent-memory folder, whose notes an agent reads and writes unasked. */
  readonly agentMemoryFolder: string;
  /** How the system spells and compares paths. */
  readonly pathRules: PathRules;
  /** The agent whose run holds the ask, which the card names as its asker. */
  readonly readRunAgent: (sessionId: SessionId, runId: RunId) => string;
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
  isWithdrawn: boolean;
}

// What the agent reads when a rule in force blocks the subject its call names.
const BLOCKED_BY_RULE_REASON = "A rule in force on this session blocks this.";

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
   * Answers the ask itself where the daemon has an answer for it, else raises its card under an
   * ask id the daemon mints, so a provider that numbers its asks afresh after a restart never
   * reaches a card already settled; the same ask delivered again while held raises nothing.
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
      isWithdrawn: false,
    };
    // Held from the first moment, so a withdrawal that arrives while the ask is read finds it.
    this.#heldByKey.set(key, held);
    let approvalRequestId: ApprovalRequestId;
    try {
      const ownAnswer = await this.#answerOwnAsk(ask);
      if (ownAnswer !== undefined || held.isWithdrawn) {
        this.#heldByKey.delete(key);
        if (ownAnswer !== undefined && !held.isWithdrawn) {
          await this.#deps.respondToRequest({
            runId: ask.runId,
            requestId: ask.requestId,
            response: ownAnswer,
          });
        }
        return;
      }
      ({ approvalRequestId } = await this.#deps.approvals.create(
        {
          sessionId: ask.sessionId,
          runId: ask.runId,
          requestedBy: this.#deps.readRunAgent(ask.sessionId, ask.runId),
          ...describeProviderAsk(ask),
        },
        { askId, toolCallId: ask.toolCallId },
      ));
    } catch (error) {
      this.#heldByKey.delete(key);
      throw error;
    }
    if (held.isWithdrawn) {
      await this.#deps.approvals.withdraw(approvalRequestId);
    }
  }

  /**
   * Settles the card of an ask its provider took back, canceled; an answered one keeps its answer.
   */
  async withdrawAsk(withdrawal: { sessionId: SessionId; requestId: string }): Promise<void> {
    for (const [key, held] of this.#heldByKey) {
      if (held.sessionId === withdrawal.sessionId && held.requestId === withdrawal.requestId) {
        this.#heldByKey.delete(key);
        held.isWithdrawn = true;
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

  // The daemon's designed answers first, then a rule in force over the ask's subject: a block
  // whatever the ask offers, an allow only on an ask a standing allow may stand on.
  async #answerOwnAsk(ask: ProviderPermissionAsk): Promise<ProviderPermissionAnswer | undefined> {
    const designed = await answerProviderAsk(
      ask.action,
      this.#deps.agentMemoryFolder,
      this.#deps.pathRules,
    );
    if (designed !== undefined) {
      return designed.decision === "allow"
        ? { decision: "allow" }
        : { decision: "refuse", reason: designed.reason };
    }
    const subject = deriveRuleSubject(ask.action);
    const rule =
      subject === undefined
        ? undefined
        : this.#deps.rules.findRule(ask.sessionId, ask.action.kind, subject);
    if (rule?.sense === "block") {
      return { decision: "refuse", reason: BLOCKED_BY_RULE_REASON };
    }
    return rule !== undefined && mayAllowStand(ask)
      ? { decision: "allow", answeredByRule: rule }
      : undefined;
  }
}

function heldKeyOf(runId: RunId, requestId: string): string {
  return `${runId}\u0000${requestId}`;
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
