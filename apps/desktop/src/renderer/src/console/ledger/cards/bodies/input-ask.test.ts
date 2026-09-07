// Reading an input ask off a row's open payload, and refusing everything else.

import { describe, expect, it } from "vitest";

import { sampleGeneralRow, sampleRunRow } from "../row-samples.test-support.js";
import { readDriverAsk } from "./input-ask.js";

/** One `driver_ask` row, with the members the wire shape declares. */
function askRow(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): ReturnType<typeof sampleRunRow> {
  return sampleRunRow({ type, payload: { askId: "ask-01", kind: "input", ...payload } });
}

describe("readDriverAsk", () => {
  it("reads the ask's own members wire-verbatim", () => {
    const ask = readDriverAsk(
      askRow("driver_ask.requested", {
        prompt: "Which branch should this land on?",
        expiresAt: "2026-09-02T10:05:00.000Z",
        options: [{ value: "develop", label: "The integration branch" }, { value: "main" }],
      }),
    );
    expect(ask).toEqual({
      askId: "ask-01",
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
    expect(readDriverAsk(askRow("driver_ask.responded", { response: "develop" }))?.state).toBe(
      "responded",
    );
    expect(readDriverAsk(askRow("driver_ask.expired", {}))?.state).toBe("expired");
    expect(readDriverAsk(askRow("driver_ask.canceled", {}))?.state).toBe("canceled");
  });

  it("shows a delivered answer only on the row that carries one", () => {
    expect(
      readDriverAsk(askRow("driver_ask.responded", { response: "develop" }))?.deliveredAnswer,
    ).toBe("develop");
    // A `requested` row carrying a stray `response` is an emitter defect, and the
    // card must not render an answer for an ask that is still open.
    expect(
      readDriverAsk(askRow("driver_ask.requested", { response: "develop" }))?.deliveredAnswer,
    ).toBeUndefined();
  });

  // THE NEGATIVE CONTROL for the routing rule: a permission ask belongs to the
  // approvals surface, and the ledger card must refuse it rather than draw a second
  // decision surface for one approval.
  it("refuses a permission-kind ask", () => {
    expect(
      readDriverAsk(
        sampleRunRow({
          type: "driver_ask.requested",
          payload: { askId: "ask-02", kind: "permission", prompt: "Run this command?" },
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses an ask whose kind this build does not know", () => {
    expect(
      readDriverAsk(
        sampleRunRow({
          type: "driver_ask.requested",
          payload: { askId: "ask-03", kind: "elicit" },
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a row of another type entirely", () => {
    expect(readDriverAsk(sampleRunRow({ type: "assistant.message" }))).toBeUndefined();
    expect(readDriverAsk(sampleGeneralRow())).toBeUndefined();
  });

  it("refuses an ask row carrying no usable identifier", () => {
    expect(
      readDriverAsk(sampleRunRow({ type: "driver_ask.requested", payload: { kind: "input" } })),
    ).toBeUndefined();
  });

  it("drops an unusable option rather than repairing it, and synthesizes none", () => {
    const ask = readDriverAsk(
      askRow("driver_ask.requested", {
        options: [{ label: "no value at all" }, "not an object", { value: "keep-me" }, null],
      }),
    );
    expect(ask?.options).toEqual([{ value: "keep-me", label: undefined }]);
  });

  it("reports no options where the ask declared none", () => {
    expect(readDriverAsk(askRow("driver_ask.requested", {}))?.options).toEqual([]);
    expect(readDriverAsk(askRow("driver_ask.requested", { options: "develop" }))?.options).toEqual(
      [],
    );
  });
});
