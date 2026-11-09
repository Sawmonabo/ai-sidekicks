// The one fold of a run's facts, which the daemon serves and a client continues: who acts for the
// run, the state its header and controls read, and when it has ended. The daemon's fold reads the
// same case table, parsed strictly here with zod, so both sides fold a run's events alike.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { RUN_STATE_EVENT_TYPES } from "../../generated/transcript/operations.js";
import {
  UNFOLDED_TRANSCRIPT_RUN_FACTS,
  foldTranscriptRunFacts,
  isTranscriptRunEnded,
  transcriptRunHeaderStateOf,
  transcriptRunStateOf,
  type TranscriptRunBeat,
  type TranscriptRunFactsFold,
} from "../run-facts.js";

const runStateEventTypeSchema = z.enum(RUN_STATE_EVENT_TYPES);

const runFactsCases = readCaseTable(
  z.array(
    z
      .object({
        note: z.string(),
        beats: z.array(
          z
            .object({
              type: z.string(),
              sequence: z.int().nonnegative(),
              actor: z.string().nullable(),
              payload: z.record(z.string(), z.unknown()).nullable(),
            })
            .strict(),
        ),
        facts: z
          .object({
            actor: z.string().optional(),
            admittedProviderAccountId: z.string().optional(),
            stateEventType: runStateEventTypeSchema.optional(),
            isRewound: z.boolean(),
            foldedThroughSequence: z.int().min(-1),
          })
          .strict(),
        state: z.string().nullable(),
        headerState: runStateEventTypeSchema.nullable(),
        isEnded: z.boolean(),
      })
      .strict(),
  ),
  "transcript/run-facts.json",
);

const foldAll = (beats: readonly TranscriptRunBeat[]): TranscriptRunFactsFold =>
  beats.reduce(foldTranscriptRunFacts, UNFOLDED_TRANSCRIPT_RUN_FACTS);

describe("a run's facts", () => {
  it.each(runFactsCases)("$note", ({ beats, facts, state, headerState, isEnded }) => {
    const folded = foldAll(beats.map((beat) => ({ ...beat, payload: beat.payload ?? undefined })));
    expect(folded).toStrictEqual(facts);
    expect(transcriptRunStateOf(folded) ?? null).toBe(state);
    expect(transcriptRunHeaderStateOf(folded) ?? null).toBe(headerState);
    expect(isTranscriptRunEnded(folded)).toBe(isEnded);
  });

  // A holder keyed on identity sees no change from a beat that changes no fact, or one at or
  // below what the facts already hold.
  it("keeps the facts' object for a beat that changes nothing", () => {
    const facts = foldAll([
      {
        type: "agent.run.running",
        sequence: 2,
        actor: "agent-a",
        payload: { newState: "running" },
      },
    ]);
    expect(foldTranscriptRunFacts(facts, { type: "agent.message.sent", sequence: 3 })).toBe(facts);
    expect(foldTranscriptRunFacts(facts, { type: "agent.run.failed", sequence: 1 })).toBe(facts);
  });
});
