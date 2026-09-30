// Reading an input ask off a row's open payload, and refusing everything else.

import { describe, expect, it } from "vitest";

import { sampleGeneralRow, sampleRunRow } from "@test/helpers/timeline-row-samples.js";
import { applyQuestionSettlement, readQuestion, type QuestionReading } from "./question-reading.js";

/** The run every sample row carries, restated so a case can assert it. */
const SAMPLE_RUN_ID = "01J0000000000000000000000B";

/** One `driver_ask` row, with the members the wire shape declares. */
function askRow(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): ReturnType<typeof sampleRunRow> {
  return sampleRunRow({ type, payload: { askId: "ask-01", kind: "input", ...payload } });
}

/**
 * The reading a row produces, or a failure naming the row that produced none.
 *
 * The cases below are about what a reading BECOMES, so a row this reader refuses is a
 * defect in the case rather than the thing under test — and an optional chain would
 * quietly assert `undefined` against `undefined` and pass.
 */
function readAsk(row: ReturnType<typeof sampleRunRow>): QuestionReading {
  const reading = readQuestion(row);
  if (reading === undefined) {
    throw new Error(`the sample row ${row.type} produced no ask reading`);
  }
  return reading;
}

describe("readQuestion", () => {
  it("reads the ask's own members wire-verbatim", () => {
    const ask = readQuestion(
      askRow("driver_ask.requested", {
        prompt: "Which branch should this land on?",
        expiresAt: "2026-09-02T10:05:00.000Z",
        options: [{ value: "develop", label: "The integration branch" }, { value: "main" }],
      }),
    );
    expect(ask).toEqual({
      askId: "ask-01",
      // Off the row's own arm rather than the payload — the projection is where a run
      // is attributed, and the answer this card dispatches is addressed by it.
      runId: SAMPLE_RUN_ID,
      state: "requested",
      prompt: "Which branch should this land on?",
      options: [
        { value: "develop", label: "The integration branch" },
        { value: "main", label: undefined },
      ],
      expiresAt: "2026-09-02T10:05:00.000Z",
      deliveredAnswer: undefined,
    });
  });

  it("names the state from the row's own event type on every arm", () => {
    expect(readQuestion(askRow("driver_ask.responded", { response: "develop" }))?.state).toBe(
      "responded",
    );
    expect(readQuestion(askRow("driver_ask.canceled", {}))?.state).toBe("canceled");
  });

  it("shows a delivered answer only on the row that carries one", () => {
    expect(
      readQuestion(askRow("driver_ask.responded", { response: "develop" }))?.deliveredAnswer,
    ).toBe("develop");
    // A `requested` row carrying a stray `response` is an emitter defect, and the
    // card must not render an answer for an ask that is still open.
    expect(
      readQuestion(askRow("driver_ask.requested", { response: "develop" }))?.deliveredAnswer,
    ).toBeUndefined();
  });

  // THE NEGATIVE CONTROL for the routing rule: a permission ask belongs to the
  // approval flow, and the transcript card must refuse it rather than draw a second
  // decision card for one approval.
  it("refuses a permission-kind ask", () => {
    expect(
      readQuestion(
        sampleRunRow({
          type: "driver_ask.requested",
          payload: { askId: "ask-02", kind: "permission", prompt: "Run this command?" },
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses an ask whose kind this build does not know", () => {
    expect(
      readQuestion(
        sampleRunRow({
          type: "driver_ask.requested",
          payload: { askId: "ask-03", kind: "elicit" },
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a row of another type entirely", () => {
    expect(readQuestion(sampleRunRow({ type: "assistant.message" }))).toBeUndefined();
    expect(readQuestion(sampleGeneralRow())).toBeUndefined();
  });

  it("refuses an ask row carrying no usable identifier", () => {
    expect(
      readQuestion(sampleRunRow({ type: "driver_ask.requested", payload: { kind: "input" } })),
    ).toBeUndefined();
  });

  it("drops an unusable option rather than repairing it, and synthesizes none", () => {
    const ask = readQuestion(
      askRow("driver_ask.requested", {
        options: [{ label: "no value at all" }, "not an object", { value: "keep-me" }, null],
      }),
    );
    expect(ask?.options).toEqual([{ value: "keep-me", label: undefined }]);
  });

  it("reports no options where the ask declared none", () => {
    expect(readQuestion(askRow("driver_ask.requested", {}))?.options).toEqual([]);
    expect(readQuestion(askRow("driver_ask.requested", { options: "develop" }))?.options).toEqual(
      [],
    );
  });
});

describe("applyQuestionSettlement", () => {
  it("takes the disposition from the terminal and the question from the request", () => {
    const request = readAsk(
      askRow("driver_ask.requested", {
        prompt: "Which branch should this land on?",
        expiresAt: "2026-09-02T10:05:00.000Z",
        options: [{ value: "develop" }],
      }),
    );
    const terminal = readAsk(askRow("driver_ask.responded", { response: "develop" }));
    expect(applyQuestionSettlement(request, terminal)).toStrictEqual({
      askId: "ask-01",
      runId: SAMPLE_RUN_ID,
      state: "responded",
      prompt: "Which branch should this land on?",
      options: [{ value: "develop", label: undefined }],
      expiresAt: "2026-09-02T10:05:00.000Z",
      deliveredAnswer: "develop",
    });
  });

  it("negative control: a cancellation does not blank the question the request carried", () => {
    // Without the member-wise merge, taking the terminal reading whole would replace a
    // prompt the reader is looking at with the card's "this ask carried no question".
    const request = readAsk(askRow("driver_ask.requested", { prompt: "Which branch?" }));
    const settled = applyQuestionSettlement(request, readAsk(askRow("driver_ask.canceled", {})));
    expect(settled.prompt).toBe("Which branch?");
    expect(settled.state).toBe("canceled");
    expect(settled.deliveredAnswer).toBeUndefined();
  });

  it("returns the reading unchanged with no terminal, and on a terminal row's own", () => {
    const request = readAsk(askRow("driver_ask.requested", { prompt: "Which branch?" }));
    expect(applyQuestionSettlement(request, undefined)).toBe(request);
    const terminal = readAsk(askRow("driver_ask.responded", { response: "develop" }));
    expect(applyQuestionSettlement(terminal, terminal)).toBe(terminal);
  });
});
