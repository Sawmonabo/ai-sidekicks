// A run's facts as the session store holds them: the header's word and the controls' state are
// written together from one event, a newer position keeps its state against an older window's
// reply, and a state change naming another state than it announces moves neither.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import {
  isTranscriptRunEnded,
  runStateOfEventType,
  transcriptRunHeaderStateOf,
} from "@ai-sidekicks/contracts/transcript/run-facts";
import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import type { ProjectedSessionEvent } from "../../entities/vocabulary.js";
import { SessionStore } from "../../store.js";
import { RUN_LIFECYCLE_PROJECTORS } from "./lifecycle-projector.js";

const SESSION_ID = "session-run-facts";
const RUN_ID = "11111111-2222-4333-8444-555555555555";

/** One of the run's own events at `sequence`; a `run.<state>` kind names the state it announces. */
function runEventAt(
  kind: string,
  sequence: number,
  members: Readonly<Record<string, unknown>> = {},
): ProjectedSessionEvent {
  const announcedState = runStateOfEventType(kind);
  return eventOfKind(SESSION_ID, kind, sequence, {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    ...(announcedState === undefined ? {} : { newState: announcedState }),
    ...members,
  });
}

/** The header word, the controls' state and whether the run has ended, as the store holds them. */
function runReadingOf(store: SessionStore): {
  readonly header: string | undefined;
  readonly controls: string | undefined;
  readonly isEnded: boolean;
} {
  const run = store.snapshot().partitions.run[RUN_ID] ?? expect.fail("the store holds the run");
  const facts = run.runFacts ?? expect.fail("the store holds the run's facts");
  return {
    header: transcriptRunHeaderStateOf(facts),
    controls: run.state,
    isEnded: isTranscriptRunEnded(facts),
  };
}

/** A store with the run projector following the stream past rows 5 through 9, none the run's. */
function storeFollowingTheStream(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID, projectors: RUN_LIFECYCLE_PROJECTORS });
  store.initialize({
    cursor: 9,
    entities: [],
    transcript: [5, 6, 7, 8, 9].map((sequence) =>
      eventOfKind(SESSION_ID, "assistant.message", sequence),
    ),
    transcriptHead: { cursor: "cursor-at-4" as EventCursor, hasMore: true },
  });
  return store;
}

describe("a run's facts in the session store", () => {
  it("keeps a live ending against an older window's facts and rows, header and controls alike", () => {
    const store = storeFollowingTheStream();
    store.applyBatch([runEventAt("run.completed", 10)]);

    // The page was read before the run ended: its facts and its rows say the run is running.
    store.prependEarlierEvents({
      events: [
        runEventAt("run.queued", 1),
        { ...runEventAt("run.running", 2), actorId: "agent-1" },
      ],
      edge: { cursor: undefined, hasMore: false },
      runs: [
        {
          runId: RUN_ID as RunId,
          actor: "agent-1",
          stateEventType: "run.running",
          isRewound: false,
          foldedThroughSequence: 4,
        },
      ],
    });

    expect(runReadingOf(store)).toStrictEqual({
      header: "run.completed",
      controls: "completed",
      isEnded: true,
    });
    // The actor the older facts name is kept beside the newer state.
    expect(store.snapshot().partitions.run[RUN_ID]?.runFacts?.actor).toBe("agent-1");
  });

  it("moves neither the header nor the controls on a state change naming another state", () => {
    const store = storeFollowingTheStream();
    store.applyBatch([runEventAt("run.waiting_for_approval", 10)]);
    store.applyBatch([runEventAt("run.running", 11, { newState: "failed" })]);

    expect(runReadingOf(store)).toStrictEqual({
      header: "run.waiting_for_approval",
      controls: "waiting_for_approval",
      isEnded: false,
    });
  });

  it("takes the header's word and the controls' state from one event", () => {
    const store = storeFollowingTheStream();
    store.applyBatch([runEventAt("run.running", 10)]);
    // A page read while the stream lagged serves facts through a run event it has not delivered.
    store.prependEarlierEvents({
      events: [runEventAt("run.queued", 1)],
      edge: { cursor: undefined, hasMore: false },
      runs: [
        {
          runId: RUN_ID as RunId,
          stateEventType: "run.completed",
          isRewound: false,
          foldedThroughSequence: 12,
        },
      ],
    });
    // The stream catching up delivers an older state: neither the header nor the controls take it.
    store.applyBatch([runEventAt("run.waiting_for_input", 11)]);
    expect(runReadingOf(store)).toStrictEqual({
      header: "run.completed",
      controls: "completed",
      isEnded: true,
    });

    // A rewind clears the header's word while the controls keep the state it rewound.
    store.applyBatch([runEventAt("run.completed", 12), runEventAt("run.paused", 13)]);
    store.applyBatch([runEventAt("run.rolled_back", 14)]);
    expect(runReadingOf(store)).toStrictEqual({
      header: undefined,
      controls: "paused",
      isEnded: false,
    });
  });
});
