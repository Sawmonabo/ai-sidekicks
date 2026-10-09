// The controls on a live Claude session as a whole, each answered by the daemon on Claude Code's
// own means: Build or Plan, the commands the daemon answers itself (the output style and the
// advisor for this one session), a side question on a throwaway copy of the conversation, Claude
// Code's own review as the session's own run, and the live `/` list.

import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";
import type {
  SessionNoticePayload,
  SessionSideQuestionAnsweredPayload,
} from "@ai-sidekicks/contracts/session/controls/events";
import type {
  SessionMode,
  SessionReviewTarget,
} from "@ai-sidekicks/contracts/session/controls/methods";
import type { RunRefusedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { withCleanupFailures } from "../../../../cleanup-failures.js";
import type { RunTransitionRequest } from "../../../../session/run/engine.js";
import type { SessionScopedRow } from "../../../../session/run/inbound.js";
import { mintUuidV7 } from "../../../../uuid-v7.js";
import { isPlainObject } from "../../../record-readers.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { ProviderCommandsListener, SessionCommandAnswer } from "../../session-control.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import type { ClaudeDeliveryDispatch } from "../delivery/dispatch.js";
import type { ClaudeHandshakeRegister } from "../handshake-register.js";
import type { ClaudeBoundRun, ClaudeRunRoutes } from "../run/routes.js";
import type { ClaudeDaemonTurnOpening } from "../run/start.js";
import { resolveClaudePermissionMode } from "../spawn/arguments.js";
import { claudeAdvisorSetting } from "../spawn/settings.js";
import {
  answerClaudeAdvisor,
  answerClaudeOutputStyle,
  readClaudeAnsweredCommand,
  readClaudeAttachedAdvisor,
  type ClaudeAttachedAdvisor,
  type ClaudeCommandOutcome,
} from "./answered-commands.js";
import { ClaudeSessionUnavailableError, describeFailure, sanitizeFailureDetail } from "./errors.js";
import type { ClaudeStagedChangesSource, LiveClaudeSession } from "./state.js";
import {
  sendClaudeControlRequest,
  type ClaudeOneTurnReply,
  type ClaudeSessionTransport,
} from "./transport.js";

// The bundled skill `/review` runs, by the name the build's skill list gives it.
const CLAUDE_REVIEW_SKILL_NAME = "code-review";

// The review's target text: without one it reads the branch's commits ahead of its upstream and
// every uncommitted change; the working tree alone is named in words, which it reads as its target.
const CLAUDE_REVIEW_TARGET_TEXT: Readonly<Record<SessionReviewTarget, string>> = {
  workingTree: "the uncommitted changes in the working tree",
  branch: "",
  staged: "the uncommitted changes in the working tree",
};

/** What the session controls act through. */
export interface ClaudeSessionControlsDependencies {
  readonly transport: ClaudeSessionTransport;
  readonly handshakes: ClaudeHandshakeRegister;
  readonly dispatch: ClaudeDeliveryDispatch;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly stagedChanges: ClaudeStagedChangesSource;
  /** Where a review of the staged changes is routed while it runs, so it can be stopped. */
  readonly runRoutes: Pick<ClaudeRunRoutes, "bindApartRun" | "forgetApartRun">;
  /** Starts a turn the daemon starts on the session itself as the session's own run. */
  readonly startDaemonTurn: (
    live: LiveClaudeSession,
    opening: ClaudeDaemonTurnOpening,
  ) => Promise<void>;
  /** The session's command list as `listProviderCommands` answers it now. */
  readonly readCommands: (sessionId: SessionId) => ProviderCommandListResult | undefined;
  /** The clock an advisor or output-style change is stamped with, in milliseconds. */
  readonly now: () => number;
}

// The reason a staged review's stop carries when the daemon writes the run's end itself.
const DAEMON_WRITES_END = "daemon writes the run's end";

// How a review of the staged changes ended: refused by the model, or with its report.
type ClaudeStagedReviewEnd =
  | { readonly kind: "refused"; readonly refusal: RunRefusedCause }
  | { readonly kind: "reported"; readonly text: string; readonly providerMessageId: string };

// The full id of the model the session runs on, where its process offered one, so a one-turn
// process runs the very model the session does.
function resolvedModelOf(live: LiveClaudeSession): string {
  const offered = live.initialize.models.find((model) => model.value === live.runningModel);
  return offered?.resolvedModel ?? live.runningModel;
}

// The name Claude Code's own lines give a model: the name the `initialize` reply shows for the
// alias or full id, else the model as given.
function displayNameOf(live: LiveClaudeSession, model: string): string {
  const offered = live.initialize.models.find(
    (entry) => entry.value === model || entry.resolvedModel === model,
  );
  return offered?.displayName ?? model;
}

// The line after an applied advisor change, only once Claude Code's settings name that advisor (or
// none, for off); a change after which another advisor or none attaches, or one the build does not
// report, gets no line, so the line never names an advisor the session will not get.
function confirmedAdvisorLine(
  live: LiveClaudeSession,
  requested: string | null,
  attached: ClaudeAttachedAdvisor,
): string | null {
  if (requested === null) {
    return attached.kind === "none" ? "Advisor off." : null;
  }
  const requestedName = displayNameOf(live, requested);
  return attached.kind === "attached" && displayNameOf(live, attached.model) === requestedName
    ? `Advisor set to ${requestedName}.`
    : null;
}

// An applied change is answered with no line; a listing with its line; anything else goes as
// typed.
function answerFor(outcome: ClaudeCommandOutcome<unknown>): SessionCommandAnswer {
  switch (outcome.kind) {
    case "apply":
      return { answered: true, line: null };
    case "listing":
      return { answered: true, line: outcome.line };
  }
}

function composeReviewCommand(target: SessionReviewTarget): string {
  const targetText = CLAUDE_REVIEW_TARGET_TEXT[target];
  return targetText === ""
    ? `/${CLAUDE_REVIEW_SKILL_NAME}`
    : `/${CLAUDE_REVIEW_SKILL_NAME} ${targetText}`;
}

/** Build or Plan, style, advisor, side questions, reviews and the live command list. */
export class ClaudeSessionControls {
  readonly #dependencies: ClaudeSessionControlsDependencies;
  readonly #listenersBySession: Map<SessionId, Set<ProviderCommandsListener>> = new Map();
  // The sessions whose review runs as their own turn, finished when that turn ends.
  readonly #reviewingSessions: Set<SessionId> = new Set();

  constructor(dependencies: ClaudeSessionControlsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Moves the session between Build and Plan from its next turn: Plan is Claude Code's `plan`
   * permission mode, and Build returns the level's own mode. Throws when Claude Code refuses.
   */
  async updateSessionMode(live: LiveClaudeSession, mode: SessionMode): Promise<void> {
    await sendClaudeControlRequest(live.channel, {
      subtype: "set_permission_mode",
      mode: mode === "plan" ? "plan" : resolveClaudePermissionMode(live.executionPosture?.mode),
    });
    live.sessionMode = mode;
  }

  /**
   * Answers typed text that is a command the daemon answers itself, for this session alone:
   * `/output-style <style>` sets a style the process offered and `/advisor <model>` or `/advisor
   * off` the session's own advisor, each stored and answered with no line; typed with nothing or
   * with an argument the session cannot take, each lists what the session holds and what Claude
   * Code printed in the session's folder, and is never sent as typed. A `/config` key a console
   * control owns is answered with no line, its control pressed by the composer. Any other text is
   * not answered and goes as typed.
   * Throws when Claude Code refuses the change.
   */
  async answerSessionCommand(live: LiveClaudeSession, text: string): Promise<SessionCommandAnswer> {
    const command = readClaudeAnsweredCommand(text);
    if (command === undefined) {
      return { answered: false };
    }
    switch (command.name) {
      case "output-style": {
        const outcome = answerClaudeOutputStyle(
          command.argument,
          live.initialize.outputStyles,
          live.outputStyle ?? live.initialize.outputStyle,
          (await live.commandChoices).outputStyles,
        );
        if (outcome.kind === "apply") {
          const isConfirmed = await this.#setOutputStyle(live, outcome.value);
          return {
            answered: true,
            line: isConfirmed ? `Output style set to ${outcome.value}.` : null,
          };
        }
        return answerFor(outcome);
      }
      case "advisor": {
        const outcome = answerClaudeAdvisor(
          command.argument,
          live.advisorModel,
          live.attachedAdvisor,
          (await live.commandChoices).advisor,
          (model) => displayNameOf(live, model),
        );
        if (outcome.kind === "apply") {
          await this.#setAdvisorModel(live, outcome.value);
          return {
            answered: true,
            line: confirmedAdvisorLine(live, outcome.value, live.attachedAdvisor),
          };
        }
        return answerFor(outcome);
      }
      case "config":
        return { answered: true, line: null };
    }
  }

  /**
   * Asks a side question on a throwaway copy of the conversation, in a second process on the
   * session's full model id that keeps nothing, and resolves once it is asked; its answer is
   * appended when it arrives, and a failure is recorded.
   */
  askSideQuestion(
    live: LiveClaudeSession,
    sideQuestionId: SessionSideQuestionAnsweredPayload["sideQuestionId"],
    question: string,
  ): void {
    const { transport, dispatch } = this.#dependencies;
    const answered = transport
      .runOneTurn({
        ...live.spawnBoundLegs,
        model: resolvedModelOf(live),
        executionPosture: live.executionPosture,
        advisorModel: live.advisorModel,
        outputStyle: live.outputStyle,
        resumeHandle: live.providerSessionId,
        text: question,
      })
      .then(async (reply) => {
        // A refused question has no answer; the refusal is recorded as the failure, without the
        // model's own words, which a diagnostic does not carry.
        if (reply.refusal !== undefined) {
          throw new Error(`The side question was refused by ${reply.refusal.model}.`);
        }
        const payload: SessionSideQuestionAnsweredPayload = {
          sessionId: live.sessionId,
          sideQuestionId,
          question,
          answer: reply.text,
        };
        await dispatch.send(
          { kind: "session_event", row: { type: "session.side_question_answered", payload } },
          null,
        );
      });
    answered.catch((error: unknown) => {
      this.#recordFailure(live.sessionId, "side_question", error);
    });
  }

  /**
   * Starts Claude Code's own review of `target` with its bundled `code-review` skill as the
   * session's own run, bracketed by the `review_started` and `review_finished` notices: a turn on
   * the session's process for the working tree or the branch, and for the staged set a one-turn
   * process in a temporary worktree holding only the staged changes, whose report lands as the
   * run's reply and which an interrupt stops. Resolves once it has started; throws
   * `review_skill_absent` when the build lists no such skill, and as the run's start throws.
   */
  async startReview(live: LiveClaudeSession, target: SessionReviewTarget): Promise<void> {
    const held = this.#dependencies.handshakes.heldHandshakeFor(
      live.sessionId,
      live.providerSessionId,
    );
    if (held === undefined || !held.declaration.skills.includes(CLAUDE_REVIEW_SKILL_NAME)) {
      throw new ClaudeSessionUnavailableError("review_skill_absent", { sessionId: live.sessionId });
    }
    const { startDaemonTurn } = this.#dependencies;
    if (target === "staged") {
      const { runRoutes } = this.#dependencies;
      const stop = new AbortController();
      const bound = Promise.withResolvers<ClaudeBoundRun>();
      try {
        await startDaemonTurn(live, {
          kind: "apart",
          start: (run) => {
            // Stoppable from the moment the run has an id.
            runRoutes.bindApartRun(run.runId, (isEndWritten) => {
              stop.abort(isEndWritten ? DAEMON_WRITES_END : undefined);
            });
            bound.resolve(run);
          },
        });
      } catch (error) {
        void bound.promise.then((run) => {
          runRoutes.forgetApartRun(run.runId);
        });
        throw error;
      }
      // Reviewed only once the start notice is out, so the finish can never come first.
      await this.#sendNotice({ sessionId: live.sessionId, kind: "review_started", target });
      this.#reviewStaged(live, await bound.promise, stop.signal);
      return;
    }
    // Held before the turn starts, so a review that ends at once still finishes.
    this.#reviewingSessions.add(live.sessionId);
    try {
      await startDaemonTurn(live, {
        kind: "text",
        text: { text: composeReviewCommand(target), origin: "driver_command" },
        messageId: mintUuidV7(),
      });
    } catch (error) {
      this.#reviewingSessions.delete(live.sessionId);
      throw error;
    }
    await this.#sendNotice({ sessionId: live.sessionId, kind: "review_started", target });
  }

  /**
   * Follows a session's live command list: the listener gets the current list now and each new one
   * the session's process declares, until the returned function is called.
   */
  subscribeProviderCommands(sessionId: SessionId, listener: ProviderCommandsListener): () => void {
    const listeners = this.#listenersBySession.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listenersBySession.set(sessionId, listeners);
    const current = this.#dependencies.readCommands(sessionId);
    if (current !== undefined) {
      listener(current);
    }
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Reads one frame of a session's own thread: a new `system/init` gives the listeners the new
   * list, and the end of a review's turn finishes the review.
   */
  observeLeadFrame(
    sessionId: SessionId,
    frameKind: string,
    frame: Readonly<Record<string, unknown>>,
  ): void {
    if (frameKind === "system/init") {
      // Read only for a session someone follows, since each read checks every entry again.
      const listeners = this.#listenersBySession.get(sessionId);
      const current =
        listeners === undefined || listeners.size === 0
          ? undefined
          : this.#dependencies.readCommands(sessionId);
      if (listeners !== undefined && current !== undefined) {
        for (const listener of listeners) {
          listener(current);
        }
      }
      return;
    }
    if (frame["type"] === "result" && this.#reviewingSessions.delete(sessionId)) {
      void this.#sendNotice({ sessionId, kind: "review_finished" });
    }
  }

  /** Forgets a session whose process is gone: its listeners stay, its review ended with it. */
  forgetProcess(sessionId: SessionId): void {
    if (this.#reviewingSessions.delete(sessionId)) {
      void this.#sendNotice({ sessionId, kind: "review_finished" });
    }
  }

  /** Forgets a closed session's listeners. */
  forgetSession(sessionId: SessionId): void {
    this.forgetProcess(sessionId);
    this.#listenersBySession.delete(sessionId);
  }

  // Every later process of the session starts with the style, and the change is stored. Resolves
  // whether `get_settings` then shows the style in effect, the only ground for saying it is set.
  async #setOutputStyle(live: LiveClaudeSession, outputStyle: string): Promise<boolean> {
    await sendClaudeControlRequest(live.channel, {
      subtype: "apply_flag_settings",
      settings: { outputStyle },
    });
    live.outputStyle = outputStyle;
    const settings = await sendClaudeControlRequest(live.channel, { subtype: "get_settings" });
    const effective = settings?.["effective"];
    await this.#sendSessionEvent({
      type: "session.output_style_changed",
      payload: { sessionId: live.sessionId, outputStyle, at: this.#stampNow() },
    });
    return isPlainObject(effective) && effective["outputStyle"] === outputStyle;
  }

  // Off is sent as Claude Code's own empty advisor, never `null`, which would let the person's own
  // advisor through; every later process of the session starts with it, and the change is stored.
  async #setAdvisorModel(live: LiveClaudeSession, advisorModel: string | null): Promise<void> {
    await sendClaudeControlRequest(live.channel, {
      subtype: "apply_flag_settings",
      settings: { advisorModel: claudeAdvisorSetting(advisorModel) },
    });
    live.advisorModel = advisorModel;
    // What Claude Code will attach after the change, so no later listing names an advisor it drops.
    live.attachedAdvisor = readClaudeAttachedAdvisor(
      await sendClaudeControlRequest(live.channel, { subtype: "get_settings" }),
    );
    await this.#sendSessionEvent({
      type: "session.advisor_changed",
      payload: {
        sessionId: live.sessionId,
        advisorModel,
        ...attachedAdvisorModelOf(live.attachedAdvisor),
        at: this.#stampNow(),
      },
    });
  }

  async #sendSessionEvent(row: SessionScopedRow): Promise<void> {
    await this.#dependencies.dispatch.send({ kind: "session_event", row }, null);
  }

  #stampNow(): string {
    return new Date(this.#dependencies.now()).toISOString();
  }

  // The staged set alone, in a worktree holding only it, on the session's account and model, as
  // `run`: its report lands as the run's reply and the run ends with the turn, refused where the
  // model refused it. A stop ends it interrupted unless the daemon writes that end itself. The
  // worktree is removed and the review finished however the turn ends.
  #reviewStaged(live: LiveClaudeSession, run: ClaudeBoundRun, stopSignal: AbortSignal): void {
    const { stagedChanges, transport, runRoutes } = this.#dependencies;
    const reviewed = (async (): Promise<ClaudeStagedReviewEnd> => {
      // A review stopped before it began opens no worktree and starts no process.
      stopSignal.throwIfAborted();
      const worktree = await stagedChanges.openStagedWorktree(live.spawnBoundLegs.workingDirectory);
      let reply: ClaudeOneTurnReply;
      try {
        reply = await transport.runOneTurn({
          ...live.spawnBoundLegs,
          model: resolvedModelOf(live),
          executionPosture: live.executionPosture,
          advisorModel: live.advisorModel,
          outputStyle: live.outputStyle,
          workingDirectory: worktree.folder,
          resumeHandle: undefined,
          text: composeReviewCommand("staged"),
          signal: stopSignal,
        });
      } catch (turnFailure) {
        const cleanupFailures: unknown[] = [];
        await worktree.close().catch((closeFailure: unknown) => {
          cleanupFailures.push(closeFailure);
        });
        throw withCleanupFailures(turnFailure, cleanupFailures, "staged review");
      }
      // The review's result stands whether or not its worktree went; a leftover is recorded.
      await worktree.close().catch((closeFailure: unknown) => {
        this.#recordFailure(live.sessionId, "staged_review_cleanup", closeFailure);
      });
      if (reply.refusal !== undefined) {
        return { kind: "refused", refusal: reply.refusal };
      }
      // A review that sent no message has no report, so the run fails rather than ending empty.
      if (reply.providerMessageId === undefined) {
        throw new Error("The staged review's Claude Code process sent no report.");
      }
      return { kind: "reported", text: reply.text, providerMessageId: reply.providerMessageId };
    })();
    reviewed
      .then(
        async (end) => {
          await this.#endStagedReview(live.sessionId, run, end);
        },
        async (error: unknown) => {
          if (stopSignal.aborted) {
            if (stopSignal.reason !== DAEMON_WRITES_END) {
              await this.#sendRunChange(run, { runId: run.runId, newState: "interrupted" });
            }
            return;
          }
          this.#recordFailure(live.sessionId, "staged_review", error);
          await this.#sendRunChange(run, {
            runId: run.runId,
            newState: "failed",
            failureCategory: "provider failure",
            providerFailureDetail: sanitizeFailureDetail(describeFailure(error)),
          });
        },
      )
      .finally(() => {
        runRoutes.forgetApartRun(run.runId);
        void this.#sendNotice({ sessionId: live.sessionId, kind: "review_finished" });
      });
  }

  // A refused review ends refused; a report lands as the run's reply and the run completes.
  async #endStagedReview(
    sessionId: SessionId,
    run: ClaudeBoundRun,
    end: ClaudeStagedReviewEnd,
  ): Promise<void> {
    if (end.kind === "refused") {
      await this.#sendRunChange(run, {
        runId: run.runId,
        newState: "failed",
        failureCategory: "refused",
        failureCause: end.refusal,
      });
      return;
    }
    await this.#dependencies.dispatch.send(
      {
        kind: "session_row",
        bindingId: run.bindingId,
        row: {
          type: "assistant.message",
          payload: { sessionId, runId: run.runId, providerMessageId: end.providerMessageId },
        },
        content: { body: end.text },
      },
      null,
    );
    await this.#sendRunChange(run, {
      runId: run.runId,
      newState: "completed",
      completionKind: "turn",
    });
  }

  async #sendRunChange(run: ClaudeBoundRun, change: RunTransitionRequest): Promise<void> {
    await this.#dependencies.dispatch.send(
      { kind: "run_lifecycle", bindingId: run.bindingId, change },
      null,
    );
  }

  async #sendNotice(notice: SessionNoticePayload): Promise<void> {
    await this.#dependencies.dispatch.send({ kind: "session_notice", notice }, null);
  }

  #recordFailure(sessionId: SessionId, control: string, error: unknown): void {
    this.#dependencies.diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "process_report_failed",
      rawWireType: null,
      dispositionReason: sanitizeFailureDetail(describeFailure(error)),
      details: { sessionId, control },
    });
  }
}

// The advisor the change row names as attached, left out where the build does not report one.
function attachedAdvisorModelOf(attached: ClaudeAttachedAdvisor): {
  attachedAdvisorModel?: string | null;
} {
  switch (attached.kind) {
    case "attached":
      return { attachedAdvisorModel: attached.model };
    case "none":
      return { attachedAdvisorModel: null };
    case "unreported":
      return {};
  }
}
