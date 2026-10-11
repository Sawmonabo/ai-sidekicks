// Codex's approvals and questions: each is first a permission ask the run engine attributes to its
// run's execution, then, once admitted, the approvals' or the questions card's to answer. Until
// that owner is registered the ask stays pending at Codex; nothing answers it in its place.
//
// Codex's answer to an approval carries only its decision, so the rest of a person's answer is
// carried by Codex's own means: a rule as `acceptForSession`, then written into the rule file of
// each of the project's working folders where it is the project's; a decline's reason as the words
// steered into the same turn after the decline; and a command or path the person corrected as a
// decline, a steer asking the agent to use the corrected one, and an `accept` the daemon gives
// itself to the ask for exactly that one later in the same turn. The decision always goes first, so
// a rule that cannot be kept never leaves the call waiting. A command allow Codex would keep as a
// prefix that also lets a force push through is never handed over: the daemon answers each ask.

import type { QuestionPrompt } from "@ai-sidekicks/contracts/question";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { coversDestructiveGit } from "../../../../policy/destructive-git.js";
import { mintUuidV7 } from "../../../../uuid-v7.js";
import { writeIntoProjectFolders } from "../../../project-rule-folders.js";
import {
  ProviderRuleNotKeptError,
  type PermissionAskPort,
  type ProviderAskAction,
  type ProviderAskRule,
  type ProviderPermissionAnswer,
} from "../../../port/permission-ask.js";
import type { QuestionPort } from "../../../port/question.js";
import type { DiskFlush } from "../../../../disk-flush/contract.js";
import type { PortRegistration } from "../../../port/registration.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type {
  CodexAskKind,
  CodexAskOwner,
  CodexInboundServerRequest,
  CodexServerRequestAnswer,
  CodexServerRequestDecision,
} from "../server-requests.js";
import { readCodexQuestionAnswer } from "../server-requests.js";
import { normalizeProviderFailureDetail } from "../session/errors.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { RespondToRequestParams } from "../../contract.js";
import { SteerTurnEndedError } from "../../run-control.js";
import {
  removeCodexProjectRule,
  writeCodexProjectRule,
  type CodexGitFolderReader,
} from "../rules.js";
import type { CodexService } from "../service/supervisor.js";
import type { CodexSessionRecord } from "../session/state.js";
import { steerActiveTurn } from "../steer.js";
import { readCodexAskAction } from "./ask-action.js";
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

/** An approval held for its card: the turn it holds, the run it is on, and what it would do. */
interface CodexHeldApproval {
  readonly turnId: string | undefined;
  readonly runId: RunId;
  readonly action: ProviderAskAction;
}

/** What the hand-off reads, reports through and writes a project's rules with. */
export interface CodexAskHandOffDependencies {
  readonly dispatch: CodexDeliveryDispatch;
  readonly owners: CodexAskOwners;
  readonly reportDiagnostic: CodexDiagnosticSink;
  /** The session's record, whose memory names a change item's files. */
  readonly recordFor: (sessionId: SessionId) => CodexSessionRecord | undefined;
  readonly readGitFolder: CodexGitFolderReader;
  /** How a written rule file is flushed to disk. */
  readonly diskFlush: DiskFlush;
}

// The words steered into the turn after the decline that carries a corrected command or path.
function composeCorrectionSteer(action: ProviderAskAction, editedAction: string): string {
  return action.kind === "command"
    ? `The person changed this command before approving it. Run this instead: ${editedAction}`
    : `The person changed this path before approving it. Use this path instead: ${editedAction}`;
}

// What a corrected action is matched by when Codex asks for it again in the turn it was made in.
function correctionKeyOf(turnId: string, action: ProviderAskAction): string | undefined {
  if (action.kind === "command") {
    return `${turnId}\u0000command\u0000${action.command}`;
  }
  return action.kind === "file_change" && action.paths.length === 1
    ? `${turnId}\u0000file_change\u0000${action.paths[0] ?? ""}`
    : undefined;
}

/** Hands Codex's approvals and questions to the run engine, then to their owner. */
export class CodexAskHandOff {
  readonly #dispatch: CodexDeliveryDispatch;
  readonly #owners: CodexAskOwners;
  readonly #reportDiagnostic: CodexDiagnosticSink;
  readonly #recordFor: CodexAskHandOffDependencies["recordFor"];
  readonly #readGitFolder: CodexGitFolderReader;
  readonly #diskFlush: DiskFlush;
  // The approvals held for their card, by session then Codex's request id.
  readonly #heldBySession = new Map<SessionId, Map<string, CodexHeldApproval>>();
  // The corrected commands and paths approved, by session, each taken by Codex's next ask for it in
  // the same turn.
  readonly #correctionsBySession = new Map<SessionId, Set<string>>();

  constructor(dependencies: CodexAskHandOffDependencies) {
    this.#dispatch = dependencies.dispatch;
    this.#owners = dependencies.owners;
    this.#reportDiagnostic = dependencies.reportDiagnostic;
    this.#recordFor = dependencies.recordFor;
    this.#readGitFolder = dependencies.readGitFolder;
    this.#diskFlush = dependencies.diskFlush;
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
      return { decision: "held" };
    }
    return this.#handApproval(sessionId, owner.runId, request);
  }

  /**
   * Answers a held ask on `service`: a question with its answers, an approval with the approval
   * pipeline's answer carried by Codex's own means, the decision first. Throws as the answer
   * throws, and {@link ProviderRuleNotKeptError} once the call is answered but its project rule
   * could not be written; a steer whose turn has ended is reported, since its decline already
   * landed.
   */
  async answer(
    record: CodexSessionRecord | undefined,
    service: CodexService,
    params: RespondToRequestParams,
  ): Promise<void> {
    const held =
      record === undefined ? undefined : this.#takeHeld(record.sessionId, params.requestId);
    if (record === undefined || held === undefined) {
      await service.answerHeldRequest(params.requestId, readCodexQuestionAnswer(params.response));
      return;
    }
    const answer = params.response as ProviderPermissionAnswer;
    await service.answerHeldRequest(params.requestId, composeCodexAnswer(answer));
    const steer = this.#steerAfter(record.sessionId, held, answer);
    if (steer !== undefined && held.turnId !== undefined) {
      await steerActiveTurn(record, held.turnId, {
        runId: held.runId,
        content: steer,
        skills: undefined,
        attachments: Promise.resolve([]),
        clientIdempotencyKey: mintUuidV7(),
      }).catch((cause: unknown) => {
        if (!(cause instanceof SteerTurnEndedError)) {
          throw cause;
        }
        this.#reportOwnerFailure("permission-ask", record.sessionId, cause);
      });
    }
    if (answer.madeRule?.rule.kind === "project") {
      await writeIntoProjectFolders(
        answer.madeRule.projectFolders,
        answer.madeRule.rule,
        (projectFolder, rule) =>
          writeCodexProjectRule(projectFolder, rule, this.#readGitFolder, this.#diskFlush),
        (projectFolder, rule) => removeCodexProjectRule(projectFolder, rule, this.#diskFlush),
      ).catch((error: unknown) => {
        throw new ProviderRuleNotKeptError(error);
      });
    }
  }

  /** Forgets the approvals a closed session held and the corrections it waited on. */
  forgetSession(sessionId: SessionId): void {
    this.#heldBySession.delete(sessionId);
    this.#correctionsBySession.delete(sessionId);
  }

  // The words a decline is followed by: a decline's reason, or the corrected command or path, which
  // Codex's next ask for is then answered `accept` by the daemon.
  #steerAfter(
    sessionId: SessionId,
    held: CodexHeldApproval,
    answer: ProviderPermissionAnswer,
  ): string | undefined {
    if (answer.decision === "refuse") {
      return answer.reason;
    }
    if (answer.editedAction === undefined) {
      return undefined;
    }
    const corrected: ProviderAskAction =
      held.action.kind === "command"
        ? { kind: "command", command: answer.editedAction }
        : { kind: "file_change", paths: [answer.editedAction] };
    const key = held.turnId === undefined ? undefined : correctionKeyOf(held.turnId, corrected);
    if (key !== undefined) {
      const corrections = this.#correctionsBySession.get(sessionId) ?? new Set<string>();
      corrections.add(key);
      this.#correctionsBySession.set(sessionId, corrections);
    }
    return composeCorrectionSteer(held.action, answer.editedAction);
  }

  #takeHeld(sessionId: SessionId, requestId: string): CodexHeldApproval | undefined {
    const held = this.#heldBySession.get(sessionId);
    const approval = held?.get(requestId);
    held?.delete(requestId);
    return approval;
  }

  /**
   * Settles the card of an ask Codex resolved itself, or whose turn ended, before anyone answered
   * it: an approval's on the approvals, a question's on the questions card.
   */
  withdraw(sessionId: SessionId, requestId: string, askKind: CodexAskKind): void {
    if (askKind === "approval") {
      this.#takeHeld(sessionId, requestId);
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

  // An approval for a command or path a person corrected and approved is answered `accept` at once;
  // every other is held for its card.
  #handApproval(
    sessionId: SessionId,
    runId: RunId,
    request: CodexInboundServerRequest,
  ): CodexServerRequestDecision {
    const params = isPlainObject(request.params) ? request.params : {};
    const itemId = readNonEmptyString(params, "itemId");
    const changedPaths =
      itemId === undefined
        ? undefined
        : this.#recordFor(sessionId)?.delivery.changedPathsByItemId.get(itemId);
    const { action, ruleScopes } = readCodexAskAction(request.method, params, changedPaths);
    const turnId = readNonEmptyString(params, "turnId");
    const correctionKey = turnId === undefined ? undefined : correctionKeyOf(turnId, action);
    const corrections = this.#correctionsBySession.get(sessionId);
    if (correctionKey !== undefined && corrections?.delete(correctionKey) === true) {
      return { decision: "allow" };
    }
    const port = this.#owners.permissionAsks.port;
    if (port === undefined) {
      return { decision: "held" };
    }
    const held = this.#heldBySession.get(sessionId) ?? new Map<string, CodexHeldApproval>();
    held.set(request.requestId, { turnId, runId, action });
    this.#heldBySession.set(sessionId, held);
    const toolName =
      CODEX_APPROVAL_TOOL_BY_METHOD.get(request.method) ??
      readNonEmptyString(params, "serverName") ??
      request.method;
    const prompt = readNonEmptyString(params, "reason") ?? readNonEmptyString(params, "message");
    port
      .takeAsk({
        sessionId,
        runId,
        requestId: request.requestId,
        toolName,
        input: request.params,
        action,
        ruleScopes,
        isProviderFlagged: false,
        ...(itemId === undefined ? {} : { toolCallId: itemId }),
        ...(prompt === undefined ? {} : { prompt }),
      })
      .catch((cause: unknown) => {
        this.#reportOwnerFailure("permission-ask", sessionId, cause);
      });
    return { decision: "held" };
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

// The approval pipeline's answer as Codex's own decision: an allow a rule made or answered is kept
// for the conversation, unless Codex could keep it only as a prefix that also lets a force push
// through; a corrected one is a decline that the steer after it carries, and a refusal is a
// decline.
function composeCodexAnswer(answer: ProviderPermissionAnswer): CodexServerRequestAnswer {
  if (answer.decision === "refuse" || answer.editedAction !== undefined) {
    return {
      decision: "refuse",
      reason: answer.decision === "refuse" ? (answer.reason ?? "") : "",
    };
  }
  const rule: ProviderAskRule | undefined = answer.madeRule?.rule ?? answer.answeredByRule;
  return { decision: "allow", forSession: rule !== undefined && !coversDestructiveGit(rule) };
}
