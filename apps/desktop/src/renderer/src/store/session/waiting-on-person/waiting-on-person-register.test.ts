// The register outlives the window: rows may arrive in any order, and pruning or replacing the
// window does not lose an ask.

import { describe, expect, it } from "vitest";

import {
  WaitingOnPersonRegister,
  type WaitingOnPersonRecords,
} from "./waiting-on-person-register.js";
import { eventOfKind } from "@test/helpers/session/events.js";
import { SessionStore } from "../session-store.js";
import type { ProjectedSessionEvent } from "../entities/entities.js";

const SESSION_ID = "session-waiting-on-person";

function rowOf(
  sequence: number,
  kind: string,
  payload?: Readonly<Record<string, unknown>>,
  actorId?: string,
): ProjectedSessionEvent {
  const base = eventOfKind(SESSION_ID, kind, sequence, payload);
  return actorId === undefined ? base : { ...base, actorId };
}

/** How many lifecycles the records hold open — an opening with no terminal after it. */
function openCountOf(records: WaitingOnPersonRecords): number {
  let open = 0;
  for (const request of records.requestsByKey.values()) {
    if (request.openedAtSequence !== undefined && request.closedAtSequence === undefined) {
      open += 1;
    }
  }
  for (const run of records.runsByRunId.values()) {
    if (run.needsAttention) {
      open += 1;
    }
  }
  return open;
}

describe("WaitingOnPersonRegister — what a base state establishes", () => {
  it("seeds a blocked run off the entity the read carried", () => {
    // A run's `state` is a registered `RunState`, so a run blocked below the window's head shows
    // on the base state.
    const register = new WaitingOnPersonRegister();
    register.seedFrom({
      cursor: 12,
      windowHeadCursor: "cursor-12",
      entities: [
        { kind: "run", id: "run-a", state: "waiting_for_approval", attributedTo: "agent-scout" },
      ],
    });

    expect(openCountOf(register.records)).toBe(1);
    expect(register.records.runsByRunId.get("run-a")?.atSequence).toBe(12);
  });

  it("keeps what it already held when a later read re-establishes the window", () => {
    // A read says nothing about a request it did not carry; clearing here would lose older asks.
    const register = new WaitingOnPersonRegister();
    register.admit([rowOf(3, "approval.requested", { approvalRequestId: "req-1" })]);
    register.seedFrom({ cursor: 40, windowHeadCursor: "cursor-40", entities: [] });

    expect(openCountOf(register.records)).toBe(1);
  });

  it("lets a newer row supersede the seed, and refuses one at the seed's own position", () => {
    const register = new WaitingOnPersonRegister();
    register.seedFrom({
      cursor: 12,
      windowHeadCursor: undefined,
      entities: [{ kind: "run", id: "run-a", state: "waiting_for_approval" }],
    });
    register.admit([rowOf(12, "run.running", { runId: "run-a" })]);
    expect(openCountOf(register.records)).toBe(1);

    register.admit([rowOf(13, "run.running", { runId: "run-a" })]);
    expect(openCountOf(register.records)).toBe(0);
  });
});

describe("WaitingOnPersonRegister — rows in any order", () => {
  it("does not re-open a request whose terminal arrived first", () => {
    // A backward page delivers a request's opener after its terminal; a register that deleted
    // the key on a terminal would hold the ask open for the rest of the session.
    const register = new WaitingOnPersonRegister();
    register.admit([rowOf(9, "approval.approved", { approvalRequestId: "req-1" })]);
    register.admit([rowOf(4, "approval.requested", { approvalRequestId: "req-1" })]);

    expect(openCountOf(register.records)).toBe(0);
  });

  it("keeps the newest run state whichever end of the log it arrived from", () => {
    const register = new WaitingOnPersonRegister();
    register.admit([rowOf(8, "run.running", { runId: "run-a" })]);
    register.admit([rowOf(3, "run.waiting_for_approval", { runId: "run-a" })]);

    expect(openCountOf(register.records)).toBe(0);
  });

  it("stops counting a run once it moves on to pausing", () => {
    const register = new WaitingOnPersonRegister();
    register.admit([rowOf(3, "run.waiting_for_approval", { runId: "run-a" })]);
    register.admit([rowOf(4, "run.pausing", { runId: "run-a" })]);

    expect(openCountOf(register.records)).toBe(0);
  });
});

describe("SessionStore — the register outlives the window", () => {
  it("still counts an approval whose opening row the cap has dropped", () => {
    // The cap drops the row that opened this approval from the transcript, yet it is still open.
    const store = new SessionStore({ sessionId: SESSION_ID, transcriptCap: 2 });
    store.initialize({ cursor: 0, entities: [] });
    store.applyBatch([
      rowOf(1, "approval.requested", { approvalRequestId: "req-1" }, "agent-scout"),
      rowOf(2, "tool.invoked", { runId: "run-a" }, "agent-scout"),
      rowOf(3, "tool.result", { runId: "run-a" }, "agent-scout"),
    ]);

    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([2, 3]);
    expect(openCountOf(store.waitingOnPersonRecords)).toBe(1);
  });
});
