// The turn each event of a run is stamped with: the daemon stamps a run's events by the same case
// table, parsed strictly here with zod, so a reader stamping a log marks the same turns superseded.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import type { EventCategory } from "../../generated/event/envelope.js";
import type { RunId } from "../../generated/run/id.js";
import {
  addSupersedingCut,
  stampedSourceOf,
  standingAfterRollback,
  standingAfterTurnStarted,
  transcriptRunStampAt,
  transcriptToolCallIdOf,
} from "../turn-attribution.js";

const wholeNumber = z.int().nonnegative();
const epochPosition = z.object({ epoch: wholeNumber, position: wholeNumber }).strict();
const supersededTurns = z
  .object({
    runId: z.string().transform((runId) => runId as RunId),
    cuts: z.array(z.object({ sourceEpoch: wholeNumber, point: wholeNumber }).strict()),
  })
  .strict();
const payload = z.record(z.string(), z.unknown());

const turnAttributionCases = readCaseTable(
  z.array(
    z.discriminatedUnion("step", [
      z
        .object({
          step: z.literal("addSupersedingCut"),
          note: z.string(),
          turns: supersededTurns,
          point: wholeNumber,
          expected: supersededTurns,
        })
        .strict(),
      z
        .object({
          step: z.literal("transcriptRunStampAt"),
          note: z.string(),
          turns: supersededTurns,
          source: epochPosition,
          expected: z
            .object({
              position: wholeNumber,
              epoch: wholeNumber,
              superseded: z.object({ targetPosition: wholeNumber }).strict().optional(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          step: z.literal("standingAfterTurnStarted"),
          note: z.string(),
          standing: epochPosition,
          payload,
          expected: epochPosition,
        })
        .strict(),
      z
        .object({
          step: z.literal("standingAfterRollback"),
          note: z.string(),
          standing: epochPosition,
          targetPosition: wholeNumber,
          expected: epochPosition,
        })
        .strict(),
      z
        .object({
          step: z.literal("stampedSourceOf"),
          note: z.string(),
          payload,
          expected: epochPosition.nullable(),
        })
        .strict(),
      z
        .object({
          step: z.literal("transcriptToolCallIdOf"),
          note: z.string(),
          category: z
            .string()
            .nullable()
            .transform((category) => category as EventCategory | null),
          payload,
          expected: z.string().nullable(),
        })
        .strict(),
    ]),
  ),
  "transcript/turn-attribution.json",
);

/** What one case's step answers, `undefined` written as the table's `null`. */
function stepAnswer(turnCase: (typeof turnAttributionCases)[number]): unknown {
  switch (turnCase.step) {
    case "addSupersedingCut":
      return addSupersedingCut(turnCase.turns, turnCase.point);
    case "transcriptRunStampAt":
      return transcriptRunStampAt(turnCase.turns, turnCase.source);
    case "standingAfterTurnStarted":
      return standingAfterTurnStarted(turnCase.standing, turnCase.payload);
    case "standingAfterRollback":
      return standingAfterRollback(turnCase.standing, turnCase.targetPosition);
    case "stampedSourceOf":
      return stampedSourceOf(turnCase.payload) ?? null;
    case "transcriptToolCallIdOf":
      return transcriptToolCallIdOf(turnCase.category ?? undefined, turnCase.payload) ?? null;
  }
}

describe("stamping a run's turns", () => {
  it.each(turnAttributionCases)("$step: $note", (turnCase) => {
    expect(stepAnswer(turnCase)).toStrictEqual(turnCase.expected);
  });
});
