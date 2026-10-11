// The daemon's own checks on a command at Codex's pre-tool hook, before any pause holds it:
//
//   * `claude agents`, `claude daemon` and `claude --bg` are refused at every level, the levels
//     where Codex never asks included, read through `sh -c` and `eval` as the asks are.
//   * A command on a subject whose rule the session made and the person revoked is held for a card,
//     since Codex keeps an allow for the conversation and has no verb to drop it. The card is the
//     approval pipeline's own, raised as any ask is; its answer lets the call run or refuses it.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { refuseBackgroundClaude } from "../../../../policy/provider-ask-answers.js";
import { mintUuidV7 } from "../../../../uuid-v7.js";
import type { PermissionAskPort, ProviderPermissionAnswer } from "../../../port/permission-ask.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { SessionRulePort } from "../../../port/session-rules.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { RespondToRequestParams } from "../../contract.js";
import {
  CODEX_HOOK_DEADLINE_REASON,
  type CodexHookAnswer,
  type CodexHookAnswerer,
  type CodexHookInput,
} from "./server.js";

/** The run a conversation's tool call belongs to. */
interface CodexHookCallRun {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/** What the checks read the rules from and raise a held call's card through. */
export interface CodexCommandChecksDependencies {
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  readonly sessionRules: PortRegistration<SessionRulePort>;
  /** The run a call in `threadId`'s turn `turnId` belongs to, or `undefined` when none is known. */
  readonly findCallRun: (
    threadId: string,
    turnId: string | undefined,
  ) => CodexHookCallRun | undefined;
}

// The tool Codex names a shell command by at its hooks.
const CODEX_HOOK_SHELL_TOOL = "Bash";

// The prefix of the request id a held call's card is raised under, which no Codex request id has.
const HOOK_REQUEST_ID_PREFIX = "hook:";

// What the agent reads when its held call is declined with no reason given.
const HELD_CALL_DECLINED_REASON = "The person declined this command.";

// What the agent reads when its session closed while its call was held.
const SESSION_CLOSED_REASON = "The session closed before anyone answered.";

// A call held for its card, by its request id.
interface HeldCall {
  readonly sessionId: SessionId;
  readonly settle: (answer: ProviderPermissionAnswer) => void;
}

/** The pre-tool hook's command checks, answered ahead of the pauses. */
export class CodexCommandChecks {
  readonly #dependencies: CodexCommandChecksDependencies;
  readonly #heldByRequestId = new Map<string, HeldCall>();

  constructor(dependencies: CodexCommandChecksDependencies) {
    this.#dependencies = dependencies;
  }

  /** The dispatch point's answerer: a refused background command, or a held call's answer. */
  readonly answer: CodexHookAnswerer = (input, signal) => {
    if (input.eventName !== "PreToolUse" || input.toolName !== CODEX_HOOK_SHELL_TOOL) {
      return undefined;
    }
    const command = isPlainObject(input.toolInput)
      ? readNonEmptyString(input.toolInput, "command")
      : undefined;
    if (command === undefined) {
      return undefined;
    }
    const refusal = refuseBackgroundClaude(command);
    if (refusal !== undefined) {
      return { decision: "deny", reason: refusal };
    }
    return this.#holdRevokedSubject(input, command, signal);
  };

  /**
   * Hands a held call its card's answer, answering whether `params` named one; a request id of
   * Codex's own names none.
   */
  settle(params: RespondToRequestParams): boolean {
    const held = this.#heldByRequestId.get(params.requestId);
    if (held === undefined) {
      return false;
    }
    this.#heldByRequestId.delete(params.requestId);
    held.settle(params.response as ProviderPermissionAnswer);
    return true;
  }

  /** Refuses the calls a closed session held, whose cards are canceled with its runs. */
  forgetSession(sessionId: SessionId): void {
    for (const [requestId, held] of this.#heldByRequestId) {
      if (held.sessionId === sessionId) {
        this.#heldByRequestId.delete(requestId);
        held.settle({ decision: "refuse", reason: SESSION_CLOSED_REASON });
      }
    }
  }

  #holdRevokedSubject(
    input: CodexHookInput,
    command: string,
    signal: AbortSignal,
  ): Promise<CodexHookAnswer> | undefined {
    const intake = this.#dependencies.permissionAsks.port;
    const rules = this.#dependencies.sessionRules.port;
    const run = this.#dependencies.findCallRun(input.threadId, input.turnId);
    const action = { kind: "command", command } as const;
    if (
      intake === undefined ||
      run === undefined ||
      rules?.findRevokedRule(run.sessionId, action) === undefined
    ) {
      return undefined;
    }
    const requestId = `${HOOK_REQUEST_ID_PREFIX}${input.toolUseId ?? mintUuidV7()}`;
    const answered = new Promise<CodexHookAnswer>((resolve, reject) => {
      this.#heldByRequestId.set(requestId, {
        sessionId: run.sessionId,
        settle: (answer) => {
          resolve(
            answer.decision === "allow"
              ? { decision: "pass" }
              : { decision: "deny", reason: answer.reason ?? HELD_CALL_DECLINED_REASON },
          );
        },
      });
      // The call stopped waiting (its deadline, or Codex ending the hook): its card is taken back.
      signal.addEventListener("abort", () => {
        if (this.#heldByRequestId.delete(requestId)) {
          resolve({ decision: "deny", reason: CODEX_HOOK_DEADLINE_REASON });
          intake.withdrawAsk({ sessionId: run.sessionId, requestId }).catch(reject);
        }
      });
      intake
        .takeAsk({
          sessionId: run.sessionId,
          runId: run.runId,
          requestId,
          toolName: CODEX_HOOK_SHELL_TOOL,
          input: input.toolInput,
          action,
          // Its answer reaches the hook alone, so a rule on it is the session's, which the daemon
          // keeps; no project file is written from it.
          ruleScopes: ["session"],
          ...(input.toolUseId === undefined ? {} : { toolCallId: input.toolUseId }),
        })
        .catch((cause: unknown) => {
          this.#heldByRequestId.delete(requestId);
          reject(cause);
        });
    });
    return answered;
  }
}
