// Codex's approvals and questions: each is first a permission ask the run engine attributes to its
// run's execution, then, once admitted, the approvals' or the questions card's to answer. Until
// that owner is registered the ask stays pending at Codex; nothing answers it in its place.

import type { QuestionPrompt } from "@ai-sidekicks/contracts/question";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PermissionAskPort } from "../../../port/permission-ask.js";
import type { QuestionPort } from "../../../port/question.js";
import type { PortRegistration } from "../../../port/registration.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type {
  CodexAskKind,
  CodexAskOwner,
  CodexInboundServerRequest,
  CodexServerRequestDecision,
} from "../server-requests.js";
import { normalizeProviderFailureDetail } from "../session/errors.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { CodexDeliveryDispatch } from "./dispatch.js";
import { readCodexElicitationQuestions } from "./elicitation-form.js";

/** The two owners an admitted ask goes to, each registered at runtime. */
export interface CodexAskOwners {
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  readonly questions: PortRegistration<QuestionPort>;
}

// The tool each approval method asks about, by its built-in item type.
const CODEX_APPROVAL_TOOL_BY_METHOD: ReadonlyMap<string, string> = new Map([
  ["item/commandExecution/requestApproval", "commandExecution"],
  ["execCommandApproval", "commandExecution"],
  ["item/fileChange/requestApproval", "fileChange"],
  ["applyPatchApproval", "fileChange"],
  ["item/permissions/requestApproval", "permissions"],
]);

/** The questions one `item/tool/requestUserInput` or tool-server elicitation asks, in order. */
function readCodexQuestionPrompts(method: string, params: unknown): QuestionPrompt[] {
  if (method === "mcpServer/elicitation/request") {
    return readCodexElicitationQuestions(params);
  }
  const payload = isPlainObject(params) ? params : {};
  const questions = payload["questions"];
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.flatMap((question): QuestionPrompt[] => {
    if (!isPlainObject(question)) {
      return [];
    }
    const text = readNonEmptyString(question, "question");
    if (text === undefined) {
      return [];
    }
    const header = readNonEmptyString(question, "header");
    const secret = question["isSecret"] === true;
    const options = Array.isArray(question["options"]) ? question["options"] : [];
    return [
      {
        ...(header === undefined ? {} : { header }),
        text,
        options: secret
          ? []
          : options.flatMap((option) => {
              const label = isPlainObject(option) ? readNonEmptyString(option, "label") : undefined;
              const description = isPlainObject(option)
                ? readNonEmptyString(option, "description")
                : undefined;
              return label === undefined
                ? []
                : [{ label, ...(description === undefined ? {} : { description }) }];
            }),
        severalAnswers: false,
        secret,
      },
    ];
  });
}

/** Hands Codex's approvals and questions to the run engine, then to their owner. */
export class CodexAskHandOff {
  readonly #dispatch: CodexDeliveryDispatch;
  readonly #owners: CodexAskOwners;
  readonly #reportDiagnostic: CodexDiagnosticSink;

  constructor(dependencies: {
    readonly dispatch: CodexDeliveryDispatch;
    readonly owners: CodexAskOwners;
    readonly reportDiagnostic: CodexDiagnosticSink;
  }) {
    this.#dispatch = dependencies.dispatch;
    this.#owners = dependencies.owners;
    this.#reportDiagnostic = dependencies.reportDiagnostic;
  }

  /**
   * Delivers one approval or question as a permission ask on its run's binding and, once the run
   * engine admits it, hands it to its owner and holds it for the answer. An ask on no run, or one
   * the run engine absorbed or refused, is refused at Codex.
   */
  async hold(
    sessionId: SessionId,
    owner: CodexAskOwner | null,
    request: CodexInboundServerRequest,
  ): Promise<CodexServerRequestDecision> {
    if (owner === null) {
      return {
        decision: "refuse",
        reason:
          `The provider's "${request.method}" request belongs to no run this daemon holds, so ` +
          `no one can answer it.`,
      };
    }
    const outcome = await this.#dispatch.send(
      sessionId,
      {
        kind: "permission_ask",
        bindingId: owner.bindingId,
        operation: { correlationKey: request.requestId, isOpening: true },
      },
      request.method,
    );
    if (outcome?.disposition !== "ask_admitted") {
      return {
        decision: "refuse",
        reason:
          `The provider's "${request.method}" request belongs to a run that already ended or ` +
          `was cut, so it is not asked.`,
      };
    }
    if (request.askKind === "question") {
      this.#handQuestion(sessionId, owner.runId, request);
    } else {
      this.#handApproval(sessionId, owner.runId, request);
    }
    return { decision: "held" };
  }

  /**
   * Settles the card of an ask Codex resolved itself, or whose turn ended, before anyone answered
   * it: an approval's on the approvals, a question's on the questions card.
   */
  withdraw(sessionId: SessionId, requestId: string, askKind: CodexAskKind): void {
    if (askKind === "approval") {
      this.#owners.permissionAsks.port
        ?.withdrawAsk({ sessionId, requestId })
        .catch((cause: unknown) => {
          this.#reportOwnerFailure("permission-ask", sessionId, cause);
        });
    } else if (askKind === "question") {
      this.#owners.questions.port
        ?.withdrawQuestion({ sessionId, requestId })
        .catch((cause: unknown) => {
          this.#reportOwnerFailure("question", sessionId, cause);
        });
    }
  }

  #handApproval(sessionId: SessionId, runId: RunId, request: CodexInboundServerRequest): void {
    const port = this.#owners.permissionAsks.port;
    if (port === undefined) {
      return;
    }
    const params = isPlainObject(request.params) ? request.params : {};
    const toolName =
      CODEX_APPROVAL_TOOL_BY_METHOD.get(request.method) ??
      readNonEmptyString(params, "serverName") ??
      request.method;
    const prompt = readNonEmptyString(params, "reason") ?? readNonEmptyString(params, "message");
    // The answers Codex offers, as it sent them; the card offers these and no others.
    const providerDecisions = params["availableDecisions"];
    port
      .takeAsk({
        sessionId,
        runId,
        requestId: request.requestId,
        toolName,
        input: request.params,
        ...(prompt === undefined ? {} : { prompt }),
        ...(Array.isArray(providerDecisions) ? { providerDecisions } : {}),
      })
      .catch((cause: unknown) => {
        this.#reportOwnerFailure("permission-ask", sessionId, cause);
      });
  }

  #handQuestion(sessionId: SessionId, runId: RunId, request: CodexInboundServerRequest): void {
    const port = this.#owners.questions.port;
    if (port === undefined) {
      return;
    }
    port
      .takeQuestion({
        sessionId,
        runId,
        requestId: request.requestId,
        questions: readCodexQuestionPrompts(request.method, request.params),
      })
      .catch((cause: unknown) => {
        this.#reportOwnerFailure("question", sessionId, cause);
      });
  }

  #reportOwnerFailure(
    port: "permission-ask" | "question",
    sessionId: SessionId,
    cause: unknown,
  ): void {
    reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, {
      kind: "port-delivery-failed",
      port,
      sessionId,
      detail: normalizeProviderFailureDetail(cause),
    });
  }
}
