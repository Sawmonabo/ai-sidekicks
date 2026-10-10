// A person's answer to a choice the provider holds a run on: Claude Code's retry-or-edit choice on
// a refused turn and its switch-or-credits choice on a Fable turn. The first answer settles the
// choice; the answer goes to the provider before anything is written, and the settlement row and
// the run's move commit in one write, guarded so a second settlement of the same request is
// refused whole.

import type { Database, Statement } from "better-sqlite3";

import type { RunControlAck } from "@ai-sidekicks/contracts/run/control";
import type { RunRefusedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type {
  RunRefusalChoiceRequestedPayload,
  RunRefusalChoiceResolveRequest,
  RunRefusalChoiceResolvedPayload,
  RunUsageCreditsChoiceResolveRequest,
  RunUsageCreditsChoiceResolvedPayload,
} from "@ai-sidekicks/contracts/run/provider-choice";
import type { RunStateChangeState } from "@ai-sidekicks/contracts/run/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";
import type { SessionEventDraft } from "../../events/session/appender.js";
import { KeyedLock } from "../../keyed-lock.js";
import type { ProviderDriver } from "../../provider/driver/contract.js";
import type { ProviderChoiceAnswer } from "../../provider/driver/run-control.js";
import type { RunEngine, RunTransitionRequest } from "./engine.js";
import type { RunRead, RunStateReader } from "./read.js";
import { RunInvalidTransitionError, RunNotFoundError } from "./refusals.js";
import { isTerminalState } from "./transitions.js";

type ChoiceDialog = ProviderChoiceAnswer["dialog"];

const REQUESTED_EVENT_TYPE = {
  refusal: "run.refusal_choice_requested",
  usage_credits: "run.usage_credits_choice_requested",
} as const satisfies Readonly<Record<ChoiceDialog, string>>;

const RESOLVED_EVENT_TYPE = {
  refusal: "run.refusal_choice_resolved",
  usage_credits: "run.usage_credits_choice_resolved",
} as const satisfies Readonly<Record<ChoiceDialog, string>>;

// The newest request of one dialog kind on a run; it reads `idx_session_events_type`.
const SELECT_LATEST_REQUEST_SQL = `SELECT sequence, payload FROM session_events
  WHERE session_id = @session_id
    AND type = @requested_type
    AND json_extract(payload, '$.runId') = @run_id
  ORDER BY sequence DESC
  LIMIT 1`;

// A settlement of the run's choice recorded after the request at `@requested_sequence`.
const SELECT_SETTLEMENT_SINCE_SQL = `SELECT 1 FROM session_events
  WHERE session_id = @session_id
    AND type = @resolved_type
    AND json_extract(payload, '$.runId') = @run_id
    AND sequence > @requested_sequence
  LIMIT 1`;

// Where the settlement guard sits in a change's write: after the run's swap, and on a terminal
// also after the guard that the version holds no terminal record yet.
const SETTLEMENT_GUARD_INDEX = { terminal: 2, live: 1 } as const;

/** Who answered a choice: the device of the connection the answer arrived on. */
export interface ProviderChoiceAnswerOrigin {
  readonly deviceId?: DeviceId | undefined;
}

/** What the choice resolver reads and writes through. */
export interface ProviderChoiceResolverDeps {
  /** The daemon's read-only connection, which holds the session's log. */
  readonly reader: Database;
  readonly runs: Pick<RunStateReader, "getRun">;
  readonly engine: Pick<RunEngine, "transition">;
}

// A choice the run still waits on: the request's place in the log and its payload as stored.
interface PendingChoice {
  readonly sequence: number;
  readonly payload: string;
}

type SettlementGuardBindings = {
  readonly session_id: SessionId;
  readonly resolved_type: string;
  readonly run_id: RunId;
  readonly requested_sequence: number;
};

/**
 * Answers the choices a provider holds runs on. Answers on one run take turns, so of two answers
 * to one choice the second meets a settled one and is refused with `run.invalid_transition`.
 */
export class ProviderChoiceResolver {
  readonly #runs: Pick<RunStateReader, "getRun">;
  readonly #engine: Pick<RunEngine, "transition">;
  readonly #selectLatestRequest: Statement<
    [{ session_id: SessionId; requested_type: string; run_id: RunId }],
    PendingChoice
  >;
  readonly #selectSettlementSince: Statement<[SettlementGuardBindings], unknown>;
  readonly #runLock = new KeyedLock<RunId>(canonicalizeUuid);

  constructor(deps: ProviderChoiceResolverDeps) {
    this.#runs = deps.runs;
    this.#engine = deps.engine;
    this.#selectLatestRequest = deps.reader.prepare(SELECT_LATEST_REQUEST_SQL);
    this.#selectSettlementSince = deps.reader.prepare(SELECT_SETTLEMENT_SINCE_SQL);
  }

  /**
   * Answers the retry-or-edit choice the run waits on and settles it: `retry_fallback` returns the
   * run to `running`, `edit_prompt` ends it `failed` as refused, with the refusal the provider
   * named. Throws {@link RunInvalidTransitionError} with nothing sent or written when the run
   * waits on no such choice, because it was settled or never asked.
   */
  async resolveRefusalChoice(
    request: RunRefusalChoiceResolveRequest,
    origin: ProviderChoiceAnswerOrigin,
    driver: Pick<ProviderDriver, "answerProviderChoice">,
  ): Promise<RunControlAck> {
    return this.#runLock.run(request.runId, async () => {
      const { runId, choice } = request;
      const newState = choice === "retry_fallback" ? "running" : "failed";
      const { run, pending } = this.#readPendingChoice(runId, "refusal", newState);
      await this.#answer(driver, runId, run, { dialog: "refusal", choice }, newState);
      const resolved: RunRefusalChoiceResolvedPayload = {
        sessionId: run.sessionId,
        runId,
        choice,
        ...deviceOf(origin),
      };
      const change: RunTransitionRequest =
        choice === "retry_fallback"
          ? { runId, expectedState: "waiting_for_input", newState: "running" }
          : {
              runId,
              expectedState: "waiting_for_input",
              newState: "failed",
              failureCategory: "refused",
              failureCause: refusedCauseOf(
                JSON.parse(pending.payload) as RunRefusalChoiceRequestedPayload,
              ),
            };
      return this.#settle(change, run.sessionId, "refusal", pending, resolved);
    });
  }

  /**
   * Answers the switch-or-credits choice the run waits on and settles it; either answer returns
   * the run to `running`. Throws {@link RunInvalidTransitionError} with nothing sent or written
   * when the run waits on no such choice.
   */
  async resolveUsageCreditsChoice(
    request: RunUsageCreditsChoiceResolveRequest,
    origin: ProviderChoiceAnswerOrigin,
    driver: Pick<ProviderDriver, "answerProviderChoice">,
  ): Promise<RunControlAck> {
    return this.#runLock.run(request.runId, async () => {
      const { runId, choice } = request;
      const { run, pending } = this.#readPendingChoice(runId, "usage_credits", "running");
      await this.#answer(driver, runId, run, { dialog: "usage_credits", choice }, "running");
      const resolved: RunUsageCreditsChoiceResolvedPayload = {
        sessionId: run.sessionId,
        runId,
        choice,
        ...deviceOf(origin),
      };
      return this.#settle(
        { runId, expectedState: "waiting_for_input", newState: "running" },
        run.sessionId,
        "usage_credits",
        pending,
        resolved,
      );
    });
  }

  // The run and the request it waits on, or the refusal of an answer that settles nothing.
  #readPendingChoice(
    runId: RunId,
    dialog: ChoiceDialog,
    newState: RunStateChangeState,
  ): { readonly run: RunRead; readonly pending: PendingChoice } {
    const run = this.#runs.getRun(runId);
    if (run === undefined) {
      throw new RunNotFoundError(runId);
    }
    const pending =
      run.state === "waiting_for_input"
        ? this.#selectLatestRequest.get({
            session_id: run.sessionId,
            requested_type: REQUESTED_EVENT_TYPE[dialog],
            run_id: runId,
          })
        : undefined;
    if (
      pending === undefined ||
      this.#selectSettlementSince.get(
        settlementGuardBindings(run.sessionId, runId, dialog, pending),
      ) !== undefined
    ) {
      throw new RunInvalidTransitionError(runId, run.state, newState);
    }
    return { run, pending };
  }

  // A provider that holds no such choice any more answers `not_pending`, refused with nothing
  // written.
  async #answer(
    driver: Pick<ProviderDriver, "answerProviderChoice">,
    runId: RunId,
    run: RunRead,
    answer: ProviderChoiceAnswer,
    newState: RunStateChangeState,
  ): Promise<void> {
    const answered = await driver.answerProviderChoice({
      sessionId: run.sessionId,
      runId,
      answer,
    });
    if (answered.status === "not_pending") {
      throw new RunInvalidTransitionError(runId, run.state, newState);
    }
  }

  // The settlement row and the run's move in one write, refused whole when the request was
  // settled since it was read.
  async #settle(
    change: RunTransitionRequest,
    sessionId: SessionId,
    dialog: ChoiceDialog,
    pending: PendingChoice,
    resolved: RunRefusalChoiceResolvedPayload | RunUsageCreditsChoiceResolvedPayload,
  ): Promise<RunControlAck> {
    const guard: WriteStatement = {
      sql: SELECT_SETTLEMENT_SINCE_SQL,
      bindings: settlementGuardBindings(sessionId, change.runId, dialog, pending),
      expectedRowCount: 0,
    };
    const settlement: SessionEventDraft = { type: RESOLVED_EVENT_TYPE[dialog], payload: resolved };
    const guardIndex = isTerminalState(change.newState)
      ? SETTLEMENT_GUARD_INDEX.terminal
      : SETTLEMENT_GUARD_INDEX.live;
    try {
      const run = await this.#engine.transition(change, {
        statements: [guard],
        precedingEvents: [settlement],
      });
      return { runId: change.runId, newState: run.state, runVersion: run.version };
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === guardIndex) {
        const now = this.#runs.getRun(change.runId);
        if (now === undefined) {
          throw new RunNotFoundError(change.runId);
        }
        throw new RunInvalidTransitionError(change.runId, now.state, change.newState, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function settlementGuardBindings(
  sessionId: SessionId,
  runId: RunId,
  dialog: ChoiceDialog,
  pending: PendingChoice,
): SettlementGuardBindings {
  return {
    session_id: sessionId,
    resolved_type: RESOLVED_EVENT_TYPE[dialog],
    run_id: runId,
    requested_sequence: pending.sequence,
  };
}

// The refusal a refused turn ends with: the model that refused it and the provider's own words.
function refusedCauseOf(requested: RunRefusalChoiceRequestedPayload): RunRefusedCause {
  return {
    cause: "refused",
    origin: "provider",
    model: requested.refusedModel,
    sentence: requested.sentence,
    safetyCategory: requested.safetyCategory,
  };
}

function deviceOf(origin: ProviderChoiceAnswerOrigin): { deviceId?: DeviceId } {
  return origin.deviceId === undefined ? {} : { deviceId: origin.deviceId };
}
