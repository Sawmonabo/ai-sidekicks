// The ledger that outlives the window, and the three properties it exists for.
//
// Every case here is one of: the VOCABULARY it keys on is the wire's, the ROWS it takes
// may arrive in any order, and what it holds survives the window being pruned or
// replaced. The last is the defect this module was written for — a fold over the
// store's `timeline` reported "Nothing needs you" over a run that was still blocked,
// because the row that opened the approval had fallen out of a capped window or had
// never been delivered to a resumed one.
//
// The BAR's reading of this ledger is a different claim and lives with the bar, in
// `workspace/cast-bar/model/outstanding-asks.test.ts`.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { OutstandingAskJournal, type OutstandingAskLedger } from "./outstanding-ask-journal.js";
import {
  ATTENTION_RUN_STATES,
  ATTENTION_RUN_STATE_KINDS,
  REQUEST_LIFECYCLES,
  RUN_STATE_EVENT_PREFIX,
  RUN_STATE_KINDS,
} from "./outstanding-ask-vocabulary.js";
import { eventOfKind } from "../../session-event.test-support.js";
import { SessionStore } from "../session-store.js";
import type { ConsoleSessionEvent } from "../../entities/index.js";

const SESSION_ID = "session-journal";
const REGISTERED_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
);

function rowOf(
  sequence: number,
  kind: string,
  payload?: Readonly<Record<string, unknown>>,
  actorId?: string,
): ConsoleSessionEvent {
  const base = eventOfKind(SESSION_ID, kind, sequence, payload);
  return actorId === undefined ? base : { ...base, actorId };
}

/** How many lifecycles the ledger holds open — an opening with no terminal after it. */
function openCountOf(ledger: OutstandingAskLedger): number {
  let open = 0;
  for (const request of ledger.requestsByKey.values()) {
    if (request.openedAtSequence !== undefined && request.closedAtSequence === undefined) {
      open += 1;
    }
  }
  for (const run of ledger.runsByRunId.values()) {
    if (run.needsAttention) {
      open += 1;
    }
  }
  return open;
}

describe("the vocabulary this register keys on — wire truth", () => {
  it("names only event kinds the contracts package registers", () => {
    const named = [
      ...RUN_STATE_KINDS,
      ...ATTENTION_RUN_STATE_KINDS,
      ...REQUEST_LIFECYCLES.flatMap((lifecycle) => [lifecycle.openedBy, ...lifecycle.closedBy]),
    ];
    expect(named.filter((kind) => !REGISTERED_EVENT_TYPES.has(kind))).toStrictEqual([]);
  });

  it("spells every run kind as its own state under the wire's own prefix", () => {
    // The seed compares an entity's wire-verbatim `state` against
    // `ATTENTION_RUN_STATES` while the log compares an event kind against
    // `ATTENTION_RUN_STATE_KINDS`, and the two readings are the same fact only while
    // every kind is exactly its state under the prefix. That the states themselves are
    // the contract's is a COMPILE-time claim in the module — a console surface parses
    // no wire value, so a runtime check here would have to be a second reading of the
    // registered vocabulary rather than the registration itself.
    expect(RUN_STATE_KINDS).toHaveLength(9);
    expect(RUN_STATE_KINDS.every((kind) => kind.startsWith(RUN_STATE_EVENT_PREFIX))).toBe(true);
  });

  it("keeps the attention run states a subset of the run states", () => {
    expect(ATTENTION_RUN_STATE_KINDS.every((kind) => RUN_STATE_KINDS.includes(kind))).toBe(true);
    expect(ATTENTION_RUN_STATES.map((state) => `${RUN_STATE_EVENT_PREFIX}${state}`)).toStrictEqual([
      ...ATTENTION_RUN_STATE_KINDS,
    ]);
  });

  it("scopes exactly the lifecycle whose ids the daemon does not mint", () => {
    expect(
      REQUEST_LIFECYCLES.filter((lifecycle) => lifecycle.scopeMember !== undefined).map(
        (lifecycle) => [lifecycle.openedBy, lifecycle.correlationMember, lifecycle.scopeMember],
      ),
    ).toStrictEqual([["driver_ask.requested", "askId", "runId"]]);
  });

  it("negative control: the census is a real set, and a made-up kind is not in it", () => {
    expect(REGISTERED_EVENT_TYPES.size).toBeGreaterThan(100);
    expect(REGISTERED_EVENT_TYPES.has("run.started")).toBe(false);
  });
});

describe("OutstandingAskJournal — what a base state establishes", () => {
  it("seeds a blocked run off the entity the read carried", () => {
    // The one ask class a base state answers authoritatively: a run's `state` is a
    // registered `RunState`, so a run blocked below the window's head says so here
    // whatever the window's own rows hold.
    const journal = new OutstandingAskJournal();
    journal.seedFrom({
      cursor: 12,
      windowHeadCursor: "cursor-12",
      entities: [
        { kind: "run", id: "run-a", state: "waiting_for_approval", attributedTo: "agent-scout" },
      ],
    });

    expect(openCountOf(journal.ledger)).toBe(1);
    expect(journal.ledger.runsByRunId.get("run-a")?.atSequence).toBe(12);
  });

  it("reports the request classes as unread where the read opened partway through", () => {
    // Nothing on a base state carries a provider ask, an approval, or an intervention,
    // so a window that starts mid-log cannot answer for them at all — which is a third
    // state and not a zero.
    const journal = new OutstandingAskJournal();
    journal.seedFrom({ cursor: 12, windowHeadCursor: "cursor-12", entities: [] });

    expect(journal.ledger.isWindowHeadUnread).toBe(true);
  });

  it("negative control: a read from the beginning of the log reports nothing unread", () => {
    const journal = new OutstandingAskJournal();
    journal.seedFrom({ cursor: 0, windowHeadCursor: undefined, entities: [] });

    expect(journal.ledger.isWindowHeadUnread).toBe(false);
  });

  it("keeps what it already held when a later read re-establishes the window", () => {
    // A read says nothing about a request it did not carry, so a register cleared here
    // would throw away exactly the older asks this class exists to hold.
    const journal = new OutstandingAskJournal();
    journal.admit([rowOf(3, "approval.requested", { approvalRequestId: "req-1" })]);
    journal.seedFrom({ cursor: 40, windowHeadCursor: "cursor-40", entities: [] });

    expect(openCountOf(journal.ledger)).toBe(1);
  });

  it("lets a newer row supersede the seed, and refuses one at the seed's own position", () => {
    const journal = new OutstandingAskJournal();
    journal.seedFrom({
      cursor: 12,
      windowHeadCursor: undefined,
      entities: [{ kind: "run", id: "run-a", state: "waiting_for_approval" }],
    });
    journal.admit([rowOf(12, "run.running", { runId: "run-a" })]);
    expect(openCountOf(journal.ledger)).toBe(1);

    journal.admit([rowOf(13, "run.running", { runId: "run-a" })]);
    expect(openCountOf(journal.ledger)).toBe(0);
  });
});

describe("OutstandingAskJournal — rows in any order", () => {
  it("does not re-open a request whose terminal arrived first", () => {
    // THE BACKWARD-PAGE CASE. A page read from behind the window's head delivers a
    // request's opening row AFTER its terminal, and a register that deleted a key on a
    // terminal would hold that ask open for the rest of the session.
    const journal = new OutstandingAskJournal();
    journal.admit([rowOf(9, "approval.approved", { approvalRequestId: "req-1" })]);
    journal.admit([rowOf(4, "approval.requested", { approvalRequestId: "req-1" })]);

    expect(openCountOf(journal.ledger)).toBe(0);
  });

  it("negative control: the same opener with no terminal anywhere stays open", () => {
    const journal = new OutstandingAskJournal();
    journal.admit([rowOf(4, "approval.requested", { approvalRequestId: "req-1" })]);

    expect(openCountOf(journal.ledger)).toBe(1);
  });

  it("keeps the newest run state whichever end of the log it arrived from", () => {
    const journal = new OutstandingAskJournal();
    journal.admit([rowOf(8, "run.running", { runId: "run-a" })]);
    journal.admit([rowOf(3, "run.waiting_for_approval", { runId: "run-a" })]);

    expect(openCountOf(journal.ledger)).toBe(0);
  });
});

describe("SessionStore — the ledger outlives the window", () => {
  it("still counts an approval whose opening row the cap has dropped", () => {
    // THE DEFECT, EXERCISED THROUGH THE REAL STORE. The cap keeps the newest rows, so
    // the row that opened this approval is gone from the timeline a fold used to walk
    // — and the approval is still open.
    const store = new SessionStore({ sessionId: SESSION_ID, timelineCap: 2 });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.applyBatch([
      rowOf(1, "approval.requested", { approvalRequestId: "req-1" }, "agent-scout"),
      rowOf(2, "tool.invoked", { runId: "run-a" }, "agent-scout"),
      rowOf(3, "tool.result", { runId: "run-a" }, "agent-scout"),
    ]);

    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([2, 3]);
    expect(openCountOf(store.outstandingAskLedger)).toBe(1);
  });

  it("negative control: the same store answers zero once the approval is resolved", () => {
    const store = new SessionStore({ sessionId: SESSION_ID, timelineCap: 2 });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.applyBatch([
      rowOf(1, "approval.requested", { approvalRequestId: "req-1" }, "agent-scout"),
      rowOf(2, "approval.approved", { approvalRequestId: "req-1" }, "participant-you"),
      rowOf(3, "tool.result", { runId: "run-a" }, "agent-scout"),
    ]);

    expect(openCountOf(store.outstandingAskLedger)).toBe(0);
  });

  it("takes what a backward page recovered from behind the window's head", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({ cursor: 5, entities: [], participantJoinLog: [] });
    store.applyBatch([rowOf(6, "tool.invoked", { runId: "run-a" }, "agent-scout")]);
    expect(openCountOf(store.outstandingAskLedger)).toBe(0);

    store.prependEarlierEvents([
      rowOf(2, "approval.requested", { approvalRequestId: "req-1" }, "agent-scout"),
    ]);

    expect(openCountOf(store.outstandingAskLedger)).toBe(1);
  });
});
