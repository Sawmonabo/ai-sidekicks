// Reading an agent's question off a `question.asked` row, and refusing everything else.

import { describe, expect, it } from "vitest";

import { sampleGeneralRow, sampleRunRow } from "@test/helpers/timeline-row-samples.js";
import { readQuestion } from "./question-reading.js";

/** The run every sample row carries, restated so a case can assert it. */
const SAMPLE_RUN_ID = "01J0000000000000000000000B";

const SAMPLE_QUESTION_ID = "019b793b-7b60-7a21-9f14-6b0c2a7d0e11";

describe("readQuestion", () => {
  it("reads the question record's plain half and its run", () => {
    const question = readQuestion(
      sampleRunRow({
        type: "question.asked",
        payload: { questionId: SAMPLE_QUESTION_ID, runId: SAMPLE_RUN_ID, pageCount: 2 },
      }),
    );
    expect(question).toEqual({
      questionId: SAMPLE_QUESTION_ID,
      // Off the row's own arm: the projection is where a run is attributed.
      runId: SAMPLE_RUN_ID,
      pageCount: 2,
    });
  });

  it("reads a workflow step's question on the general arm with no run", () => {
    expect(
      readQuestion(
        sampleGeneralRow({
          type: "question.asked",
          payload: { questionId: SAMPLE_QUESTION_ID, pageCount: 1 },
        }),
      )?.runId,
    ).toBeUndefined();
  });

  it("refuses a row of another type, and a question row missing its id", () => {
    expect(
      readQuestion(
        sampleRunRow({
          type: "approval.requested",
          payload: { questionId: SAMPLE_QUESTION_ID, pageCount: 1 },
        }),
      ),
    ).toBeUndefined();
    expect(
      readQuestion(sampleRunRow({ type: "question.asked", payload: { pageCount: 1 } })),
    ).toBeUndefined();
  });
});
