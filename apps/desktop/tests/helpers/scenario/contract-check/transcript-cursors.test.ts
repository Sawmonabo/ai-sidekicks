// Every transcript cursor a scenario's session read hands out names a position its stream
// resolves: `earliest` the one before the first row, `latest` the newest row it delivers. A
// subscription opened after one catches up on exactly the rows behind it, none lost or doubled,
// and is never refused, while a cursor the log never held is. Each case drives the real fixture
// bridge and engine.

import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import {
  SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE,
  type EventCursor,
} from "@ai-sidekicks/contracts/session/id";
import type {
  SessionReadResponse,
  SessionStreamFrame,
} from "@ai-sidekicks/contracts/session/methods";

import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import { SCENARIOS } from "#fixtures/index.js";
import { callDaemon, unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { SESSION_EVENT_STREAM } from "#shared/daemon/streams.js";
import { readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import {
  createFixture,
  lastScriptedBeatMs,
  type FixtureUnderTest,
} from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

/** What a whole-session subscription opened after one cursor delivered, and how it ended. */
interface ResumedStream {
  readonly events: readonly EventEnvelope[];
  readonly ends: readonly DaemonSubscriptionEnd[];
}

// The scenarios whose session read hands cursors out over a log with rows; an empty log has no row
// for a cursor to name.
const SCENARIOS_HANDING_OUT_CURSORS = SCENARIOS.filter(
  (scenario) =>
    scenario.beats.length > 0 && scenario.replies.some((reply) => reply.call === "session.read"),
);

describe("scenario transcript cursors — each one resumes the scenario's stream", () => {
  // `it.each` over no scenarios makes no case, so the check would pass over an empty catalog.
  it("has scenarios that hand cursors out", () => {
    expect(SCENARIOS_HANDING_OUT_CURSORS.length).toBeGreaterThan(0);
  });

  it.each(SCENARIOS_HANDING_OUT_CURSORS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: a subscription after each handed-out cursor delivers exactly the rows behind it",
    async (_scenarioId, scenario) => {
      const fixture = createFixture(scenario);
      fixture.engine.advance(lastScriptedBeatMs(scenario) + 1);
      const read = await readTranscriptCursors(fixture);
      const loggedSequences = scenario.beats.map((beat) => beat.event.sequence);

      // The negative control: a cursor the log never held is refused and delivers nothing.
      const afterUnknown = await resumeAfter(fixture, "cursor-the-log-never-held" as EventCursor);
      expect(afterUnknown.events).toStrictEqual([]);
      expect(afterUnknown.ends).toMatchObject([
        { reason: "refused", refusal: { data: { type: SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE } } },
      ]);

      // The start of the log has every row behind it, so a reader resuming there misses none.
      const afterEarliest = await resumeAfter(fixture, read.earliest);
      expect(afterEarliest.ends).toStrictEqual([]);
      expect(afterEarliest.events.map((event) => event.sequence)).toStrictEqual(loggedSequences);

      // The newest row has nothing behind it, and the stream says so by delivering nothing.
      const afterLatest = await resumeAfter(fixture, read.latest);
      expect(afterLatest.ends).toStrictEqual([]);
      expect(afterLatest.events).toStrictEqual([]);
      expect(scenario.beats.at(-1)?.event.cursor).toBe(read.latest);
    },
  );
});

/** The cursor block the scenario's `session.read` answers with, through the real reply seam. */
async function readTranscriptCursors(
  fixture: FixtureUnderTest,
): Promise<SessionReadResponse["transcriptCursors"]> {
  const sessionId = readSessionId(fixture.engine.scenario.sessionId);
  if (sessionId === undefined) {
    throw new Error(`scenario ${fixture.engine.scenario.id} has no wire session id`);
  }
  return unwrapDaemonReply(await callDaemon(fixture.bridge, "session.read", { sessionId }))
    .transcriptCursors;
}

/**
 * Open the whole-session stream after one cursor, collect what it delivers and how it ends, and
 * close it.
 */
async function resumeAfter(
  fixture: FixtureUnderTest,
  afterCursor: EventCursor,
): Promise<ResumedStream> {
  const events: EventEnvelope[] = [];
  const ends: DaemonSubscriptionEnd[] = [];
  const sessionId = readSessionId(fixture.engine.scenario.sessionId);
  if (sessionId === undefined) {
    throw new Error(`scenario ${fixture.engine.scenario.id} has no wire session id`);
  }
  const unsubscribe = fixture.bridge.daemon.subscribe(
    SESSION_EVENT_STREAM,
    { sessionId, afterCursor },
    (delivered: unknown) => {
      const frame = delivered as SessionStreamFrame;
      if (frame.kind === "changes") {
        for (const change of frame.changes) {
          events.push(change.event);
        }
      }
    },
    (end) => {
      ends.push(end);
    },
  );
  // A refusal ends the subscription on a later turn, so let it land before reading the result.
  await crossMacrotaskBoundary();
  unsubscribe();
  return { events, ends };
}
