// The question-settlement fold, driven through a real session store and read back
// through the lookup the card uses.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "@test/helpers/session-events.js";
import { SessionStore, selectPartition } from "../session/session-store.js";
import type { ConsoleSessionEvent } from "../session/entities/entities.js";
import type { DriverAskReading } from "./question-reading.js";
import {
  QUESTION_SETTLEMENT_PROJECTORS,
  findQuestionSettlement,
} from "./question-settlement-projection.js";
import { SYNTHETIC_SESSION_ID } from "./run-lifecycle-projector.test-support.js";

const FIRST_RUN_ID = "01J0000000000000000000000B";
const SECOND_RUN_ID = "01J0000000000000000000000C";

/** One `driver_ask` event at `sequence`, an input ask unless the payload says otherwise. */
function askEvent(
  kind: string,
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return eventOfKind(SYNTHETIC_SESSION_ID, kind, sequence, { kind: "input", ...payload });
}

/** A store with the fold registered, after the events are applied from sequence 1. */
function storeApplying(events: readonly ConsoleSessionEvent[]): SessionStore {
  const store = new SessionStore({
    sessionId: SYNTHETIC_SESSION_ID,
    projectors: QUESTION_SETTLEMENT_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [] });
  store.applyBatch([...events]);
  return store;
}

/** An open question on `runId`, as the card holds it. */
function openQuestion(runId: string | undefined, askId: string): DriverAskReading {
  return {
    askId,
    runId: runId as DriverAskReading["runId"],
    state: "requested",
    prompt: undefined,
    options: [],
    expiresAt: undefined,
    deliveredAnswer: undefined,
  };
}

/** What the store holds that settled the question. */
function settlementIn(store: SessionStore, question: DriverAskReading): unknown {
  return findQuestionSettlement(selectPartition(store.snapshot(), "question"), question);
}

describe("the question-settlement fold", () => {
  it("settles each question from its own terminal and leaves an open one open", () => {
    const store = storeApplying([
      askEvent("driver_ask.requested", 1, { runId: FIRST_RUN_ID, askId: "ask-01" }),
      askEvent("driver_ask.responded", 2, {
        runId: FIRST_RUN_ID,
        askId: "ask-01",
        response: "develop",
      }),
      askEvent("driver_ask.requested", 3, { runId: FIRST_RUN_ID, askId: "ask-02" }),
      askEvent("driver_ask.expired", 4, { runId: FIRST_RUN_ID, askId: "ask-03" }),
    ]);

    expect(settlementIn(store, openQuestion(FIRST_RUN_ID, "ask-01"))).toStrictEqual({
      state: "responded",
      deliveredAnswer: "develop",
    });
    expect(settlementIn(store, openQuestion(FIRST_RUN_ID, "ask-03"))).toStrictEqual({
      state: "expired",
      deliveredAnswer: undefined,
    });
    expect(settlementIn(store, openQuestion(FIRST_RUN_ID, "ask-02"))).toBeUndefined();
  });

  it("keys a terminal by its run as well as its ask id", () => {
    // Two runs blocked at once raise `ask-01` each; one run's answer must not settle the
    // other's question.
    const store = storeApplying([
      askEvent("driver_ask.responded", 1, {
        runId: SECOND_RUN_ID,
        askId: "ask-01",
        response: "develop",
      }),
    ]);

    expect(settlementIn(store, openQuestion(FIRST_RUN_ID, "ask-01"))).toBeUndefined();
    expect(settlementIn(store, openQuestion(SECOND_RUN_ID, "ask-01"))).toStrictEqual({
      state: "responded",
      deliveredAnswer: "develop",
    });
  });

  it("negative control: a terminal naming no run settles nothing", () => {
    const store = storeApplying([
      askEvent("driver_ask.responded", 1, { askId: "ask-01", response: "develop" }),
    ]);

    expect(selectPartition(store.snapshot(), "question")).toStrictEqual({});
    expect(settlementIn(store, openQuestion(undefined, "ask-01"))).toBeUndefined();
  });

  it("negative control: an open question reaches no entity", () => {
    const store = storeApplying([
      askEvent("driver_ask.requested", 1, { runId: FIRST_RUN_ID, askId: "ask-01" }),
    ]);

    expect(selectPartition(store.snapshot(), "question")).toStrictEqual({});
  });

  it("keeps the first terminal, so a late cancellation cannot overwrite an answer", () => {
    const store = storeApplying([
      askEvent("driver_ask.responded", 1, {
        runId: FIRST_RUN_ID,
        askId: "ask-01",
        response: "develop",
      }),
      askEvent("driver_ask.canceled", 2, { runId: FIRST_RUN_ID, askId: "ask-01" }),
    ]);

    expect(settlementIn(store, openQuestion(FIRST_RUN_ID, "ask-01"))).toStrictEqual({
      state: "responded",
      deliveredAnswer: "develop",
    });
  });

  it("reads a permission-kind terminal as nothing", () => {
    const store = storeApplying([
      askEvent("driver_ask.responded", 1, {
        runId: FIRST_RUN_ID,
        askId: "ask-01",
        kind: "permission",
        response: "allow",
      }),
    ]);

    expect(selectPartition(store.snapshot(), "question")).toStrictEqual({});
  });
});
