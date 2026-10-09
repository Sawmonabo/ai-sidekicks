// The run engine's inbound dispatch: where each provider delivery is attributed to its execution
// before anything is written. A lifecycle event, child run, marker, live state, unstamped row or
// permission ask from the execution before an undo's cut is absorbed there; one for a run already
// ended is absorbed by the refusal of its own write; any other row is appended, stamped with its
// source pair when it is late, a thinking update through its own append, which a full write queue
// drops. A session notice or session row belongs to no execution and is appended as it is.

import {
  EventEnvelopeVersionSchema,
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import type { PlanProposedPayload } from "@ai-sidekicks/contracts/plan";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type {
  RunRefusalChoiceRequestedPayload,
  RunRefusalChoiceResolvedPayload,
  RunUsageCreditsChoiceRequestedPayload,
  RunUsageCreditsChoiceResolvedPayload,
} from "@ai-sidekicks/contracts/run/provider-choice";
import type {
  ModerationReviewFlaggedPayload,
  RunSafetyBufferingUpdatedPayload,
  SessionNoticePayload,
  SessionSideQuestionAnsweredPayload,
} from "@ai-sidekicks/contracts/session/controls/events";
import type {
  SessionAdvisorChangedPayload,
  SessionOutputStyleChangedPayload,
} from "@ai-sidekicks/contracts/session/events";
import type { EpochPosition } from "@ai-sidekicks/contracts/transcript/turn-attribution";

import {
  SessionEventAppender,
  type SessionEventAppenderDeps,
  type SessionEventLinkage,
} from "../../events/session/appender.js";
import type { DriverDiagnosticsEmitter } from "../../provider/driver/diagnostics.js";
import type { PortRegistration } from "../../provider/port/registration.js";
import type { RunStatePublisher } from "../../provider/port/run-state-publisher.js";
import { advisorModelChangeStatement } from "../console-state.js";
import type { RunEngine, RunMarker, RunTransitionRequest } from "./engine.js";
import type { DeliveryAttribution, DeliveryOperation, ExecutionEpochs } from "./epochs.js";
import type { RunRead } from "./read.js";
import { RunAlreadyEndedError, RunInvalidTransitionError } from "./refusals.js";
import { isTerminalState } from "./transitions.js";

const INBOUND_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// The registered events whose payload declares the source-epoch stamp; a payload open to any key
// declares nothing. A thinking update is left out: it goes through its own drop-when-full append,
// which this path does not take.
type StampAdmittingEvent<Event> = Event extends { readonly payload: infer Payload }
  ? string extends keyof Payload
    ? never
    : typeof SOURCE_EPOCH_PAYLOAD_KEY extends keyof Payload
      ? Event
      : never
  : never;
type LateAppendableEvent = Exclude<
  StampAdmittingEvent<SessionEvent>,
  { readonly type: "assistant.thinking_update" }
>;

// A payload as its producer built it, without the source-epoch stamp the dispatch adds.
type UnstampedPayload<Payload> = Omit<
  Payload,
  typeof SOURCE_EPOCH_PAYLOAD_KEY | typeof SOURCE_POSITION_PAYLOAD_KEY
>;

/** An assistant's reasoning update as its producer built it, without the stamp. */
export type ThinkingUpdatePayload = UnstampedPayload<
  Extract<SessionEvent, { readonly type: "assistant.thinking_update" }>["payload"]
>;

/**
 * A provider row this dispatch appends: one of the registered events that can carry the
 * source-epoch stamp, its payload as the producer built it, without the stamp.
 */
export type LateAppendableRow = LateAppendableEvent extends infer Event
  ? Event extends LateAppendableEvent
    ? { readonly type: Event["type"]; readonly payload: UnstampedPayload<Event["payload"]> }
    : never
  : never;

/**
 * A provider row on a run that takes no stamp, because it asks the person something (a plan
 * awaiting its verdict among them), records how the provider or its driver settled a choice
 * without the person, or flags the run: from before a cut it is absorbed, otherwise appended as it
 * is. A settlement's run move is its own delivery.
 */
export type UnstampedRow =
  | { readonly type: "plan.proposed"; readonly payload: PlanProposedPayload }
  | { readonly type: "moderation.review_flagged"; readonly payload: ModerationReviewFlaggedPayload }
  | {
      readonly type: "run.refusal_choice_requested";
      readonly payload: RunRefusalChoiceRequestedPayload;
    }
  | {
      readonly type: "run.refusal_choice_resolved";
      readonly payload: RunRefusalChoiceResolvedPayload;
    }
  | {
      readonly type: "run.usage_credits_choice_requested";
      readonly payload: RunUsageCreditsChoiceRequestedPayload;
    }
  | {
      readonly type: "run.usage_credits_choice_resolved";
      readonly payload: RunUsageCreditsChoiceResolvedPayload;
    };

/**
 * A row about the session as a whole, on no binding: a side question's answer, which never enters
 * the conversation, and a change of the session's own advisor or output style.
 */
export type SessionScopedRow =
  | {
      readonly type: "session.side_question_answered";
      readonly payload: SessionSideQuestionAnsweredPayload;
    }
  | { readonly type: "session.advisor_changed"; readonly payload: SessionAdvisorChangedPayload }
  | {
      readonly type: "session.output_style_changed";
      readonly payload: SessionOutputStyleChangedPayload;
    };

/**
 * One delivery a provider driver hands the run engine, on the runtime binding it arrived on and in
 * that binding's delivery order. `operation` names the provider operation it belongs to, where it
 * has one. A `child_run` is a subagent the provider started beneath `parentRunId`; a `run_marker`
 * a marker the provider reported on a live run; a `live_run_state` a state the run's stream shows
 * live and nothing stores; a `thinking_update` an assistant's reasoning, which a full write queue
 * drops; a `session_notice` a notice about the session and a `session_event` a row about it, both
 * on no binding.
 */
export type InboundDelivery =
  | { readonly kind: "turn_boundary"; readonly bindingId: string }
  | {
      readonly kind: "run_lifecycle";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
      readonly change: RunTransitionRequest;
    }
  | {
      readonly kind: "child_run";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
      readonly parentRunId: RunId;
    }
  | {
      readonly kind: "run_marker";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
      readonly marker: RunMarker;
    }
  | {
      readonly kind: "live_run_state";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
      readonly state: RunSafetyBufferingUpdatedPayload;
    }
  | {
      readonly kind: "thinking_update";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
      readonly payload: ThinkingUpdatePayload;
      /** The reasoning text, stored beside the payload. */
      readonly content: NonNullable<SessionEventLinkage["content"]>;
    }
  | { readonly kind: "session_notice"; readonly notice: SessionNoticePayload }
  | { readonly kind: "session_event"; readonly row: SessionScopedRow }
  | {
      readonly kind: "permission_ask";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
    }
  | {
      readonly kind: "session_row";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
      readonly row: LateAppendableRow;
      /** The prose of a body-bearing row, stored beside its payload. */
      readonly content?: SessionEventLinkage["content"];
    }
  | {
      readonly kind: "unstamped_row";
      readonly bindingId: string;
      readonly operation?: DeliveryOperation | undefined;
      readonly row: UnstampedRow;
    };

/** Why a delivery was absorbed: it came from before an undo's cut, or its run had already ended. */
export type LateEventAbsorbReason = "before_cut" | "run_ended";

/**
 * What the dispatch did with a delivery. `ask_admitted` is a permission ask of the current
 * execution, which the caller hands to the approval pipeline. `child_run_started` carries the
 * child's new run id, which the caller keeps for the subagent's later deliveries. A live state is
 * `published`, or `dropped` with no publisher registered; a thinking update is `dropped` when the
 * full write queue dropped it. An appended row carries the id of the event written for it.
 */
export type InboundOutcome =
  | { readonly disposition: "turn_opened" }
  | { readonly disposition: "transitioned"; readonly run: RunRead }
  | { readonly disposition: "child_run_started"; readonly runId: RunId }
  | { readonly disposition: "published" }
  | { readonly disposition: "dropped" }
  | { readonly disposition: "ask_admitted" }
  | { readonly disposition: "appended"; readonly eventId: string }
  | {
      readonly disposition: "appended_stamped";
      readonly eventId: string;
      readonly source: EpochPosition;
    }
  | { readonly disposition: "absorbed"; readonly reason: LateEventAbsorbReason };

/** The id of the event a delivery was written as; `undefined` where nothing was written. */
export function eventIdOf(outcome: InboundOutcome | undefined): string | undefined {
  return outcome?.disposition === "appended" || outcome?.disposition === "appended_stamped"
    ? outcome.eventId
    : undefined;
}

type InboundEngine = Pick<
  RunEngine,
  "applyProviderStateChange" | "startProviderSubagentRun" | "appendRunMarker"
>;

/** What the dispatch reads and writes through, and the publisher it sends live states to. */
export interface RunInboundDispatchDeps extends SessionEventAppenderDeps {
  readonly engine: InboundEngine;
  readonly epochs: ExecutionEpochs;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly runStatePublisher: PortRegistration<RunStatePublisher>;
}

// A delivery the dispatch may absorb: every one on a binding but a row stamped instead.
type AbsorbableDelivery = Exclude<
  InboundDelivery,
  { kind: "session_row" | "thinking_update" | "session_notice" | "session_event" }
>;

const ABSORB_REASON_SENTENCES: Readonly<Record<LateEventAbsorbReason, string>> = {
  before_cut:
    "the delivery belongs to the execution before an undo's cut, so it is absorbed at the epoch " +
    "check and nothing is written",
  run_ended:
    "the delivery's run had already ended, so its write was refused and nothing is written",
};

/** Takes each provider delivery in, attributes it, and writes, routes or absorbs it. */
export class RunInboundDispatch {
  readonly #engine: InboundEngine;
  readonly #epochs: ExecutionEpochs;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #runStatePublisher: PortRegistration<RunStatePublisher>;
  readonly #appender: SessionEventAppender;

  constructor(deps: RunInboundDispatchDeps) {
    this.#engine = deps.engine;
    this.#epochs = deps.epochs;
    this.#diagnostics = deps.diagnostics;
    this.#runStatePublisher = deps.runStatePublisher;
    this.#appender = new SessionEventAppender(deps, INBOUND_EVENT_VERSION);
  }

  /**
   * Dispatches one delivery. It is attributed when the call is made, before any write, so calls
   * for a binding are made in its delivery order. A refusal other than an ended run's is thrown.
   */
  async dispatch(delivery: InboundDelivery): Promise<InboundOutcome> {
    if (delivery.kind === "session_notice") {
      const receipt = await this.#appender.append("session.notice", delivery.notice, {});
      return { disposition: "appended", eventId: receipt.id };
    }
    if (delivery.kind === "session_event") {
      const { row } = delivery;
      // The advisor's column is what every later launch reads, so it moves in the event's write.
      const transactionalPrelude =
        row.type === "session.advisor_changed"
          ? [
              advisorModelChangeStatement(
                row.payload.sessionId,
                row.payload.advisorModel,
                row.payload.at,
              ),
            ]
          : [];
      const receipt = await this.#appender.append(row.type, row.payload, { transactionalPrelude });
      return { disposition: "appended", eventId: receipt.id };
    }
    if (delivery.kind === "turn_boundary") {
      const attribution = this.#epochs.openTurn(delivery.bindingId);
      return attribution.execution === "current"
        ? { disposition: "turn_opened" }
        : this.#absorb(delivery, "before_cut", attribution);
    }
    const attribution = this.#epochs.attribute(delivery.bindingId, delivery.operation);
    if (delivery.kind === "session_row") {
      return this.#appendRow(delivery.row, attribution, { content: delivery.content });
    }
    if (delivery.kind === "thinking_update") {
      return this.#appendThinkingUpdate(delivery.payload, attribution, delivery.content);
    }
    // An unknown execution reads as current here: absorbing a live terminal or ask would leave the
    // provider waiting on it for good.
    if (attribution.execution === "before_cut") {
      return this.#absorb(delivery, "before_cut", attribution);
    }
    switch (delivery.kind) {
      case "permission_ask":
        return { disposition: "ask_admitted" };
      case "live_run_state":
        return this.#publish(delivery.state);
      case "unstamped_row": {
        const receipt = await this.#appender.append(delivery.row.type, delivery.row.payload, {});
        return { disposition: "appended", eventId: receipt.id };
      }
      case "child_run": {
        const runId = await this.#engine.startProviderSubagentRun(delivery.parentRunId);
        return runId === undefined
          ? this.#absorb(delivery, "run_ended", attribution)
          : { disposition: "child_run_started", runId };
      }
      case "run_marker": {
        const eventId = await this.#engine.appendRunMarker(delivery.marker);
        return eventId === undefined
          ? this.#absorb(delivery, "run_ended", attribution)
          : { disposition: "appended", eventId };
      }
      case "run_lifecycle":
        try {
          const run = await this.#engine.applyProviderStateChange(delivery.change);
          return { disposition: "transitioned", run };
        } catch (error) {
          if (isEndedRunRefusal(error)) {
            return this.#absorb(delivery, "run_ended", attribution);
          }
          throw error;
        }
    }
  }

  #publish(state: RunSafetyBufferingUpdatedPayload): InboundOutcome {
    const publisher = this.#runStatePublisher.port;
    if (publisher === undefined) {
      return { disposition: "dropped" };
    }
    publisher.publish(state);
    return { disposition: "published" };
  }

  async #appendRow(
    row: LateAppendableRow,
    attribution: DeliveryAttribution,
    linkage: SessionEventLinkage,
  ): Promise<InboundOutcome> {
    if (attribution.execution === "current") {
      const receipt = await this.#appender.append(row.type, row.payload, linkage);
      return { disposition: "appended", eventId: receipt.id };
    }
    const { source } = attribution;
    const stamped = stampedPayload(row.payload, source);
    const receipt = await this.#appender.append(row.type, stamped, linkage);
    return { disposition: "appended_stamped", eventId: receipt.id, source };
  }

  async #appendThinkingUpdate(
    payload: ThinkingUpdatePayload,
    attribution: DeliveryAttribution,
    content: NonNullable<SessionEventLinkage["content"]>,
  ): Promise<InboundOutcome> {
    const source = attribution.execution === "current" ? undefined : attribution.source;
    const receipt = await this.#appender.appendThinkingUpdate(
      source === undefined ? payload : stampedPayload(payload, source),
      content,
    );
    if (!receipt.isStored) {
      return { disposition: "dropped" };
    }
    return source === undefined
      ? { disposition: "appended", eventId: receipt.id }
      : { disposition: "appended_stamped", eventId: receipt.id, source };
  }

  #absorb(
    delivery: AbsorbableDelivery,
    reason: LateEventAbsorbReason,
    attribution: DeliveryAttribution,
  ): InboundOutcome {
    const binding = this.#epochs.bindingFor(delivery.bindingId);
    this.#diagnostics.emit({
      provider: binding.driverName,
      kind: "late_event_absorbed",
      rawWireType: null,
      dispositionReason: ABSORB_REASON_SENTENCES[reason],
      details: {
        reason,
        deliveryKind: delivery.kind,
        bindingId: binding.id,
        runId: deliveredRunIdOf(delivery) ?? binding.runId,
        newState: delivery.kind === "run_lifecycle" ? delivery.change.newState : null,
        sourceEpoch: attribution.execution === "before_cut" ? attribution.source.epoch : null,
        sourcePosition: attribution.execution === "before_cut" ? attribution.source.position : null,
      },
    });
    return { disposition: "absorbed", reason };
  }
}

// A row that may be from before the cut is stamped too, since a stamp only supersedes it.
function stampedPayload<Payload extends object>(payload: Payload, source: EpochPosition) {
  return {
    ...payload,
    [SOURCE_EPOCH_PAYLOAD_KEY]: source.epoch,
    [SOURCE_POSITION_PAYLOAD_KEY]: source.position,
  };
}

// The run a delivery names, where it names one; the others are the binding's run.
function deliveredRunIdOf(delivery: AbsorbableDelivery): RunId | undefined {
  switch (delivery.kind) {
    case "run_lifecycle":
      return delivery.change.runId;
    case "child_run":
      return delivery.parentRunId;
    case "run_marker":
      return delivery.marker.payload.runId;
    case "live_run_state":
      return delivery.state.runId;
    case "unstamped_row":
      return delivery.row.payload.runId;
    case "turn_boundary":
    case "permission_ask":
      return undefined;
  }
}

// A provider's change refused because its run had ended, by the read or inside the write.
function isEndedRunRefusal(error: unknown): boolean {
  return (
    error instanceof RunAlreadyEndedError ||
    (error instanceof RunInvalidTransitionError && isTerminalState(error.fromState))
  );
}
