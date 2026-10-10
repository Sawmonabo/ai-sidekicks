// Codex's own reviewer at Reviewed: a `guardianWarning` waits for the next review on its thread.
// A warning about an approval or a block is dropped, a block's words being on its action's row,
// and one about a review that fell back to the person is flagged on the reviewed tool call; the
// warning Codex sends as it stops a turn whose reviews blocked too often, which no review follows,
// is flagged on that turn at its end, as a required review is, in Codex's app's words; a helper's
// are about its `subagent.started` row, since its turns write no start of their own. A review
// that blocked an action goes to the approval service.

import type { ModerationReviewSignal } from "@ai-sidekicks/contracts/session/controls/events";

import type { UnstampedRow } from "../../../../session/run/inbound.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { ReviewerDenialPort } from "../../../port/reviewer-denial.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { normalizeProviderFailureDetail } from "../session/errors.js";
import {
  reportDiagnosticFromDetachedFrame,
  type CodexDiagnosticSink,
} from "../transport/diagnostics.js";
import type { CodexDeliveryDispatch } from "./dispatch.js";
import type { CodexDeliveryMemory } from "./memory.js";
import type { CodexRowRun } from "./rows.js";

// A review's ends that blocked the action rather than letting it run.
const CODEX_BLOCKING_REVIEW_STATUSES: ReadonlySet<string> = new Set(["denied", "timedOut"]);

// A review's ends whose warning draws no row: an approval's, as in Codex's own app, and a block's,
// whose words the blocked action's own row shows.
const CODEX_UNFLAGGED_WARNING_REVIEW_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  ...CODEX_BLOCKING_REVIEW_STATUSES,
]);

// The sentence Codex's own app writes for a required review, which carries no words of its own.
const CODEX_REVIEW_REQUIRED_SENTENCE =
  "This request requires additional safety checks, some tool calls might take extra time";

/** What the reviewer's deliveries write and report through. */
export interface CodexReviewerDeliveryDependencies {
  readonly dispatch: CodexDeliveryDispatch;
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  readonly reportDiagnostic: CodexDiagnosticSink;
}

/** Turns the reviewer's frames on a session's conversation into its flags and blocks. */
export class CodexReviewerDelivery {
  readonly #dependencies: CodexReviewerDeliveryDependencies;

  constructor(dependencies: CodexReviewerDeliveryDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Pairs a review's end on `run` with the warning waiting on its thread, flagging the reviewed
   * tool call when the review neither approved nor blocked it, and hands a block to the approval
   * service. With no run, the warning is spent and nothing is written.
   */
  completeReview(
    memory: CodexDeliveryMemory,
    params: Readonly<Record<string, unknown>>,
    run: CodexRowRun | undefined,
  ): void {
    const threadId = readNonEmptyString(params, "threadId");
    const warning = threadId === undefined ? undefined : takeGuardianWarning(memory, threadId);
    if (run === undefined) {
      return;
    }
    const review = params["review"];
    const status = isPlainObject(review) ? review["status"] : undefined;
    if (
      warning !== undefined &&
      typeof status === "string" &&
      !CODEX_UNFLAGGED_WARNING_REVIEW_STATUSES.has(status)
    ) {
      const toolCallId = readNonEmptyString(params, "targetItemId");
      this.#flagOnEvent(
        run,
        toolCallId === undefined ? undefined : memory.toolRowEventIdByItemId.get(toolCallId),
        "item/autoApprovalReview/completed",
        readNonEmptyString(params, "turnId") ?? null,
        (eventId) => composeReviewFlag(run, eventId, "review_warning", warning),
      );
    }
    handOverReviewBlock(
      this.#dependencies.reviewerDenials.port,
      params,
      run,
      this.#dependencies.reportDiagnostic,
    );
  }

  /**
   * Flags the turn `turnId` on `run` as needing a stricter review, in Codex's app's words, about
   * the event `aboutEventId` that opened the turn's work.
   */
  requireReview(
    aboutEventId: Promise<string | undefined> | undefined,
    turnId: string,
    run: CodexRowRun,
  ): void {
    this.#flagOnEvent(
      run,
      aboutEventId,
      "autoApprovalReview/strictReviewRequired",
      turnId,
      (eventId) =>
        composeReviewFlag(run, eventId, "review_required", CODEX_REVIEW_REQUIRED_SENTENCE),
    );
  }

  /**
   * Spends the warning waiting on a turn's thread as the turn ends, flagging it about the event
   * `aboutEventId` that opened the turn's work when Codex itself stopped the turn on `stoppedRun`:
   * the warning its reviewer sends as it stops a turn that blocked too often, which no review
   * follows.
   */
  endTurn(
    memory: CodexDeliveryMemory,
    threadId: string,
    aboutEventId: Promise<string | undefined> | undefined,
    turnId: string | null,
    stoppedRun: CodexRowRun | undefined,
  ): void {
    const warning = takeGuardianWarning(memory, threadId);
    if (warning === undefined || stoppedRun === undefined) {
      return;
    }
    this.#flagOnEvent(stoppedRun, aboutEventId, "turn/completed", turnId, (eventId) =>
      composeReviewFlag(stoppedRun, eventId, "review_warning", warning),
    );
  }

  // A flag points at the event of what it is about, so it is written once that event is; one
  // whose event was never written gets no flag, and that is reported.
  #flagOnEvent(
    run: CodexRowRun,
    aboutEventId: Promise<string | undefined> | undefined,
    method: string,
    turnId: string | null,
    composeFlag: (eventId: string) => UnstampedRow,
  ): void {
    void (aboutEventId ?? Promise.resolve(undefined)).then((eventId) => {
      if (eventId === undefined) {
        reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
          kind: "unattributed-turn-frame",
          method,
          turnId,
        });
        return;
      }
      void this.#dependencies.dispatch.send(
        run.sessionId,
        { kind: "unstamped_row", bindingId: run.bindingId, row: composeFlag(eventId) },
        method,
      );
    });
  }
}

// The flag row a reviewer signal writes on `run`, about the event `eventId`, showing `text`.
function composeReviewFlag(
  run: CodexRowRun,
  eventId: string,
  signal: ModerationReviewSignal,
  text: string,
): UnstampedRow {
  return {
    type: "moderation.review_flagged",
    payload: {
      sessionId: run.sessionId,
      runId: run.runId,
      agentId: run.agentId,
      eventId,
      signal,
      text,
    },
  };
}

/** Holds a reviewer warning for the next review on its thread. */
export function holdGuardianWarning(memory: CodexDeliveryMemory, params: unknown): void {
  const payload = isPlainObject(params) ? params : {};
  const threadId = readNonEmptyString(payload, "threadId");
  const message = readNonEmptyString(payload, "message");
  if (threadId !== undefined && message !== undefined) {
    memory.guardianWarningByThreadId.set(threadId, message);
  }
}

// Takes the warning waiting on a thread, which no review will answer now; `undefined` if none.
function takeGuardianWarning(memory: CodexDeliveryMemory, threadId: string): string | undefined {
  const warning = memory.guardianWarningByThreadId.get(threadId);
  memory.guardianWarningByThreadId.delete(threadId);
  return warning;
}

// Hands a review's end that blocked an action to the approval service, with the review Codex sent,
// which an `Allow once` sends back. Only a denial is the person's to overrule, never a timeout. A
// failed hand-off is reported.
function handOverReviewBlock(
  port: ReviewerDenialPort | undefined,
  params: Readonly<Record<string, unknown>>,
  run: CodexRowRun,
  reportDiagnostic: CodexDiagnosticSink,
): void {
  const review = isPlainObject(params["review"]) ? params["review"] : {};
  const status = review["status"];
  const toolCallId =
    readNonEmptyString(params, "targetItemId") ?? readNonEmptyString(params, "reviewId");
  if (
    typeof status !== "string" ||
    !CODEX_BLOCKING_REVIEW_STATUSES.has(status) ||
    toolCallId === undefined ||
    port === undefined
  ) {
    return;
  }
  port
    .takeDenial({
      sessionId: run.sessionId,
      runId: run.runId,
      toolCallId,
      reason: readNonEmptyString(review, "rationale") ?? "",
      overridable: status === "denied",
      providerDenial: params,
    })
    .catch((cause: unknown) => {
      reportDiagnosticFromDetachedFrame(reportDiagnostic, {
        kind: "port-delivery-failed",
        port: "reviewer-denial",
        sessionId: run.sessionId,
        detail: normalizeProviderFailureDetail(cause),
      });
    });
}
