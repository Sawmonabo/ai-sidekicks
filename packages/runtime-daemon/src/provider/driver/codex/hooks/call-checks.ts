// The daemon's own checks on a tool call at Codex's pre-tool hook, before any pause holds it:
//
//   * `claude agents`, `claude daemon` and `claude --bg` are refused at every level, the levels
//     where Codex never asks included, read through `sh -c` and `eval` as the asks are.
//   * A command, a file change or a tool server's call on a subject whose rule the session made
//     and the person revoked is held for a card, since Codex keeps an allow for the conversation
//     and has no verb to drop it; a change is held when any file it touches is such a subject. The
//     card is the approval pipeline's own, raised as any ask is; its answer lets the call run or
//     refuses it.

import path from "node:path";

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { refuseBackgroundClaude } from "../../../../policy/provider-ask-answers.js";
import { unwrapShellCommandLine } from "../../../../policy/shell-commands.js";
import { mintUuidV7 } from "../../../../uuid-v7.js";
import type {
  PermissionAskPort,
  ProviderAskAction,
  ProviderPermissionAnswer,
} from "../../../port/permission-ask.js";
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
export interface CodexCallChecksDependencies {
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  readonly sessionRules: PortRegistration<SessionRulePort>;
  /** The run a call in `threadId`'s turn `turnId` belongs to, or `undefined` when none is known. */
  readonly findCallRun: (
    threadId: string,
    turnId: string | undefined,
  ) => CodexHookCallRun | undefined;
}

// The tools Codex names a shell command and a file change by at its hooks, and the prefix of a tool
// server's tool.
const CODEX_HOOK_SHELL_TOOL = "Bash";
const CODEX_HOOK_PATCH_TOOL = "apply_patch";
const CODEX_HOOK_TOOL_SERVER_PREFIX = "mcp__";

// The lines of a patch that name a file it adds, changes, deletes or moves to.
const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/u;

// The prefix of the request id a held call's card is raised under, which no Codex request id has.
const HOOK_REQUEST_ID_PREFIX = "hook:";

// What the agent reads when its held call is declined with no reason given.
const HELD_CALL_DECLINED_REASON = "The person declined this call.";

// What the agent reads when its session closed while its call was held.
const SESSION_CLOSED_REASON = "The session closed before anyone answered.";

// A call held for its card, by its request id.
interface HeldCall {
  readonly sessionId: SessionId;
  readonly settle: (answer: ProviderPermissionAnswer) => void;
}

/** The pre-tool hook's command checks, answered ahead of the pauses. */
export class CodexCallChecks {
  readonly #dependencies: CodexCallChecksDependencies;
  readonly #heldByRequestId = new Map<string, HeldCall>();

  constructor(dependencies: CodexCallChecksDependencies) {
    this.#dependencies = dependencies;
  }

  /** The dispatch point's answerer: a refused background command, or a held call's answer. */
  readonly answer: CodexHookAnswerer = (input, signal) => {
    if (input.eventName !== "PreToolUse") {
      return undefined;
    }
    const action = readHookAction(input);
    if (action === undefined) {
      return undefined;
    }
    const refusal = action.kind === "command" ? refuseBackgroundClaude(action.command) : undefined;
    if (refusal !== undefined) {
      return { decision: "deny", reason: refusal };
    }
    return this.#holdRevokedSubject(input, action, signal);
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
    action: ProviderAskAction,
    signal: AbortSignal,
  ): Promise<CodexHookAnswer> | undefined {
    const intake = this.#dependencies.permissionAsks.port;
    const rules = this.#dependencies.sessionRules.port;
    const run = this.#dependencies.findCallRun(input.threadId, input.turnId);
    if (
      intake === undefined ||
      rules === undefined ||
      run === undefined ||
      !subjectActionsOf(action).some(
        (subjectAction) => rules.findRevokedRule(run.sessionId, subjectAction) !== undefined,
      )
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
          toolName: input.toolName ?? CODEX_HOOK_SHELL_TOOL,
          input: input.toolInput,
          action,
          // Its answer reaches the hook alone, so a rule on it is the session's, which the daemon
          // keeps; no project file is written from it.
          ruleScopes: ["session"],
          isProviderFlagged: false,
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

// What a hooked call would do: a command as the line its shell runs, a patch's files resolved
// against the call's folder, or a tool server's tool by its hook name; any other tool is not held.
function readHookAction(input: CodexHookInput): ProviderAskAction | undefined {
  const command = isPlainObject(input.toolInput)
    ? readNonEmptyString(input.toolInput, "command")
    : undefined;
  if (input.toolName === CODEX_HOOK_SHELL_TOOL) {
    return command === undefined
      ? undefined
      : { kind: "command", command: unwrapShellCommandLine(command) };
  }
  if (input.toolName === CODEX_HOOK_PATCH_TOOL) {
    const paths = (command ?? "").split("\n").flatMap((line) => {
      const named = PATCH_FILE_LINE.exec(line.trim())?.[1];
      return named === undefined ? [] : [path.resolve(input.cwd ?? "/", named)];
    });
    return paths.length === 0 ? undefined : { kind: "file_change", paths };
  }
  return input.toolName?.startsWith(CODEX_HOOK_TOOL_SERVER_PREFIX) === true
    ? { kind: "tool", toolName: input.toolName }
    : undefined;
}

// The actions a revoked rule is looked up by: each file of a change on its own, since a rule names
// one file, and any other action as it is.
function subjectActionsOf(action: ProviderAskAction): readonly ProviderAskAction[] {
  return action.kind === "file_change"
    ? action.paths.map((filePath) => ({ kind: "file_change", paths: [filePath] }))
    : [action];
}
