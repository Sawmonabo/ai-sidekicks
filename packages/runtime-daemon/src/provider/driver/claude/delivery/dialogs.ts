// The two choices Claude Code holds a run on and asks the daemon about through
// `request_user_dialog`: retry a refused turn on a fallback model or edit it, and switch off Fable
// or spend usage credits. Each is shown as its requested row and the run waits for input; the
// person's answer goes back as the dialog's answer, and a choice the driver or Claude Code settles
// without the person is recorded as two deliveries, the settlement row and the run's move.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type {
  RunRefusalChoiceRequestedPayload,
  RunUsageCreditsChoiceRequestedPayload,
} from "@ai-sidekicks/contracts/run/provider-choice";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { AnswerProviderChoiceParams, AnswerProviderChoiceResult } from "../../run-control.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { answerClaudeRequest } from "../hooks/callbacks.js";
import { CLAUDE_DIALOG_KINDS } from "../hooks/registration.js";
import type { ClaudeBoundRun } from "../run/routes.js";
import { sanitizeFailureDetail } from "../session/errors.js";
import type { LiveClaudeSession } from "../session/state.js";
import type { ClaudeOfferedModel } from "../session/transport.js";
import type { ClaudeDeliveryDispatch } from "./dispatch.js";

// The models a switch off Fable moves to, in the order Claude Code tries them.
const CLAUDE_SWITCH_MODEL_FAMILIES = ["opus", "sonnet", "haiku"] as const;

// The id prefix of the model the usage-credits choice is about.
const CLAUDE_FABLE_MODEL_PREFIX = "claude-fable-";

// The error Claude Code ends a turn with when a message settled the usage-credits choice.
const CLAUDE_CONSENT_UNANSWERED_ERROR = "consent_unanswered";

/** One choice Claude Code holds a run on, under the request id its answer goes back with. */
interface ClaudeHeldDialog {
  readonly choice: "refusal" | "usage_credits";
  readonly requestId: string;
  readonly sessionId: SessionId;
  readonly run: ClaudeBoundRun;
  /** The refused model, which a refusal's failure names. */
  readonly refusedModel: string;
  readonly sentence: string | undefined;
  readonly safetyCategory: string | undefined;
}

/**
 * Where a run whose end the daemon writes is marked, so the turn end Claude Code then sends is not
 * a second end: held until that end is confirmed or released.
 */
interface ClaudeDaemonEnds {
  markDaemonEnded(runId: RunId, confirmed: boolean): void;
  confirmDaemonEnd(runId: RunId): void;
  releaseDaemonEnd(runId: RunId): void;
}

/** What the dialogs deliver through and report a run the daemon ended to. */
export interface ClaudeProviderDialogsDependencies {
  readonly dispatch: ClaudeDeliveryDispatch;
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** The ids of the events the open turn's messages with these wire uuids were written as. */
  readonly eventIdsForMessages: (
    sessionId: SessionId,
    messageUuids: readonly string[],
  ) => Promise<string[]>;
  readonly daemonEnds: ClaudeDaemonEnds;
}

// The wire uuids a refusal names as its already-streamed messages; a malformed entry is left out.
function readMessageUuids(payload: Readonly<Record<string, unknown>>): string[] {
  const uuids = payload["retractedMessageUuids"];
  return Array.isArray(uuids)
    ? uuids.filter((uuid): uuid is string => typeof uuid === "string" && uuid !== "")
    : [];
}

function readText(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const text = readNonEmptyString(source, key);
  return text === undefined ? undefined : sanitizeFailureDetail(text);
}

// The first of Opus, Sonnet and Haiku the session's process offers, by its full id where it names
// one; `undefined` when it offers none of them.
function findSwitchModel(models: readonly ClaudeOfferedModel[]): string | undefined {
  for (const family of CLAUDE_SWITCH_MODEL_FAMILIES) {
    const offered = models.find((model) => {
      const id = (model.resolvedModel ?? model.value).toLowerCase();
      return id.includes(family) && !id.startsWith(CLAUDE_FABLE_MODEL_PREFIX);
    });
    if (offered !== undefined) {
      return offered.resolvedModel ?? offered.value;
    }
  }
  return undefined;
}

/** Every held choice of one driver's sessions, at most one per run. */
export class ClaudeProviderDialogs {
  readonly #dependencies: ClaudeProviderDialogsDependencies;
  readonly #heldByRun: Map<RunId, ClaudeHeldDialog> = new Map();

  constructor(dependencies: ClaudeProviderDialogsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Takes one `request_user_dialog` of the lead run: a declared kind is shown and the run waits for
   * input; a kind the daemon never declared is left unanswered, as Claude Code requires. A refusal
   * names the rows of the messages it retracts, which leave the flow once it is answered.
   */
  takeDialog(
    live: LiveClaudeSession,
    requestId: string,
    request: Readonly<Record<string, unknown>>,
    run: ClaudeBoundRun,
  ): void {
    const payload = isPlainObject(request["payload"]) ? request["payload"] : {};
    const sessionId = live.sessionId;
    switch (request["dialog_kind"]) {
      case CLAUDE_DIALOG_KINDS.refusal: {
        const refusedModel = readNonEmptyString(payload, "originalModel") ?? live.runningModel;
        const fallbackModel = readNonEmptyString(payload, "fallbackModel");
        const sentence = readText(payload, "guidanceText");
        const safetyCategory = readNonEmptyString(payload, "apiRefusalCategory");
        const held: ClaudeHeldDialog = {
          choice: "refusal",
          requestId,
          sessionId,
          run,
          refusedModel,
          sentence,
          safetyCategory,
        };
        if (fallbackModel === undefined) {
          // No other model to retry on leaves nothing to choose: the turn ends refused.
          this.#refuseWithoutFallback(live, held);
          return;
        }
        const retracted = this.#dependencies.eventIdsForMessages(
          sessionId,
          readMessageUuids(payload),
        );
        this.#hold(held);
        // Held before the ids are read, so an answer that comes first still finds the choice.
        void retracted.then((retractedMessageIds) => {
          const requested: RunRefusalChoiceRequestedPayload = {
            sessionId,
            runId: run.runId,
            refusedModel,
            fallbackModel,
            ...(sentence === undefined ? {} : { sentence }),
            ...(safetyCategory === undefined ? {} : { safetyCategory }),
            ...(retractedMessageIds.length === 0 ? {} : { retractedMessageIds }),
          };
          this.#sendRequested(run, { type: "run.refusal_choice_requested", payload: requested });
        });
        return;
      }
      case CLAUDE_DIALOG_KINDS.usageCredits: {
        const balanceCents = payload["balanceCents"];
        const currency = readNonEmptyString(payload, "currency");
        const fallbackModel = findSwitchModel(live.initialize.models);
        const requested: RunUsageCreditsChoiceRequestedPayload = {
          sessionId,
          runId: run.runId,
          modelName: readNonEmptyString(payload, "modelName") ?? live.runningModel,
          overagesEnabled: payload["overagesEnabled"] === true,
          ...(typeof balanceCents === "number" && Number.isInteger(balanceCents)
            ? { balanceCents }
            : {}),
          ...(currency === undefined ? {} : { currency }),
          ...(fallbackModel === undefined ? {} : { fallbackModel }),
        };
        this.#hold({
          choice: "usage_credits",
          requestId,
          sessionId,
          run,
          refusedModel: live.runningModel,
          sentence: undefined,
          safetyCategory: undefined,
        });
        this.#sendRequested(run, {
          type: "run.usage_credits_choice_requested",
          payload: requested,
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Sends the person's answer to the choice the run is held on and answers `answered`; a run held
   * on no choice of that kind, because it was settled or never asked, answers `not_pending`. The
   * run engine writes the settlement and the run's move itself.
   */
  async answer(
    live: LiveClaudeSession | undefined,
    params: AnswerProviderChoiceParams,
  ): Promise<AnswerProviderChoiceResult> {
    const held = this.#heldByRun.get(params.runId);
    if (live === undefined || held?.choice !== params.answer.dialog) {
      return { status: "not_pending" };
    }
    // Taken before the write, so a second answer racing this one finds nothing held; a write
    // that fails leaves the choice held at Claude Code, so it is held here again.
    this.#heldByRun.delete(params.runId);
    try {
      await live.channel.answerInboundRequest(held.requestId, {
        behavior: "completed",
        result: params.answer.choice,
      });
    } catch (error) {
      this.#hold(held);
      throw error;
    }
    if (params.answer.dialog === "refusal" && params.answer.choice === "edit_prompt") {
      // The engine ends the run refused; the abort Claude Code then sends is not a second end.
      this.#dependencies.daemonEnds.markDaemonEnded(params.runId, true);
    }
    return { status: "answered" };
  }

  /**
   * Settles the run's choice for an interrupt or an undo and answers whether the choice took the
   * interrupt in its place: a refusal is answered `cancelled` and ends refused, so no interrupt is
   * sent; a usage-credits choice is recorded `interrupted` and the turn's own interrupt still goes.
   */
  async settleForInterrupt(live: LiveClaudeSession, runId: RunId): Promise<boolean> {
    const held = this.#heldByRun.get(runId);
    if (held === undefined) {
      return false;
    }
    this.#heldByRun.delete(runId);
    if (held.choice === "refusal") {
      await this.#cancelRefusal(live, held);
      return true;
    }
    await this.#dependencies.dispatch.send(
      {
        kind: "unstamped_row",
        bindingId: held.run.bindingId,
        row: {
          type: "run.usage_credits_choice_resolved",
          payload: { sessionId: held.sessionId, runId, choice: "interrupted" },
        },
      },
      null,
    );
    return false;
  }

  /**
   * Settles the run's choice before a message the person sent goes to Claude Code: a refusal is
   * answered `cancelled` and ends refused, as Claude Code's own rule for a new message does; a
   * usage-credits choice is left for Claude Code, whose own settlement is recorded `unanswered`.
   * Answers `true` when a refusal was canceled, so the message starts the session's next turn.
   */
  async settleForQueuedMessage(live: LiveClaudeSession, runId: RunId): Promise<boolean> {
    const held = this.#heldByRun.get(runId);
    if (held === undefined) {
      return false;
    }
    if (held.choice === "usage_credits") {
      return false;
    }
    this.#heldByRun.delete(runId);
    await this.#cancelRefusal(live, held);
    return true;
  }

  /**
   * Records a choice Claude Code settled itself and withdrew with `control_cancel_request`: a
   * refusal as `cancelled`, ending refused; a usage-credits choice as `unanswered`, the run
   * running again until its turn ends. Answers whether the request was a held choice.
   */
  withdraw(sessionId: SessionId, requestId: string): boolean {
    for (const [runId, held] of this.#heldByRun) {
      if (held.sessionId === sessionId && held.requestId === requestId) {
        this.#heldByRun.delete(runId);
        this.#recordSettledByProvider(held);
        return true;
      }
    }
    return false;
  }

  /**
   * Reads an `assistant` frame of a run held on the usage-credits choice: the error Claude Code
   * ends the turn with when a message settled the choice records it `unanswered`.
   */
  observeAssistantError(runId: RunId, frame: Readonly<Record<string, unknown>>): void {
    const held = this.#heldByRun.get(runId);
    if (held?.choice !== "usage_credits") {
      return;
    }
    const error = frame["error"] ?? frame["api_error"];
    if (error === CLAUDE_CONSENT_UNANSWERED_ERROR) {
      this.#heldByRun.delete(runId);
      this.#recordSettledByProvider(held);
    }
  }

  /** Forgets every choice of a session whose process is gone; its requests went with it. */
  forgetSession(sessionId: SessionId): void {
    for (const [runId, held] of this.#heldByRun) {
      if (held.sessionId === sessionId) {
        this.#heldByRun.delete(runId);
      }
    }
  }

  #hold(held: ClaudeHeldDialog): void {
    this.#heldByRun.set(held.run.runId, held);
  }

  // The requested row, then the run's move to wait for the person, in that order.
  #sendRequested(
    run: ClaudeBoundRun,
    row:
      | { type: "run.refusal_choice_requested"; payload: RunRefusalChoiceRequestedPayload }
      | {
          type: "run.usage_credits_choice_requested";
          payload: RunUsageCreditsChoiceRequestedPayload;
        },
  ): void {
    const { dispatch } = this.#dependencies;
    void dispatch.send({ kind: "unstamped_row", bindingId: run.bindingId, row }, null);
    void dispatch.send(
      {
        kind: "run_lifecycle",
        bindingId: run.bindingId,
        change: { runId: run.runId, expectedState: "running", newState: "waiting_for_input" },
      },
      null,
    );
  }

  // A cancel that cannot be written leaves the choice held at Claude Code, so it is held here too.
  async #cancelRefusal(live: LiveClaudeSession, held: ClaudeHeldDialog): Promise<void> {
    try {
      await live.channel.answerInboundRequest(held.requestId, { behavior: "cancelled" });
    } catch (error) {
      this.#hold(held);
      throw error;
    }
    await this.#recordRefusalEnd(held, true);
  }

  // Marked first, so the abort Claude Code sends after the cancel is not a second end.
  #refuseWithoutFallback(live: LiveClaudeSession, held: ClaudeHeldDialog): void {
    this.#dependencies.daemonEnds.markDaemonEnded(held.run.runId, false);
    answerClaudeRequest(
      live,
      held.requestId,
      { behavior: "cancelled" },
      this.#dependencies.diagnostics,
    );
    void this.#recordRefusalEnd(held, false);
  }

  #recordSettledByProvider(held: ClaudeHeldDialog): void {
    if (held.choice === "refusal") {
      void this.#recordRefusalEnd(held, true);
      return;
    }
    const { dispatch } = this.#dependencies;
    const { run, sessionId } = held;
    void dispatch.send(
      {
        kind: "unstamped_row",
        bindingId: run.bindingId,
        row: {
          type: "run.usage_credits_choice_resolved",
          payload: { sessionId, runId: run.runId, choice: "unanswered" },
        },
      },
      null,
    );
    void dispatch.send(
      {
        kind: "run_lifecycle",
        bindingId: run.bindingId,
        change: { runId: run.runId, expectedState: "waiting_for_input", newState: "running" },
      },
      null,
    );
  }

  // The settlement row of a choice that was shown, then the run's end as refused by the model that
  // refused it. Claude Code's own turn end is held until that end is certain, and delivered if the
  // end could not be written, so the run always ends.
  async #recordRefusalEnd(held: ClaudeHeldDialog, wasShown: boolean): Promise<void> {
    const { dispatch, daemonEnds } = this.#dependencies;
    const { run, sessionId } = held;
    daemonEnds.markDaemonEnded(run.runId, false);
    const settled = wasShown
      ? dispatch.send(
          {
            kind: "unstamped_row",
            bindingId: run.bindingId,
            row: {
              type: "run.refusal_choice_resolved",
              payload: { sessionId, runId: run.runId, choice: "canceled" },
            },
          },
          null,
        )
      : undefined;
    const ended = dispatch.send(
      {
        kind: "run_lifecycle",
        bindingId: run.bindingId,
        change: {
          runId: run.runId,
          newState: "failed",
          failureCategory: "refused",
          failureCause: {
            cause: "refused",
            origin: "provider",
            model: held.refusedModel,
            ...(held.sentence === undefined ? {} : { sentence: held.sentence }),
            ...(held.safetyCategory === undefined ? {} : { safetyCategory: held.safetyCategory }),
          },
        },
      },
      null,
    );
    // The run engine took the end, or the run had already ended; with no outcome it failed.
    const [, outcome] = await Promise.all([settled, ended]);
    if (outcome === undefined) {
      daemonEnds.releaseDaemonEnd(run.runId);
    } else {
      daemonEnds.confirmDaemonEnd(run.runId);
    }
  }
}
