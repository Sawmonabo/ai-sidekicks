// Timeline rows for the cards' own tests.
//
// SCAFFOLDING, AND REACHED ONLY BY TESTS. It is deliberately NOT exported through
// `cards/index.ts`, so nothing in the application graph imports it and the bundler drops
// it from the renderer chunk. It lives here rather than under `test/` because the
// co-located console tests compile under the renderer's own program, whose root does not
// reach the test tree.
//
// WHY A BUILDER RATHER THAN LITERALS PER TEST. `TimelineRow` is a four-arm discriminated
// union whose `run` arm requires three members that are all-or-none by construction. A
// literal per test file would be four chances to write a row the projector could never
// emit, and the cards would then be asserted against shapes that do not occur.

import type { RunId, SessionId, TimelineRow } from "@ai-sidekicks/contracts";

/** The session every sample row belongs to. Opaque on the wire; branded in the contract. */
const SAMPLE_SESSION_ID = "01J0000000000000000000000A" as SessionId;

/** The run every sample run row belongs to. Branded for the same reason. */
const SAMPLE_RUN_ID = "01J0000000000000000000000B" as RunId;

/** What a caller may vary about a sample row. Everything else is held fixed. */
export interface SampleRowOverrides {
  readonly id?: string;
  readonly type?: string;
  readonly summary?: string;
  readonly actor?: string;
  readonly timestamp?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * A run-scoped row — the arm every message and tool row actually takes.
 *
 * `position` and `epoch` are present because the arm requires them: a run row without
 * them fails the contract's own parse, so a sample without them would be testing against
 * a row that cannot arrive.
 */
export function sampleRunRow(overrides: SampleRowOverrides = {}): TimelineRow {
  return {
    kind: "run",
    id: overrides.id ?? "event-01",
    sessionId: SAMPLE_SESSION_ID,
    sequence: 1,
    category: "run_lifecycle",
    type: overrides.type ?? "assistant.message",
    summary: overrides.summary ?? "The agent replied.",
    timestamp: overrides.timestamp ?? "2026-09-02T10:00:00.000Z",
    payload: { ...overrides.payload },
    runId: SAMPLE_RUN_ID,
    position: 1,
    epoch: 0,
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
  };
}

/** A non-run row — the arm a receipt takes. */
export function sampleGeneralRow(overrides: SampleRowOverrides = {}): TimelineRow {
  return {
    kind: "general",
    id: overrides.id ?? "event-02",
    sessionId: SAMPLE_SESSION_ID,
    sequence: 2,
    category: "session_lifecycle",
    type: overrides.type ?? "session.created",
    summary: overrides.summary ?? "The session was created.",
    timestamp: overrides.timestamp ?? "2026-09-02T10:00:01.000Z",
    payload: { ...overrides.payload },
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
  };
}
