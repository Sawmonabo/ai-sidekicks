// The fold, and the defect it was written for.
//
// The load-bearing case is `run A waiting, run B busier`: an agent blocked on an
// approval in one run and emitting an ordinary row from another. Reading attention
// off the newest row answers "clear" there, which is the bar saying "Nothing needs
// you" over a run that is still blocked. Every case below asserts against the ask's
// own lifecycle instead.
//
// The first describe is the wire-truth one: every kind this fold keys on is checked
// against the contracts package's own census, so a lifecycle built on a kind the wire
// does not have cannot ship.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../../store/index.js";
import {
  ATTENTION_RUN_STATE_KINDS,
  REQUEST_LIFECYCLES,
  RUN_STATE_KINDS,
  foldOutstandingAsks,
} from "./outstanding-asks.js";

const REGISTERED_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
);

interface EventDraft {
  readonly kind: string;
  readonly actor?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

function logOf(drafts: readonly EventDraft[]): readonly ConsoleSessionEvent[] {
  return drafts.map((draft, position) => ({
    id: `event-${String(position + 1)}`,
    sessionId: "session-1",
    sequence: position + 1,
    kind: draft.kind,
    occurredAt: "2026-01-01T14:20:00.000Z",
    ...(draft.actor === undefined ? {} : { actorId: draft.actor }),
    ...(draft.payload === undefined ? {} : { payload: draft.payload }),
  }));
}

describe("the lifecycles this fold keys on — wire truth", () => {
  it("names only event kinds the contracts package registers", () => {
    const named = [
      ...RUN_STATE_KINDS,
      ...ATTENTION_RUN_STATE_KINDS,
      ...REQUEST_LIFECYCLES.flatMap((lifecycle) => [lifecycle.openedBy, ...lifecycle.closedBy]),
    ];
    expect(named.filter((kind) => !REGISTERED_EVENT_TYPES.has(kind))).toStrictEqual([]);
  });

  it("keeps the attention run states a subset of the run states", () => {
    expect(ATTENTION_RUN_STATE_KINDS.every((kind) => RUN_STATE_KINDS.includes(kind))).toBe(true);
  });

  it("negative control: the census is a real set, and a made-up kind is not in it", () => {
    expect(REGISTERED_EVENT_TYPES.size).toBeGreaterThan(100);
    expect(REGISTERED_EVENT_TYPES.has("run.started")).toBe(false);
  });
});

describe("foldOutstandingAsks — an ask closes on its own terminal and nothing else", () => {
  it("keeps run A's approval outstanding while run B emits newer ordinary rows", () => {
    const outstanding = foldOutstandingAsks(
      logOf([
        { kind: "run.waiting_for_approval", actor: "agent-architect", payload: { runId: "run-a" } },
        { kind: "run.running", actor: "agent-architect", payload: { runId: "run-b" } },
        { kind: "tool.invoked", actor: "agent-architect", payload: { runId: "run-b" } },
      ]),
    );
    expect(outstanding.count).toBe(1);
    expect([...outstanding.participantIds]).toStrictEqual(["agent-architect"]);
  });

  it("clears run A once run A itself moves on", () => {
    const outstanding = foldOutstandingAsks(
      logOf([
        { kind: "run.waiting_for_approval", actor: "agent-architect", payload: { runId: "run-a" } },
        { kind: "run.running", actor: "agent-architect", payload: { runId: "run-b" } },
        { kind: "run.running", actor: "agent-architect", payload: { runId: "run-a" } },
      ]),
    );
    expect(outstanding.count).toBe(0);
    expect(outstanding.participantIds.size).toBe(0);
  });

  it("closes an approval only on a terminal carrying its own request id", () => {
    const opened = logOf([
      { kind: "approval.requested", actor: "agent-scout", payload: { approvalRequestId: "req-1" } },
      {
        kind: "approval.approved",
        actor: "participant-you",
        payload: { approvalRequestId: "req-2" },
      },
    ]);
    expect(foldOutstandingAsks(opened).count).toBe(1);

    const resolved = logOf([
      { kind: "approval.requested", actor: "agent-scout", payload: { approvalRequestId: "req-1" } },
      {
        kind: "approval.approved",
        actor: "participant-you",
        payload: { approvalRequestId: "req-1" },
      },
    ]);
    expect(foldOutstandingAsks(resolved).count).toBe(0);
  });

  it("attributes an ask to whoever opened it, never to whoever resolved it", () => {
    const outstanding = foldOutstandingAsks(
      logOf([
        { kind: "driver_ask.requested", actor: "agent-scout", payload: { askId: "ask-1" } },
        { kind: "driver_ask.requested", actor: "agent-scout", payload: { askId: "ask-2" } },
        { kind: "driver_ask.responded", actor: "participant-you", payload: { askId: "ask-2" } },
      ]),
    );
    expect([...outstanding.participantIds]).toStrictEqual(["agent-scout"]);
    expect(outstanding.count).toBe(1);
  });

  it("does not let an approval's own askId open a provider ask nothing can close", () => {
    // `Spec-006 §Approval Flow (approval_flow)` puts `askId` on `approval.requested` where the
    // request came from a provider permission ask. Matching a lifecycle by which
    // member the payload carries would open a `driver_ask` here that no
    // `driver_ask.*` terminal names, leaving the bar amber for the session's life.
    const outstanding = foldOutstandingAsks(
      logOf([
        {
          kind: "approval.requested",
          actor: "agent-scout",
          payload: { approvalRequestId: "req-1", askId: "ask-1" },
        },
        {
          kind: "approval.approved",
          actor: "participant-you",
          payload: { approvalRequestId: "req-1", askId: "ask-1" },
        },
      ]),
    );
    expect(outstanding.count).toBe(0);
  });

  it("holds an ask the wire did not correlate open rather than clearing it", () => {
    const outstanding = foldOutstandingAsks(
      logOf([
        { kind: "intervention.requested", actor: "participant-you" },
        { kind: "intervention.applied", actor: "participant-you" },
      ]),
    );
    expect(outstanding.count).toBe(1);
  });

  it("counts an ask the wire attributed to nobody, which no chip could show", () => {
    const outstanding = foldOutstandingAsks(
      logOf([{ kind: "approval.requested", payload: { approvalRequestId: "req-1" } }]),
    );
    expect(outstanding.count).toBe(1);
    expect(outstanding.participantIds.size).toBe(0);
  });

  // The negative control: an ordinary log folds to nothing outstanding. Without it
  // every case above would pass over a fold that reported everything as open.
  it("negative control: a busy session with nothing blocked is clear", () => {
    const outstanding = foldOutstandingAsks(
      logOf([
        { kind: "run.queued", actor: "agent-architect", payload: { runId: "run-a" } },
        { kind: "run.running", actor: "agent-architect", payload: { runId: "run-a" } },
        { kind: "tool.invoked", actor: "agent-architect", payload: { runId: "run-a" } },
        { kind: "run.completed", actor: "agent-architect", payload: { runId: "run-a" } },
      ]),
    );
    expect(outstanding.count).toBe(0);
    expect(outstanding.participantIds.size).toBe(0);
  });
});
