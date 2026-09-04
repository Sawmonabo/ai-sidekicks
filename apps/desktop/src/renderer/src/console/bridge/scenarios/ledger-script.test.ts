// What the ledger script builder guarantees, and what it refuses.
//
// Three ledger scenarios are built through this module, so a defect here is a
// defect in all three at once — and two of the three guarantees are invisible in a
// rendered frame. A sequence that skips is read by the store as a delivery gap and
// renders as "catching up"; an `occurredAt` that disagrees with its own `atMs`
// renders as a perfectly ordinary row with a wrong timestamp. Both are caught here
// or not at all.
//
// Every case drives the real builder. Its output is asserted against values derived
// independently in the test — the start instant plus the entry's own `atMs` — never
// against a second copy of the builder's arithmetic.

import { describe, expect, it } from "vitest";

import {
  assistantOutputEntry,
  runTransitionEntry,
  scriptLedgerBeats,
  toolActivityEntry,
  type LedgerScriptEntry,
} from "./ledger-script.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/** This suite's own row-id namespace, as every scenario declares one. */
const EVENT_ID_STEM = "019b793b-7b60-7ea1-8110-e5e0d115";
const RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
const STARTED_AT_ISO = "2026-01-01T11:05:00.000Z";

/** A three-entry script whose `atMs` values are distinct and increasing. */
const ORDERED_SCRIPT: readonly LedgerScriptEntry[] = [
  { atMs: 0, kind: "session.created", payload: { sessionId: SESSION_ID } },
  { atMs: 40, kind: "membership.created", payload: { participantId: SESSION_ID } },
  { atMs: 120, kind: "agent.attached", payload: { sessionId: SESSION_ID } },
];

function buildOrderedBeats(): ReturnType<typeof scriptLedgerBeats> {
  return scriptLedgerBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtIso: STARTED_AT_ISO,
    entries: ORDERED_SCRIPT,
  });
}

describe("scriptLedgerBeats", () => {
  it("positions every beat by its index, so a script can never carry a gap", () => {
    expect(buildOrderedBeats().map((beat) => beat.event.sequence)).toStrictEqual([1, 2, 3]);
  });

  it("derives `occurredAt` from the start instant and the beat's own `atMs`", () => {
    const startedAtMs = Date.parse(STARTED_AT_ISO);
    expect(buildOrderedBeats().map((beat) => beat.event.occurredAt)).toStrictEqual(
      ORDERED_SCRIPT.map((entry) => new Date(startedAtMs + entry.atMs).toISOString()),
    );
  });

  it("carries the entry's kind, actor, and payload through untouched", () => {
    const [beat] = scriptLedgerBeats({
      sessionId: SESSION_ID,
      eventIdStem: EVENT_ID_STEM,
      startedAtIso: STARTED_AT_ISO,
      entries: [{ atMs: 0, kind: "user.message", actorId: RUN_ID, payload: { note: "kept" } }],
    });
    expect(beat?.event.kind).toBe("user.message");
    expect(beat?.event.actorId).toBe(RUN_ID);
    expect(beat?.event.payload).toStrictEqual({ note: "kept" });
  });

  it("omits the actor entirely when the entry names none", () => {
    const [beat] = scriptLedgerBeats({
      sessionId: SESSION_ID,
      eventIdStem: EVENT_ID_STEM,
      startedAtIso: STARTED_AT_ISO,
      entries: [{ atMs: 0, kind: "run.starting" }],
    });
    expect(beat?.event).not.toHaveProperty("actorId");
  });

  it("refuses a script that goes backwards in time", () => {
    expect(() =>
      scriptLedgerBeats({
        sessionId: SESSION_ID,
        eventIdStem: EVENT_ID_STEM,
        startedAtIso: STARTED_AT_ISO,
        entries: [
          { atMs: 100, kind: "run.starting" },
          { atMs: 40, kind: "run.running" },
        ],
      }),
    ).toThrow(RangeError);
  });

  it("accepts two entries due at the same tick — simultaneity is not disorder", () => {
    // The negative control for the case above: the refusal has to fire on a script
    // that goes BACKWARDS and not merely on one that does not advance, because two
    // lanes emitting on one tick is exactly what this console is for.
    expect(() =>
      scriptLedgerBeats({
        sessionId: SESSION_ID,
        eventIdStem: EVENT_ID_STEM,
        startedAtIso: STARTED_AT_ISO,
        entries: [
          { atMs: 40, kind: "run.starting" },
          { atMs: 40, kind: "run.running" },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses a start instant it cannot parse", () => {
    expect(() =>
      scriptLedgerBeats({
        sessionId: SESSION_ID,
        eventIdStem: EVENT_ID_STEM,
        startedAtIso: "the day before",
        entries: [],
      }),
    ).toThrow(RangeError);
  });
});

describe("runTransitionEntry", () => {
  it("composes the kind from the state the run moved INTO", () => {
    const entry = runTransitionEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 4,
      previousState: "running",
      newState: "waiting_for_approval",
    });
    expect(entry.kind).toBe("run.waiting_for_approval");
    expect(entry.payload).toStrictEqual({
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 4,
      previousState: "running",
      newState: "waiting_for_approval",
    });
  });

  it("omits `previousState` on the birth transition, which came from nowhere", () => {
    const entry = runTransitionEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      newState: "queued",
      agentId: RUN_ID,
    });
    expect(entry.payload).not.toHaveProperty("previousState");
    expect(entry.payload).toHaveProperty("agentId");
  });
});

describe("the machine-output entries", () => {
  it("describes an assistant body and never carries one", () => {
    const entry = assistantOutputEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      kind: "assistant.message",
      contentType: "text/markdown",
      contentLength: 1_284,
    });
    expect(entry.payload).toStrictEqual({
      sessionId: SESSION_ID,
      runId: RUN_ID,
      contentType: "text/markdown",
      contentLength: 1_284,
    });
  });

  it("carries the tool name every tool row is attributed by", () => {
    const entry = toolActivityEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      kind: "tool.result",
      toolName: "edit_file",
      toolCallId: "call-1",
      durationMs: 140,
    });
    expect(entry.payload).toMatchObject({ toolName: "edit_file", durationMs: 140 });
  });

  it("omits an unmeasured duration rather than reporting zero", () => {
    const entry = toolActivityEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      kind: "tool.invoked",
      toolName: "edit_file",
      toolCallId: "call-1",
    });
    expect(entry.payload).not.toHaveProperty("durationMs");
  });
});
