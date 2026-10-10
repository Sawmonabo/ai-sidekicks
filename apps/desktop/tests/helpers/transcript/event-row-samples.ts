// Transcript rows for the cards' own tests. Test-only: not exported through any barrel, so the
// application graph never imports it. A builder rather than literals per test, because
// `TranscriptEventRow` is a discriminated union whose `run` arm requires three members that are
// all-or-none; a literal could write a row the projector never emits.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { clockLocaleFor, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { FIXTURE_APP_META } from "#renderer/services/platform/bridge.fixture.js";
import { HOVER_LABEL_TEXT_ATTRIBUTE } from "#renderer/components/HoverLabel/HoverLabel.js";

/** The session every sample row belongs to. Opaque on the wire; branded in the contract. */
const SAMPLE_SESSION_ID = "01J0000000000000000000000A" as SessionId;

/** The run every sample run row belongs to. Branded for the same reason. */
const SAMPLE_RUN_ID = "01J0000000000000000000000B" as RunId;

/** When a sample run row happened, unless a caller gives it another time. */
const SAMPLE_RUN_ROW_TIMESTAMP = "2026-09-02T10:00:00.000Z";

const SAMPLE_RUN_ROW_ZONED_TIME = formatZonedDateTime(
  SAMPLE_RUN_ROW_TIMESTAMP,
  clockLocaleFor(FIXTURE_APP_META),
);

const SAMPLE_RUN_ROW_HOVER_LABEL = `[${HOVER_LABEL_TEXT_ATTRIBUTE}="${SAMPLE_RUN_ROW_ZONED_TIME}"]`;

/**
 * A sample run row's drawn time under the fixture's machine clock, found by the zoned instant its
 * hover label reads.
 */
export const SAMPLE_RUN_ROW_TIME_SELECTOR: string =
  ".meridian-figure--wire" + SAMPLE_RUN_ROW_HOVER_LABEL;

/** The session a sample message's payload names, in the id form its contract parses. */
const SAMPLE_PAYLOAD_SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** What a caller may vary about a sample row. Everything else is held fixed. */
export interface SampleRowOverrides {
  readonly id?: string;
  readonly type?: string;
  /**
   * The run the row is attributed to, for cases about more than one run: two runs blocked at
   * once is a shape the projection produces and one run id cannot state.
   */
  readonly runId?: string;
  readonly actor?: string;
  readonly timestamp?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** The row's body, as a read brings it; absent, the row is one the stream delivered. */
  readonly content?: TranscriptRowContent;
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
    timestamp: overrides.timestamp ?? SAMPLE_RUN_ROW_TIMESTAMP,
    payload: { ...overrides.payload },
    runId: (overrides.runId ?? SAMPLE_RUN_ID) as RunId,
    position: 1,
    epoch: 0,
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
    ...(overrides.content === undefined ? {} : { content: overrides.content }),
  };
}

/** A person's message row, its payload the `user.message` shape the body reads it from. */
export function sampleUserMessageRow(
  overrides: Omit<SampleRowOverrides, "payload" | "type"> & { readonly message: string },
): TranscriptEventRow {
  return sampleRunRow({
    ...overrides,
    type: "user.message",
    payload: { sessionId: SAMPLE_PAYLOAD_SESSION_ID, actor: "user", message: overrides.message },
  });
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
    timestamp: overrides.timestamp ?? "2026-09-02T10:00:01.000Z",
    payload: { ...overrides.payload },
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
  };
}
