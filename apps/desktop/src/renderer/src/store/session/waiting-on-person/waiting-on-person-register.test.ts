// The ledger outlives the window: its vocabulary is the wire's, rows may arrive in any order, and
// pruning or replacing the window does not lose an ask.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  WaitingOnPersonRegister,
  type WaitingOnPersonRecords,
} from "./waiting-on-person-register.js";
import {
  ATTENTION_RUN_STATES,
  ATTENTION_RUN_STATE_KINDS,
  REQUEST_LIFECYCLES,
  RUN_STATE_EVENT_PREFIX,
  RUN_STATE_KINDS,
} from "./waiting-on-person-states.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { SessionStore } from "../session-store.js";
import type { ProjectedSessionEvent } from "../entities/entities.js";

const SESSION_ID = "session-journal";
const REGISTERED_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
);

function rowOf(
  sequence: number,
  kind: string,
  payload?: Readonly<Record<string, unknown>>,
  actorId?: string,
): ProjectedSessionEvent {
  const base = eventOfKind(SESSION_ID, kind, sequence, payload);
  return actorId === undefined ? base : { ...base, actorId };
}

/** How many lifecycles the ledger holds open — an opening with no terminal after it. */
function openCountOf(ledger: WaitingOnPersonRecords): number {
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
    // The seed compares an entity's state with ATTENTION_RUN_STATES and the log compares a kind
    // with ATTENTION_RUN_STATE_KINDS; the two agree only while every kind is its state under
    // the prefix. The states being the contract's is a compile-time claim in the module.
    expect(RUN_STATE_KINDS).toHaveLength(9);
    expect(RUN_STATE_KINDS.every((kind) => kind.startsWith(RUN_STATE_EVENT_PREFIX))).toBe(true);
  });

  it("keeps the attention run states a subset of the run states", () => {
    expect(ATTENTION_RUN_STATE_KINDS.every((kind) => RUN_STATE_KINDS.includes(kind))).toBe(true);
    expect(ATTENTION_RUN_STATES.map((state) => `${RUN_STATE_EVENT_PREFIX}${state}`)).toStrictEqual([
      ...ATTENTION_RUN_STATE_KINDS,
    ]);
  });

  it("negative control: the census is a real set, and a made-up kind is not in it", () => {
    expect(REGISTERED_EVENT_TYPES.size).toBeGreaterThan(100);
    expect(REGISTERED_EVENT_TYPES.has("run.started")).toBe(false);
  });
});

describe("WaitingOnPersonRegister — what a base state establishes", () => {
  it("seeds a blocked run off the entity the read carried", () => {
    // A run's `state` is a registered `RunState`, so a run blocked below the window's head shows
    // on the base state.
    const journal = new WaitingOnPersonRegister();
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
    // No base-state entity carries an approval or an intervention, so a mid-log window cannot
    // answer for them: unread, not zero.
    const journal = new WaitingOnPersonRegister();
    journal.seedFrom({ cursor: 12, windowHeadCursor: "cursor-12", entities: [] });

    expect(journal.ledger.isWindowHeadUnread).toBe(true);
  });

  it("negative control: a read from the beginning of the log reports nothing unread", () => {
    const journal = new WaitingOnPersonRegister();
    journal.seedFrom({ cursor: 0, windowHeadCursor: undefined, entities: [] });

    expect(journal.ledger.isWindowHeadUnread).toBe(false);
  });

  it("keeps what it already held when a later read re-establishes the window", () => {
    // A read says nothing about a request it did not carry; clearing here would lose older asks.
    const journal = new WaitingOnPersonRegister();
    journal.admit([rowOf(3, "approval.requested", { approvalRequestId: "req-1" })]);
    journal.seedFrom({ cursor: 40, windowHeadCursor: "cursor-40", entities: [] });

    expect(openCountOf(journal.ledger)).toBe(1);
  });

  it("lets a newer row supersede the seed, and refuses one at the seed's own position", () => {
    const journal = new WaitingOnPersonRegister();
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

describe("WaitingOnPersonRegister — rows in any order", () => {
  it("does not re-open a request whose terminal arrived first", () => {
    // A backward page delivers a request's opener after its terminal; a register that deleted
    // the key on a terminal would hold the ask open for the rest of the session.
    const journal = new WaitingOnPersonRegister();
    journal.admit([rowOf(9, "approval.approved", { approvalRequestId: "req-1" })]);
    journal.admit([rowOf(4, "approval.requested", { approvalRequestId: "req-1" })]);

    expect(openCountOf(journal.ledger)).toBe(0);
  });

  it("negative control: the same opener with no terminal anywhere stays open", () => {
    const journal = new WaitingOnPersonRegister();
    journal.admit([rowOf(4, "approval.requested", { approvalRequestId: "req-1" })]);

    expect(openCountOf(journal.ledger)).toBe(1);
  });

  it("keeps the newest run state whichever end of the log it arrived from", () => {
    const journal = new WaitingOnPersonRegister();
    journal.admit([rowOf(8, "run.running", { runId: "run-a" })]);
    journal.admit([rowOf(3, "run.waiting_for_approval", { runId: "run-a" })]);

    expect(openCountOf(journal.ledger)).toBe(0);
  });
});

describe("SessionStore — the ledger outlives the window", () => {
  it("still counts an approval whose opening row the cap has dropped", () => {
    // The cap drops the row that opened this approval from the timeline, yet it is still open.
    const store = new SessionStore({ sessionId: SESSION_ID, timelineCap: 2 });
    store.initialize({ cursor: 0, entities: [] });
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
    store.initialize({ cursor: 0, entities: [] });
    store.applyBatch([
      rowOf(1, "approval.requested", { approvalRequestId: "req-1" }, "agent-scout"),
      rowOf(2, "approval.approved", { approvalRequestId: "req-1" }, "user-you"),
      rowOf(3, "tool.result", { runId: "run-a" }, "agent-scout"),
    ]);

    expect(openCountOf(store.outstandingAskLedger)).toBe(0);
  });

  it("takes what a backward page recovered from behind the window's head", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 5, entities: [] });
    store.applyBatch([rowOf(6, "tool.invoked", { runId: "run-a" }, "agent-scout")]);
    expect(openCountOf(store.outstandingAskLedger)).toBe(0);

    store.prependEarlierEvents([
      rowOf(2, "approval.requested", { approvalRequestId: "req-1" }, "agent-scout"),
    ]);

    expect(openCountOf(store.outstandingAskLedger)).toBe(1);
  });
});
