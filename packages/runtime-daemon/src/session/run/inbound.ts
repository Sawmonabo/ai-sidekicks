// The run engine's inbound dispatch: where each provider delivery is attributed to its execution
// before anything is written. A lifecycle event or permission ask from the execution before an
// undo's cut is absorbed there; a lifecycle event for a run already ended is absorbed by the refusal
// of its own write; any other row is appended, stamped with its source pair when it is late.

import {
  EventEnvelopeVersionSchema,
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import type { EpochPosition } from "@ai-sidekicks/contracts/transcript/turn-attribution";

import {
  SessionEventAppender,
  type SessionEventAppenderDeps,
  type SessionEventLinkage,
} from "../../events/session/appender.js";
import type { DriverDiagnosticsEmitter } from "../../provider/driver/diagnostics.js";
import type { RunEngine, RunTransitionRequest } from "./engine.js";
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

/**
 * A provider row this dispatch appends: one of the registered events that can carry the
 * source-epoch stamp, its payload as the producer built it, without the stamp.
 */
export type LateAppendableRow = LateAppendableEvent extends infer Event
  ? Event extends LateAppendableEvent
    ? {
        readonly type: Event["type"];
        readonly payload: Omit<
          Event["payload"],
          typeof SOURCE_EPOCH_PAYLOAD_KEY | typeof SOURCE_POSITION_PAYLOAD_KEY
        >;
      }
    : never
  : never;

/**
 * One delivery a provider driver hands the run engine, on the runtime binding it arrived on and in
 * that binding's delivery order. `operation` names the provider operation it belongs to, where it
 * has one.
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
    };

/** Why a delivery was absorbed: it came from before an undo's cut, or its run had already ended. */
export type LateEventAbsorbReason = "before_cut" | "run_ended";

/**
 * What the dispatch did with a delivery. `ask_admitted` is a permission ask of the current
 * execution, which the caller hands to the approval pipeline; nothing else is handed on.
 */
export type InboundOutcome =
  | { readonly disposition: "turn_opened" }
  | { readonly disposition: "transitioned"; readonly run: RunRead }
  | { readonly disposition: "ask_admitted" }
  | { readonly disposition: "appended" }
  | { readonly disposition: "appended_stamped"; readonly source: EpochPosition }
  | { readonly disposition: "absorbed"; readonly reason: LateEventAbsorbReason };

/** What the dispatch reads and writes through. */
export interface RunInboundDispatchDeps extends SessionEventAppenderDeps {
  readonly engine: Pick<RunEngine, "applyProviderStateChange">;
  readonly epochs: ExecutionEpochs;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

const ABSORB_REASON_SENTENCES: Readonly<Record<LateEventAbsorbReason, string>> = {
  before_cut:
    "the delivery belongs to the execution before an undo's cut, so it is absorbed at the epoch " +
    "check and nothing is written",
  run_ended:
    "the lifecycle event's run had already ended, so its write was refused and nothing is written",
};

/** Takes each provider delivery in, attributes it, and writes, routes or absorbs it. */
export class RunInboundDispatch {
  readonly #engine: Pick<RunEngine, "applyProviderStateChange">;
  readonly #epochs: ExecutionEpochs;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #appender: SessionEventAppender;

  constructor(deps: RunInboundDispatchDeps) {
    this.#engine = deps.engine;
    this.#epochs = deps.epochs;
    this.#diagnostics = deps.diagnostics;
    this.#appender = new SessionEventAppender(deps, INBOUND_EVENT_VERSION);
  }

  /**
   * Dispatches one delivery. It is attributed when the call is made, before any write, so calls
   * for a binding are made in its delivery order. A refusal other than an ended run's is thrown.
   */
  async dispatch(delivery: InboundDelivery): Promise<InboundOutcome> {
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
    // An unknown execution reads as current here: absorbing a live terminal or ask would leave the
    // provider waiting on it for good.
    if (attribution.execution === "before_cut") {
      return this.#absorb(delivery, "before_cut", attribution);
    }
    if (delivery.kind === "permission_ask") {
      return { disposition: "ask_admitted" };
    }
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

  async #appendRow(
    row: LateAppendableRow,
    attribution: DeliveryAttribution,
    linkage: SessionEventLinkage,
  ): Promise<InboundOutcome> {
    if (attribution.execution === "current") {
      await this.#appender.append(row.type, row.payload, linkage);
      return { disposition: "appended" };
    }
    // A row that may be from before the cut is stamped too, since a stamp only supersedes it.
    const { source } = attribution;
    const stamped = {
      ...row.payload,
      [SOURCE_EPOCH_PAYLOAD_KEY]: source.epoch,
      [SOURCE_POSITION_PAYLOAD_KEY]: source.position,
    };
    await this.#appender.append(row.type, stamped, linkage);
    return { disposition: "appended_stamped", source };
  }

  #absorb(
    delivery: Exclude<InboundDelivery, { kind: "session_row" }>,
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
        runId: delivery.kind === "run_lifecycle" ? delivery.change.runId : binding.runId,
        newState: delivery.kind === "run_lifecycle" ? delivery.change.newState : null,
        sourceEpoch: attribution.execution === "before_cut" ? attribution.source.epoch : null,
        sourcePosition: attribution.execution === "before_cut" ? attribution.source.position : null,
      },
    });
    return { disposition: "absorbed", reason };
  }
}

// A provider's change refused because its run had ended, by the read or inside the write.
function isEndedRunRefusal(error: unknown): boolean {
  return (
    error instanceof RunAlreadyEndedError ||
    (error instanceof RunInvalidTransitionError && isTerminalState(error.fromState))
  );
}
