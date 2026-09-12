// The reading, and the defect it was written for.
//
// The load-bearing case is `run A waiting, run B busier`: an agent blocked on an
// approval in one run and emitting an ordinary row from another. Reading attention
// off the newest row answers "clear" there, which is the header saying "Nothing needs
// you" over a run that is still blocked. Every case below asserts against the ask's
// own lifecycle instead.
//
// DRIVEN THROUGH A REAL `SessionStore`, which is the whole seam: the lifecycles are
// held by `store/session/outstanding-asks/outstanding-ask-journal.ts` because a fold
// over the store's own capped, resumable window loses an approval whose opening row it
// was never sent. A case that typed out a ledger would assert against an input no
// session produces, and the wire-truth claim over the kinds those lifecycles key on is
// made where they are declared, in that module's own co-located suite.

import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleSessionEvent } from "../../../store/index.js";
import { foldOutstandingAsks, type OutstandingAsks } from "./outstanding-asks.js";

const FOLD_SESSION_ID = "session-1";

interface EventDraft {
  readonly kind: string;
  readonly actor?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

function logOf(drafts: readonly EventDraft[]): readonly ConsoleSessionEvent[] {
  return drafts.map((draft, position) => ({
    id: `event-${String(position + 1)}`,
    sessionId: FOLD_SESSION_ID,
    sequence: position + 1,
    kind: draft.kind,
    occurredAt: "2026-01-01T14:20:00.000Z",
    ...(draft.actor === undefined ? {} : { actorId: draft.actor }),
    ...(draft.payload === undefined ? {} : { payload: draft.payload }),
  }));
}

/** What the header reads after this log reached a store through its apply chokepoint. */
function outstandingAfter(drafts: readonly EventDraft[]): OutstandingAsks {
  const store = new SessionStore({ sessionId: FOLD_SESSION_ID });
  store.initialise({ cursor: 0, entities: [], userJoinLog: [] });
  store.applyBatch(logOf(drafts));
  return foldOutstandingAsks(store.outstandingAskLedger);
}

describe("foldOutstandingAsks — an ask closes on its own terminal and nothing else", () => {
  it("keeps run A's approval outstanding while run B emits newer ordinary rows", () => {
    const outstanding = outstandingAfter([
      { kind: "run.waiting_for_approval", actor: "agent-architect", payload: { runId: "run-a" } },
      { kind: "run.running", actor: "agent-architect", payload: { runId: "run-b" } },
      { kind: "tool.invoked", actor: "agent-architect", payload: { runId: "run-b" } },
    ]);
    expect(outstanding.count).toBe(1);
  });

  it("clears run A once run A itself moves on", () => {
    const outstanding = outstandingAfter([
      { kind: "run.waiting_for_approval", actor: "agent-architect", payload: { runId: "run-a" } },
      { kind: "run.running", actor: "agent-architect", payload: { runId: "run-b" } },
      { kind: "run.running", actor: "agent-architect", payload: { runId: "run-a" } },
    ]);
    expect(outstanding.count).toBe(0);
  });

  it("closes an approval only on a terminal carrying its own request id", () => {
    const opened: readonly EventDraft[] = [
      { kind: "approval.requested", actor: "agent-scout", payload: { approvalRequestId: "req-1" } },
      {
        kind: "approval.approved",
        actor: "user-you",
        payload: { approvalRequestId: "req-2" },
      },
    ];
    expect(outstandingAfter(opened).count).toBe(1);

    const resolved: readonly EventDraft[] = [
      { kind: "approval.requested", actor: "agent-scout", payload: { approvalRequestId: "req-1" } },
      {
        kind: "approval.approved",
        actor: "user-you",
        payload: { approvalRequestId: "req-1" },
      },
    ];
    expect(outstandingAfter(resolved).count).toBe(0);
  });

  it("counts an ask by its own opening row, never by whoever resolved it", () => {
    // Every `driver_ask.*` row carries its `runId`, which is what the wire requires of
    // all four shapes — a fixture that omitted it would be asserting over a payload no
    // daemon emits.
    const outstanding = outstandingAfter([
      {
        kind: "driver_ask.requested",
        actor: "agent-scout",
        payload: { runId: "run-a", askId: "ask-1" },
      },
      {
        kind: "driver_ask.requested",
        actor: "agent-scout",
        payload: { runId: "run-a", askId: "ask-2" },
      },
      {
        kind: "driver_ask.responded",
        actor: "user-you",
        payload: { runId: "run-a", askId: "ask-2" },
      },
    ]);
    expect(outstanding.count).toBe(1);
  });

  // THE PROVIDER'S ASK ID IS NOT AN IDENTITY. It is minted per provider session, so
  // two runs blocked at once legitimately raise `ask-1` each. Keyed on that id alone
  // both openers wrote one entry, either terminal deleted it, and the bar said nothing
  // needed anybody while the other run was still waiting.
  it("keeps run B's ask outstanding when run A answers the same provider ask id", () => {
    const outstanding = outstandingAfter([
      {
        kind: "driver_ask.requested",
        actor: "agent-scout",
        payload: { runId: "run-a", askId: "ask-1" },
      },
      {
        kind: "driver_ask.requested",
        actor: "agent-architect",
        payload: { runId: "run-b", askId: "ask-1" },
      },
      {
        kind: "driver_ask.responded",
        actor: "user-you",
        payload: { runId: "run-a", askId: "ask-1" },
      },
    ]);
    expect(outstanding.count).toBe(1);
  });

  it("does not let one run's ask terminal close another run's ask of the same id", () => {
    const outstanding = outstandingAfter([
      {
        kind: "driver_ask.requested",
        actor: "agent-scout",
        payload: { runId: "run-a", askId: "ask-1" },
      },
      {
        kind: "driver_ask.canceled",
        actor: "user-you",
        payload: { runId: "run-b", askId: "ask-1" },
      },
    ]);
    expect(outstanding.count).toBe(1);
  });

  it("holds a provider ask that named no run open rather than clearing it", () => {
    // The scope is as load-bearing as the id: without it the ask cannot be matched to
    // its own terminal, so it is held under a key of its own — the same fail-closed
    // direction an uncorrelated request takes.
    const outstanding = outstandingAfter([
      { kind: "driver_ask.requested", actor: "agent-scout", payload: { askId: "ask-1" } },
      { kind: "driver_ask.responded", actor: "user-you", payload: { askId: "ask-1" } },
    ]);
    expect(outstanding.count).toBe(1);
  });

  it("still closes an ask on its own run's terminal, which is what makes the scope a key and not a wall", () => {
    const outstanding = outstandingAfter([
      {
        kind: "driver_ask.requested",
        actor: "agent-scout",
        payload: { runId: "run-a", askId: "ask-1" },
      },
      {
        kind: "driver_ask.responded",
        actor: "user-you",
        payload: { runId: "run-a", askId: "ask-1" },
      },
    ]);
    expect(outstanding.count).toBe(0);
  });

  it("does not let an approval's own askId open a provider ask nothing can close", () => {
    // The wire puts `askId` on `approval.requested` where the request came from a
    // provider permission ask. Matching a lifecycle by which member the payload carries
    // would open a `driver_ask` here that no `driver_ask.*` terminal names, leaving the
    // header amber for the session's life.
    const outstanding = outstandingAfter([
      {
        kind: "approval.requested",
        actor: "agent-scout",
        payload: { approvalRequestId: "req-1", askId: "ask-1" },
      },
      {
        kind: "approval.approved",
        actor: "user-you",
        payload: { approvalRequestId: "req-1", askId: "ask-1" },
      },
    ]);
    expect(outstanding.count).toBe(0);
  });

  it("holds an ask the wire did not correlate open rather than clearing it", () => {
    const outstanding = outstandingAfter([
      { kind: "intervention.requested", actor: "user-you" },
      { kind: "intervention.applied", actor: "user-you" },
    ]);
    expect(outstanding.count).toBe(1);
  });

  it("counts an ask the wire attributed to nobody", () => {
    const outstanding = outstandingAfter([
      { kind: "approval.requested", payload: { approvalRequestId: "req-1" } },
    ]);
    expect(outstanding.count).toBe(1);
  });

  // The negative control: an ordinary log folds to nothing outstanding. Without it
  // every case above would pass over a fold that reported everything as open.
  it("negative control: a busy session with nothing blocked is clear", () => {
    const outstanding = outstandingAfter([
      { kind: "run.queued", actor: "agent-architect", payload: { runId: "run-a" } },
      { kind: "run.running", actor: "agent-architect", payload: { runId: "run-a" } },
      { kind: "tool.invoked", actor: "agent-architect", payload: { runId: "run-a" } },
      { kind: "run.completed", actor: "agent-architect", payload: { runId: "run-a" } },
    ]);
    expect(outstanding.count).toBe(0);
  });
});
