// Transcript rows for the cards' own tests. Test-only: not exported through any barrel, so the
// application graph never imports it. A builder rather than literals per test, because
// `TranscriptEventRow` is a discriminated union whose `run` arm requires three members that are
// all-or-none; a literal could write a row the projector never emits.

import type { RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

/** The session every sample row belongs to. Opaque on the wire; branded in the contract. */
const SAMPLE_SESSION_ID = "01J0000000000000000000000A" as SessionId;

/** The run every sample run row belongs to. Branded for the same reason. */
const SAMPLE_RUN_ID = "01J0000000000000000000000B" as RunId;

/** What a caller may vary about a sample row. Everything else is held fixed. */
export interface SampleRowOverrides {
  readonly id?: string;
  readonly type?: string;
  /**
   * The run the row is attributed to, for cases about more than one run: two runs blocked at
   * once is a shape the projection produces and one run id cannot state.
   */
  readonly runId?: string;
  readonly summary?: string;
  readonly actor?: string;
  readonly timestamp?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * A run-scoped row, the arm every message and tool row takes. `position` and `epoch` are present
 * because the arm requires them; without them the contract's own parse fails.
 */
export function sampleRunRow(overrides: SampleRowOverrides = {}): TranscriptEventRow {
  return {
    kind: "run",
    id: overrides.id ?? "event-01",
    sessionId: SAMPLE_SESSION_ID,
    sequence: 1,
    cursor: "cursor-at-1" as EventCursor,
    category: "run_lifecycle",
    type: overrides.type ?? "assistant.message",
    summary: overrides.summary ?? "The agent replied.",
    timestamp: overrides.timestamp ?? "2026-09-02T10:00:00.000Z",
    payload: { ...overrides.payload },
    runId: (overrides.runId ?? SAMPLE_RUN_ID) as RunId,
    position: 1,
    epoch: 0,
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
  };
}

/** A non-run row — the arm a receipt takes. */
export function sampleGeneralRow(overrides: SampleRowOverrides = {}): TranscriptEventRow {
  return {
    kind: "general",
    id: overrides.id ?? "event-02",
    sessionId: SAMPLE_SESSION_ID,
    sequence: 2,
    cursor: "cursor-at-2" as EventCursor,
    category: "session_lifecycle",
    type: overrides.type ?? "session.created",
    summary: overrides.summary ?? "The session was created.",
    timestamp: overrides.timestamp ?? "2026-09-02T10:00:01.000Z",
    payload: { ...overrides.payload },
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
  };
}
