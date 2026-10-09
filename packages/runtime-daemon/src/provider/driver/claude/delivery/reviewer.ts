// The blocks Claude Code's own reviewer makes at Reviewed, captured once each, and the person's
// `Allow once` on one. A block reaches the daemon up to three ways (the `PermissionDenied` hook,
// the `permission_denied` frame and the turn result's `permission_denials`); the first report
// of a tool call is the one handed to the approval service, and a later one is dropped. The hook
// carries every classifier block with its input; the frame's words name a block the result lists.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PortRegistration } from "../../../port/registration.js";
import type { ProviderReviewerDenial, ReviewerDenialPort } from "../../../port/reviewer-denial.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { describeFailure, sanitizeFailureDetail } from "../session/errors.js";

/**
 * The action as Claude Code's `PermissionDenied` hook received it, which the approval service
 * keeps with the block so an override still works after a restart.
 */
interface ClaudeProviderDenial {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_use_id: string;
}

/** One block report off the wire, before it is captured. */
interface ClaudeBlockReport {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly reason: string;
  readonly overridable: boolean;
  readonly providerDenial: ClaudeProviderDenial;
}

/** What the capture hands blocks to and records a failed hand-off on. */
export interface ClaudeReviewerCaptureDependencies {
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/**
 * The block a `PermissionDenied` hook callback reports: the classifier's own block, with the
 * call's exact input and the classifier's reason. `undefined` for a callback that names no call.
 */
export function readClaudeHookDenial(
  input: Readonly<Record<string, unknown>>,
): Omit<ClaudeBlockReport, "sessionId" | "runId"> | undefined {
  const toolName = readNonEmptyString(input, "tool_name");
  const toolCallId = readNonEmptyString(input, "tool_use_id");
  if (toolName === undefined || toolCallId === undefined) {
    return undefined;
  }
  return {
    toolCallId,
    reason: sanitizeFailureDetail(readNonEmptyString(input, "reason") ?? ""),
    overridable: true,
    providerDenial: {
      tool_name: toolName,
      tool_input: input["tool_input"],
      tool_use_id: toolCallId,
    },
  };
}

/**
 * The blocks a turn's `result` lists in `permission_denials` that no earlier report named; none
 * carries a classifier verdict, so none is overridable. `reasonFor` gives the words Claude Code
 * sent the model for the call.
 */
export function readClaudeResultDenials(
  frame: Readonly<Record<string, unknown>>,
  reasonFor: (toolCallId: string) => string | undefined,
): Omit<ClaudeBlockReport, "sessionId" | "runId">[] {
  const denials = frame["permission_denials"];
  if (!Array.isArray(denials)) {
    return [];
  }
  return denials.flatMap((denial) => {
    if (!isPlainObject(denial)) {
      return [];
    }
    const toolName = readNonEmptyString(denial, "tool_name");
    const toolCallId = readNonEmptyString(denial, "tool_use_id");
    if (toolName === undefined || toolCallId === undefined) {
      return [];
    }
    return [
      {
        toolCallId,
        reason: sanitizeFailureDetail(reasonFor(toolCallId) ?? ""),
        overridable: false,
        providerDenial: {
          tool_name: toolName,
          tool_input: denial["tool_input"],
          tool_use_id: toolCallId,
        },
      },
    ];
  });
}

/**
 * The sentence an `Allow once` sends Claude Code, the one its own Recently denied list sends,
 * naming the action as `Tool(<command, path or input>)`. Throws on a denial the daemon never kept.
 */
export function composeClaudeOverrideSentence(providerDenial: unknown): string {
  if (!isPlainObject(providerDenial)) {
    throw new TypeError("A Claude Code denial is kept as an object.");
  }
  const toolName = readNonEmptyString(providerDenial, "tool_name");
  if (toolName === undefined) {
    throw new TypeError("A Claude Code denial names its tool.");
  }
  const input = providerDenial["tool_input"];
  const target = isPlainObject(input)
    ? (readNonEmptyString(input, "command") ??
      readNonEmptyString(input, "file_path") ??
      readNonEmptyString(input, "notebook_path") ??
      JSON.stringify(input))
    : undefined;
  const action = target === undefined ? toolName : `${toolName}(${target})`;
  return `Permission granted for: ${action}. You may now retry this command if you would like.`;
}

/** Captures each block once and hands it to the approval service. */
export class ClaudeReviewerCapture {
  readonly #dependencies: ClaudeReviewerCaptureDependencies;
  // The tool calls each session's blocks were captured for, so a second report is dropped.
  readonly #capturedBySession: Map<SessionId, Set<string>> = new Map();

  constructor(dependencies: ClaudeReviewerCaptureDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Hands a block to the approval service unless one was already captured for its call. With no
   * service registered the block is still marked captured, since nothing could answer it later.
   */
  capture(report: ClaudeBlockReport): void {
    const captured = this.#capturedBySession.get(report.sessionId) ?? new Set<string>();
    if (captured.has(report.toolCallId)) {
      return;
    }
    captured.add(report.toolCallId);
    this.#capturedBySession.set(report.sessionId, captured);
    const port = this.#dependencies.reviewerDenials.port;
    if (port === undefined) {
      return;
    }
    const denial: ProviderReviewerDenial = report;
    port.takeDenial(denial).catch((error: unknown) => {
      this.#dependencies.diagnostics.emit({
        provider: CLAUDE_DRIVER_NAME,
        kind: "delivery_dispatch_failed",
        rawWireType: null,
        dispositionReason: sanitizeFailureDetail(describeFailure(error)),
        details: {
          deliveryKind: "reviewer_denial",
          sessionId: report.sessionId,
          bindingId: null,
        },
      });
    });
  }

  /** Forgets a closed session's captured calls. */
  forgetSession(sessionId: SessionId): void {
    this.#capturedBySession.delete(sessionId);
  }
}
