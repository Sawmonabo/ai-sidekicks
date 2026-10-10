// The one fold of a run's facts, which the daemon serves and a client continues: who acts for the
// run, the state its header and controls read, and when it has ended.
import { describe, expect, it } from "vitest";

import {
  UNFOLDED_TRANSCRIPT_RUN_FACTS,
  foldTranscriptRunFacts,
  isTranscriptRunEnded,
  transcriptRunHeaderStateOf,
  transcriptRunStateOf,
  type TranscriptRunBeat,
  type TranscriptRunFactsFold,
} from "../run-facts.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

// One beat of the run at `sequence`: a `run.<state>` beat names the state its type announces.
const beat = (
  sequence: number,
  type: string,
  members: Partial<TranscriptRunBeat> = {},
): TranscriptRunBeat => {
  const announced = type.startsWith("run.") ? type.slice("run.".length) : undefined;
  return { sequence, type, payload: { runId: RUN_ID, newState: announced }, ...members };
};

const foldAll = (beats: readonly TranscriptRunBeat[]): TranscriptRunFactsFold =>
  beats.reduce(foldTranscriptRunFacts, UNFOLDED_TRANSCRIPT_RUN_FACTS);

describe("a run's facts", () => {
  it("take the first actor and account, never a person's message, and keep what they hold", () => {
    const facts = foldAll([
      beat(1, "run.queued", { payload: { runId: RUN_ID, admittedProviderAccountId: "acct-1" } }),
      beat(2, "user.message", { actor: "user-1" }),
      beat(3, "approval.requested", { actor: "agent-1" }),
      beat(4, "tool.call", { actor: "agent-2" }),
      // Only the creation names the account, so a later beat naming one cannot move who pays.
      beat(5, "run.running", {
        payload: { runId: RUN_ID, newState: "running", admittedProviderAccountId: "acct-9" },
      }),
    ]);
    expect(facts).toStrictEqual({
      actor: "agent-1",
      admittedProviderAccountId: "acct-1",
      stateEventType: "run.running",
      isRewound: false,
      foldedThroughSequence: 5,
    });
    // A beat that changes no fact keeps the facts' object and their position.
    expect(foldTranscriptRunFacts(facts, beat(6, "tool.call", { actor: "agent-3" }))).toBe(facts);
    // A wrongly typed account reads as none rather than being coerced.
    expect(
      foldAll([beat(1, "run.queued", { payload: { runId: RUN_ID, admittedProviderAccountId: 7 } })])
        .admittedProviderAccountId,
    ).toBeUndefined();
    // A beat at or below what they hold changes nothing, so an older event cannot undo a newer one.
    expect(foldTranscriptRunFacts(facts, beat(3, "run.failed"))).toBe(facts);
    expect(foldTranscriptRunFacts(facts, beat(2, "run.completed"))).toBe(facts);
  });

  it("refuse a state change whose payload names another state", () => {
    const running = foldAll([beat(1, "run.queued"), beat(2, "run.running")]);
    const malformed = foldTranscriptRunFacts(
      running,
      beat(3, "run.running", { payload: { runId: RUN_ID, newState: "failed" } }),
    );
    expect(transcriptRunStateOf(malformed)).toBe("running");
    expect(transcriptRunHeaderStateOf(malformed)).toBe("run.running");
    expect(
      transcriptRunStateOf(
        foldTranscriptRunFacts(running, beat(3, "run.failed", { payload: { runId: RUN_ID } })),
      ),
    ).toBe("running");
  });

  it("keep a rewound state for the controls, clear the header's word, and reopen an ended run", () => {
    const completed = foldAll([beat(1, "run.queued"), beat(2, "run.completed")]);
    expect(isTranscriptRunEnded(completed)).toBe(true);

    const pausedThenRewound = foldAll([
      beat(1, "run.queued"),
      beat(2, "run.completed"),
      beat(3, "run.paused"),
      beat(4, "run.rolled_back"),
    ]);
    expect(transcriptRunStateOf(pausedThenRewound)).toBe("paused");
    expect(transcriptRunHeaderStateOf(pausedThenRewound)).toBeUndefined();
    expect(isTranscriptRunEnded(pausedThenRewound)).toBe(false);

    const rewoundCompletion = foldTranscriptRunFacts(completed, beat(3, "run.rolled_back"));
    expect(isTranscriptRunEnded(rewoundCompletion)).toBe(false);
    // The next state ends the rewind.
    const resumed = foldTranscriptRunFacts(rewoundCompletion, beat(4, "run.running"));
    expect(transcriptRunHeaderStateOf(resumed)).toBe("run.running");
    // A run that came back ends again at its next ending.
    expect(isTranscriptRunEnded(foldTranscriptRunFacts(resumed, beat(5, "run.failed")))).toBe(true);
    // A row that reports no state leaves an ended run ended.
    expect(
      isTranscriptRunEnded(foldTranscriptRunFacts(completed, beat(3, "run.worker_shutdown"))),
    ).toBe(true);
  });
});
