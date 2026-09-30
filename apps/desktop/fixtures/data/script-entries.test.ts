// What the script builder guarantees and what it refuses.
//
// A skipped sequence renders as "catching up" and a wrong `occurredAt` renders as an
// ordinary row, so neither shows in a frame. Expected values are derived independently
// (start instant plus the entry's `atMs`), never from a copy of the builder's arithmetic.

import { describe, expect, it } from "vitest";

// Imported, not restated, so the scenario and these expectations share one start instant.
import {
  EVENT_ID_STEM,
  RUN_IMPLEMENTER,
  SESSION_ID,
  startedAtMs,
} from "../scenarios/transcript-states.js";
import {
  assistantOutputEntry,
  runTransitionEntry,
  composeScriptBeats,
  toolActivityEntry,
  type ScriptEntry,
} from "./script-entries.js";

/** A three-entry script whose `atMs` values are distinct and increasing. */
const ORDERED_SCRIPT: readonly ScriptEntry[] = [
  { atMs: 0, kind: "session.created", payload: { sessionId: SESSION_ID } },
  { atMs: 40, kind: "user.message", payload: { sessionId: SESSION_ID } },
  { atMs: 120, kind: "session.renamed", payload: { sessionId: SESSION_ID } },
];

function buildOrderedBeats(): ReturnType<typeof composeScriptBeats> {
  return composeScriptBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtMs,
    entries: ORDERED_SCRIPT,
  });
}

describe("composeScriptBeats", () => {
  it("positions every beat by its index, so a script can never carry a gap", () => {
    expect(buildOrderedBeats().map((beat) => beat.event.sequence)).toStrictEqual([1, 2, 3]);
  });

  it("derives `occurredAt` from the start instant and the beat's own `atMs`", () => {
    expect(buildOrderedBeats().map((beat) => beat.event.occurredAt)).toStrictEqual(
      ORDERED_SCRIPT.map((entry) => new Date(startedAtMs + entry.atMs).toISOString()),
    );
  });

  it("carries the entry's kind, actor, and payload through untouched", () => {
    const [beat] = composeScriptBeats({
      sessionId: SESSION_ID,
      eventIdStem: EVENT_ID_STEM,
      startedAtMs,
      entries: [
        { atMs: 0, kind: "user.message", actorId: RUN_IMPLEMENTER, payload: { note: "kept" } },
      ],
    });
    expect(beat?.event.kind).toBe("user.message");
    expect(beat?.event.actorId).toBe(RUN_IMPLEMENTER);
    expect(beat?.event.payload).toStrictEqual({ note: "kept" });
  });

  it("omits the actor entirely when the entry names none", () => {
    const [beat] = composeScriptBeats({
      sessionId: SESSION_ID,
      eventIdStem: EVENT_ID_STEM,
      startedAtMs,
      entries: [{ atMs: 0, kind: "run.starting" }],
    });
    expect(beat?.event).not.toHaveProperty("actorId");
  });

  it("refuses a script that goes backwards in time", () => {
    expect(() =>
      composeScriptBeats({
        sessionId: SESSION_ID,
        eventIdStem: EVENT_ID_STEM,
        startedAtMs,
        entries: [
          { atMs: 100, kind: "run.starting" },
          { atMs: 40, kind: "run.running" },
        ],
      }),
    ).toThrow(RangeError);
  });

  it("accepts two entries due at the same tick — simultaneity is not disorder", () => {
    // Negative control: the refusal fires on a script that goes backwards, not on one that
    // merely fails to advance, because two lanes emit on one tick.
    expect(() =>
      composeScriptBeats({
        sessionId: SESSION_ID,
        eventIdStem: EVENT_ID_STEM,
        startedAtMs,
        entries: [
          { atMs: 40, kind: "run.starting" },
          { atMs: 40, kind: "run.running" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("runTransitionEntry", () => {
  it("composes the kind from the state the run moved INTO", () => {
    const entry = runTransitionEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      runVersion: 4,
      previousState: "running",
      newState: "waiting_for_approval",
    });
    expect(entry.kind).toBe("run.waiting_for_approval");
    expect(entry.payload).toStrictEqual({
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      runVersion: 4,
      previousState: "running",
      newState: "waiting_for_approval",
    });
  });

  it("omits `previousState` on the birth transition, which came from nowhere", () => {
    const entry = runTransitionEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      runVersion: 1,
      newState: "queued",
      agentId: RUN_IMPLEMENTER,
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
      runId: RUN_IMPLEMENTER,
      kind: "assistant.message",
      contentType: "text/markdown",
      contentLength: 1_284,
    });
    expect(entry.payload).toStrictEqual({
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      contentType: "text/markdown",
      contentLength: 1_284,
    });
  });

  it("carries the tool name every tool row is attributed by", () => {
    const entry = toolActivityEntry({
      atMs: 0,
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
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
      runId: RUN_IMPLEMENTER,
      kind: "tool.invoked",
      toolName: "edit_file",
      toolCallId: "call-1",
    });
    expect(entry.payload).not.toHaveProperty("durationMs");
  });
});
