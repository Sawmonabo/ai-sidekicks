// The one path every intervention takes: record it, accept it against the run, dispatch it once,
// and record its outcome. Each step is one write carrying its row change, its guards and its
// `intervention.*` event, so a crash leaves the row at the last step that committed, and every
// decision read from the run is checked again by a guarded statement inside the write it decides.
//
// The accept is the version gate: a request whose run moved before it expires undispatched, and
// once dispatched the driver's verdict is recorded whatever the run did meanwhile. A dispatch that
// throws ends the request `failed`. Steers and retries on one run take turns under a per-run lock,
// so two at one version never both reach the driver; an interrupt takes a lock of its own, so a
// stop never waits behind a steer, and a steer still queued when it lands meets the advanced
// version at its accept and expires.

import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type {
  ApplyInterventionParams,
  InterventionType,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import {
  InterventionIdSchema,
  RUN_INVALID_TRANSITION_CODE,
  type InterventionId,
  type InterventionRequestPayload,
  type InterventionRequestResponse,
  type InterventionState,
} from "@ai-sidekicks/contracts/run/control";
import {
  DAEMON_INTERVENTION_ACTOR,
  type InterventionActor,
  type InterventionEventPayload,
} from "@ai-sidekicks/contracts/run/events";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError } from "../database/writer.js";
import { SessionEventAppender, type SessionEventLog } from "../events/session/appender.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { KeyedLock } from "../keyed-lock.js";
import { boundFailureDetail, type ProviderDriver } from "../provider/driver/contract.js";
import type { StartingRunInterruptClaim } from "../session/run/engine.js";
import { advanceRunVersionStatement } from "../session/run/projection.js";
import type { RunStateReader } from "../session/run/read.js";
import { RunNotFoundError } from "../session/run/refusals.js";
import { statesThatMayEnter } from "../session/run/transitions.js";
import { mintUuidV7 } from "../uuid-v7.js";
import {
  insertRequestedInterventionStatement,
  moveInterventionStatement,
  runAtVersionStatement,
  runInStatesStatement,
  type InterventionReader,
  type InterventionTransition,
  type SavedIntervention,
} from "./store.js";

/**
 * Where a request came from: the device of the connection it arrived on, or the daemon's actor
 * for a stop the daemon makes itself.
 */
export interface InterventionOrigin {
  readonly actor: InterventionActor;
}

/** The `faster_model_retry` arm of a request, which the daemon carries out above the driver. */
export type FasterModelRetryRequest = Extract<
  InterventionRequestPayload,
  { type: "faster_model_retry" }
>;

/**
 * How a faster-model retry ended: sent again, or refused with its reason because the turn is no
 * longer the run's latest or its reply has started.
 */
export type FasterModelRetryOutcome =
  | { readonly state: "applied" }
  | { readonly state: "rejected"; readonly rejectionReason: string };

/** An applied or degraded intervention, as the run engine settles the run it acted on. */
export interface SettledInterventionOutcome {
  readonly runId: RunId;
  readonly interventionType: InterventionType;
  readonly state: "applied" | "degraded";
}

/** The run engine as the intervention service uses it. */
interface InterventionRunEngine {
  /** Ends the run `interrupted` for an applied or degraded interrupt; changes nothing otherwise. */
  settleInterventionOutcome(outcome: SettledInterventionOutcome): Promise<void>;
  /** Claims the interrupt of a run no driver has yet; see `RunEngine.claimStartingInterrupt`. */
  claimStartingInterrupt(runId: RunId): StartingRunInterruptClaim;
}

/** What the intervention service needs from the rest of the daemon. */
export interface InterventionServiceDeps {
  readonly runs: Pick<RunStateReader, "getRun">;
  readonly interventions: Pick<InterventionReader, "getByIdempotencyKey">;
  readonly sessionEvents: SessionEventLog;
  /** The driver that runs `runId`, which applies its steers and interrupts. */
  readonly resolveDriver: (runId: RunId) => Pick<ProviderDriver, "applyIntervention">;
  /** Carries out a faster-model retry; the driver's `applyIntervention` never sees one. */
  readonly retryOnFasterModel: (
    request: FasterModelRetryRequest,
  ) => Promise<FasterModelRetryOutcome>;
  readonly runEngine: InterventionRunEngine;
}

// The run states each type is accepted in: an interrupt ends any run the table lets move to
// `interrupted`, while a steer and a retry act on the turn in flight.
const RUN_STATES_ACCEPTING_INTERVENTION: Readonly<Record<InterventionType, readonly RunState[]>> = {
  steer: ["running"],
  interrupt: statesThatMayEnter("interrupted"),
  faster_model_retry: ["running"],
};

const INTERVENTION_EVENT_VERSION = EventEnvelopeVersionSchema.parse("1.0");

// The positions of the accepting write's two guards among its statements.
const ACCEPT_VERSION_GUARD_INDEX = 0;
const ACCEPT_STATE_GUARD_INDEX = 1;

// The reason a failed row records for a throw that carried no text.
const UNDESCRIBED_DISPATCH_FAILURE = "The intervention's dispatch failed without a message";

// What one intervention's writes and events name.
interface InterventionTarget {
  readonly sessionId: SessionId;
  readonly interventionId: InterventionId;
  readonly targetRunId: RunId;
  readonly type: InterventionType;
  readonly actor: InterventionActor;
}

// What dispatch produced, as the row's next move from `accepted`.
type DispatchOutcome =
  | { readonly from: "accepted"; readonly to: "applied" }
  | {
      readonly from: "accepted";
      readonly to: "degraded";
      readonly fallbackAction: string | undefined;
    }
  | { readonly from: "accepted"; readonly to: "rejected"; readonly reason: string }
  | { readonly from: "accepted"; readonly to: "expired" };

/**
 * Takes every intervention on a run, from a person's connection or from the daemon itself, to
 * one durable row, at most one dispatch and one outcome.
 */
export class InterventionService {
  readonly #deps: InterventionServiceDeps;
  readonly #appender: SessionEventAppender;
  // Orders each run's steers and retries; a run id spelled in either hex case takes one lock.
  readonly #runLock: KeyedLock<RunId> = new KeyedLock<RunId>(canonicalizeUuid);
  // Orders each run's interrupts among themselves, apart from its steers and retries.
  readonly #interruptLock: KeyedLock<RunId> = new KeyedLock<RunId>(canonicalizeUuid);

  constructor(deps: InterventionServiceDeps) {
    this.#deps = deps;
    this.#appender = new SessionEventAppender(
      { sessionEvents: deps.sessionEvents },
      INTERVENTION_EVENT_VERSION,
    );
  }

  /**
   * Records `request`, accepts it if the run is still at `expectedRunVersion` and in a state its
   * type acts on, dispatches it once and answers with the state it reached. Steers and retries on
   * one run apply one at a time in arrival order, and so do interrupts, which never wait behind a
   * steer. A reused idempotency key answers with the saved result and dispatches nothing. Throws
   * `run.not_found` for a run the daemon has no row for, and `intervention.idempotency_conflict`
   * for a reused key whose request differs; a dispatch that throws answers `failed` with what it
   * threw as the `failureReason`.
   */
  async applyIntervention(
    request: InterventionRequestPayload,
    origin: InterventionOrigin,
  ): Promise<InterventionRequestResponse> {
    const lock = request.type === "interrupt" ? this.#interruptLock : this.#runLock;
    return lock.run(request.targetRunId, () => this.#applyInTurn(request, origin));
  }

  async #applyInTurn(
    request: InterventionRequestPayload,
    origin: InterventionOrigin,
  ): Promise<InterventionRequestResponse> {
    const run = this.#deps.runs.getRun(request.targetRunId);
    if (run === undefined) {
      throw new RunNotFoundError(request.targetRunId);
    }
    const target: InterventionTarget = {
      sessionId: run.sessionId,
      interventionId: InterventionIdSchema.parse(mintUuidV7()),
      targetRunId: request.targetRunId,
      type: request.type,
      actor: origin.actor,
    };
    const payload = interventionPayloadOf(request);

    try {
      await this.#appendIntervention(target, "requested", [
        insertRequestedInterventionStatement({
          ...target,
          payload,
          expectedRunVersion: request.expectedRunVersion,
          clientIdempotencyKey: request.clientIdempotencyKey,
          deviceId: origin.actor === DAEMON_INTERVENTION_ACTOR ? null : origin.actor,
        }),
      ]);
    } catch (error) {
      if (!(error instanceof WriteRefusedError) || error.statementIndex !== 0) {
        throw error;
      }
      return this.#answerReusedKey(request, payload);
    }

    try {
      await this.#appendIntervention(target, "accepted", [
        runAtVersionStatement(target.targetRunId, request.expectedRunVersion),
        runInStatesStatement(target.targetRunId, RUN_STATES_ACCEPTING_INTERVENTION[request.type]),
        moveInterventionStatement(target.interventionId, { from: "requested", to: "accepted" }),
      ]);
    } catch (error) {
      if (!(error instanceof WriteRefusedError)) {
        throw error;
      }
      if (error.statementIndex === ACCEPT_VERSION_GUARD_INDEX) {
        return this.#resolve(target, { from: "requested", to: "expired" });
      }
      if (error.statementIndex === ACCEPT_STATE_GUARD_INDEX) {
        return this.#resolve(target, {
          from: "requested",
          to: "rejected",
          reason: RUN_INVALID_TRANSITION_CODE,
        });
      }
      throw error;
    }

    let outcome: DispatchOutcome;
    try {
      outcome = await this.#dispatch(request);
    } catch (error) {
      return this.#fail(target, error);
    }
    if (outcome.to === "rejected" || outcome.to === "expired") {
      return this.#resolve(target, outcome);
    }
    // The verdict stands whatever the run did since the accept, so the advance holds no comparand.
    await this.#appendIntervention(target, outcome.to, [
      advanceRunVersionStatement({ sessionId: target.sessionId, runId: target.targetRunId }),
      moveInterventionStatement(target.interventionId, outcome),
    ]);
    await this.#deps.runEngine.settleInterventionOutcome({
      runId: target.targetRunId,
      interventionType: target.type,
      state: outcome.to,
    });
    return this.#answer(target, outcome.to, undefined);
  }

  // Sends the request to whatever carries it out, exactly once.
  async #dispatch(request: InterventionRequestPayload): Promise<DispatchOutcome> {
    if (request.type === "faster_model_retry") {
      const retried = await this.#deps.retryOnFasterModel(request);
      return retried.state === "applied"
        ? { from: "accepted", to: "applied" }
        : { from: "accepted", to: "rejected", reason: retried.rejectionReason };
    }
    if (request.type === "interrupt") {
      const claim = this.#deps.runEngine.claimStartingInterrupt(request.targetRunId);
      // A run still in its setup gates has no provider turn to stop; the engine never starts it.
      if (claim.status === "claimed") {
        return { from: "accepted", to: "applied" };
      }
      // A stop never reaches a driver still starting the run: it waits for the start, and expires
      // undispatched when the start failed and ended the run.
      if (claim.status === "starting" && !(await claim.hasDriverRun)) {
        return { from: "accepted", to: "expired" };
      }
    }
    const result = await this.#deps
      .resolveDriver(request.targetRunId)
      .applyIntervention(driverParamsOf(request));
    return result.status === "applied"
      ? { from: "accepted", to: "applied" }
      : { from: "accepted", to: "degraded", fallbackAction: result.fallbackAction };
  }

  // Ends the intervention in an outcome that applies nothing, with its event.
  async #resolve(
    target: InterventionTarget,
    transition: Extract<InterventionTransition, { to: "expired" | "rejected" }>,
  ): Promise<InterventionRequestResponse> {
    await this.#appendIntervention(target, transition.to, [
      moveInterventionStatement(target.interventionId, transition),
    ]);
    return this.#answer(
      target,
      transition.to,
      transition.to === "rejected" ? transition.reason : undefined,
    );
  }

  // Ends the intervention `failed` with what its dispatch threw, and answers with that reason.
  async #fail(
    target: InterventionTarget,
    dispatchError: unknown,
  ): Promise<InterventionRequestResponse> {
    const reason = boundFailureDetail(failureTextOf(dispatchError), UNDESCRIBED_DISPATCH_FAILURE);
    try {
      await this.#appendIntervention(target, "failed", [
        moveInterventionStatement(target.interventionId, {
          from: "accepted",
          to: "failed",
          reason,
        }),
      ]);
    } catch (recordError) {
      throw new AggregateError(
        [dispatchError, recordError],
        `Intervention ${target.interventionId} failed in dispatch, and recording it failed too`,
        { cause: recordError },
      );
    }
    return this.#answer(target, "failed", reason);
  }

  // A reused key returns what the first request saved when the two ask for the same thing.
  #answerReusedKey(
    request: InterventionRequestPayload,
    payload: string,
  ): InterventionRequestResponse {
    const saved: SavedIntervention | undefined = this.#deps.interventions.getByIdempotencyKey(
      request.targetRunId,
      request.clientIdempotencyKey,
    );
    // The insert was refused on this key, and an intervention row is never deleted on its own.
    if (saved === undefined) {
      throw new Error(
        `The intervention saved under key ${request.clientIdempotencyKey} on run ` +
          `${request.targetRunId} refused the insert but cannot be read back`,
      );
    }
    if (saved.type !== request.type || saved.payload !== payload) {
      throw new DaemonDomainError(
        "The idempotency key was already used for a different intervention on this run",
        {
          code: "intervention.idempotency_conflict",
          detail: { targetRunId: request.targetRunId, interventionId: saved.interventionId },
        },
      );
    }
    return this.#answer(
      { interventionId: saved.interventionId, targetRunId: request.targetRunId, type: saved.type },
      saved.state,
      saved.rejectionReason ?? saved.failureReason ?? undefined,
    );
  }

  // The answer for the state reached, with the run's version as it is now; `reason` is a rejected
  // or failed row's reason.
  #answer(
    target: Pick<InterventionTarget, "interventionId" | "targetRunId" | "type">,
    state: InterventionState,
    reason: string | undefined,
  ): InterventionRequestResponse {
    const run = this.#deps.runs.getRun(target.targetRunId);
    if (run === undefined) {
      throw new RunNotFoundError(target.targetRunId);
    }
    const base = {
      interventionId: target.interventionId,
      interventionType: target.type,
      runVersion: run.version,
    };
    if (state !== "rejected" && state !== "failed") {
      return { ...base, state };
    }
    if (reason === undefined) {
      throw new Error(`Intervention ${target.interventionId} ended ${state} with no reason`);
    }
    return state === "rejected"
      ? { ...base, state, rejectionReason: reason }
      : { ...base, state, failureReason: reason };
  }

  async #appendIntervention<TState extends InterventionState>(
    target: InterventionTarget,
    state: TState,
    transactionalPrelude: readonly WriteStatement[],
  ): Promise<void> {
    const payload: InterventionEventPayload<TState> = { ...target, state };
    await this.#appender.append(`intervention.${state}`, payload, { transactionalPrelude });
  }
}

// What a dispatch throw records: a domain error's code, else its message.
function failureTextOf(error: unknown): string {
  if (error instanceof DaemonDomainError) {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

// The type's own fields, in one fixed order, so a retry under the same key compares equal as
// text exactly when it asks for the same thing.
function interventionPayloadOf(request: InterventionRequestPayload): string {
  switch (request.type) {
    case "steer":
      return JSON.stringify({
        content: request.content,
        attachments: request.attachments,
        expectedTurnId: request.expectedTurnId,
      });
    case "interrupt":
      return JSON.stringify({
        pending: request.pending,
        deliverFirst: request.deliverFirst,
        reason: request.reason,
      });
    case "faster_model_retry":
      return JSON.stringify({ expectedTurnId: request.expectedTurnId, model: request.model });
  }
}

function driverParamsOf(
  request: Exclude<InterventionRequestPayload, FasterModelRetryRequest>,
): ApplyInterventionParams {
  const guards = {
    targetRunId: request.targetRunId,
    expectedRunVersion: request.expectedRunVersion,
    clientIdempotencyKey: request.clientIdempotencyKey,
  };
  if (request.type === "steer") {
    return {
      ...guards,
      type: "steer",
      payload: {
        content: request.content,
        attachments: request.attachments,
        expectedTurnId: request.expectedTurnId,
      },
    };
  }
  return { ...guards, type: "interrupt", payload: { reason: request.reason } };
}
