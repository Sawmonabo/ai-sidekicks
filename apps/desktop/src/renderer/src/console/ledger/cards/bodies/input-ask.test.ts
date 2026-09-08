// Reading an input ask off a row's open payload, and refusing everything else.

import { describe, expect, it } from "vitest";

import { sampleGeneralRow, sampleRunRow } from "../row-samples.test-support.js";
import {
  askSettledBy,
  deriveDriverAskTerminals,
  readDriverAsk,
  type DriverAskReading,
} from "./input-ask.js";

/** One `driver_ask` row, with the members the wire shape declares. */
function askRow(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): ReturnType<typeof sampleRunRow> {
  return sampleRunRow({ type, payload: { askId: "ask-01", kind: "input", ...payload } });
}

/** One `driver_ask` row under its own row id, for the window folds below. */
function askRowWithId(
  rowId: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): ReturnType<typeof sampleRunRow> {
  return sampleRunRow({ id: rowId, type, payload: { kind: "input", ...payload } });
}

/**
 * The reading a row produces, or a failure naming the row that produced none.
 *
 * The cases below are about what a reading BECOMES, so a row this reader refuses is a
 * defect in the case rather than the thing under test — and an optional chain would
 * quietly assert `undefined` against `undefined` and pass.
 */
function readAsk(row: ReturnType<typeof sampleRunRow>): DriverAskReading {
  const reading = readDriverAsk(row);
  if (reading === undefined) {
    throw new Error(`the sample row ${row.type} produced no ask reading`);
  }
  return reading;
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

describe("deriveDriverAskTerminals", () => {
  it("keys every settled ask in the window by its own identifier", () => {
    const terminals = deriveDriverAskTerminals([
      askRowWithId("row-01", "driver_ask.requested", { askId: "ask-01", prompt: "Which branch?" }),
      askRowWithId("row-02", "driver_ask.responded", { askId: "ask-01", response: "develop" }),
      askRowWithId("row-03", "driver_ask.requested", { askId: "ask-02", prompt: "Which host?" }),
      askRowWithId("row-04", "driver_ask.expired", { askId: "ask-03" }),
    ]);
    expect([...terminals.keys()]).toStrictEqual(["ask-01", "ask-03"]);
    expect(terminals.get("ask-01")?.state).toBe("responded");
    expect(terminals.get("ask-01")?.deliveredAnswer).toBe("develop");
    expect(terminals.get("ask-03")?.state).toBe("expired");
  });

  it("negative control: an open ask reaches the map through no row", () => {
    // Without this, a fold that admitted the request row would hand every open ask a
    // terminal and every ask card would be settled the moment it was asked.
    const terminals = deriveDriverAskTerminals([
      askRowWithId("row-01", "driver_ask.requested", { askId: "ask-01", prompt: "Which branch?" }),
    ]);
    expect(terminals.size).toBe(0);
  });

  it("keeps the FIRST terminal, so a late cancellation cannot overwrite an answer", () => {
    const terminals = deriveDriverAskTerminals([
      askRowWithId("row-01", "driver_ask.responded", { askId: "ask-01", response: "develop" }),
      askRowWithId("row-02", "driver_ask.canceled", { askId: "ask-01" }),
    ]);
    expect(terminals.get("ask-01")?.state).toBe("responded");
  });

  it("reads no ask out of a permission row or a row of another type", () => {
    const terminals = deriveDriverAskTerminals([
      sampleRunRow({
        id: "row-01",
        type: "driver_ask.responded",
        payload: { askId: "ask-01", kind: "permission", response: "allow" },
      }),
      sampleRunRow({ id: "row-02", type: "assistant.message" }),
      sampleGeneralRow({ id: "row-03" }),
    ]);
    expect(terminals.size).toBe(0);
  });
});

describe("askSettledBy", () => {
  it("takes the disposition from the terminal and the question from the request", () => {
    const request = readAsk(
      askRow("driver_ask.requested", {
        prompt: "Which branch should this land on?",
        expiresAt: "2026-09-02T10:05:00.000Z",
        options: [{ value: "develop" }],
      }),
    );
    const terminal = readAsk(askRow("driver_ask.responded", { response: "develop" }));
    expect(askSettledBy(request, terminal)).toStrictEqual({
      askId: "ask-01",
      state: "responded",
      prompt: "Which branch should this land on?",
      options: [{ value: "develop", label: undefined }],
      expiresAt: "2026-09-02T10:05:00.000Z",
      deliveredAnswer: "develop",
    });
  });

  it("negative control: an expiry does not blank the question the request carried", () => {
    // Without the member-wise merge, taking the terminal reading whole would replace a
    // prompt the reader is looking at with the card's "this ask carried no question".
    const request = readAsk(askRow("driver_ask.requested", { prompt: "Which branch?" }));
    const settled = askSettledBy(request, readAsk(askRow("driver_ask.expired", {})));
    expect(settled.prompt).toBe("Which branch?");
    expect(settled.state).toBe("expired");
    expect(settled.deliveredAnswer).toBeUndefined();
  });

  it("returns the reading unchanged with no terminal, and on a terminal row's own", () => {
    const request = readAsk(askRow("driver_ask.requested", { prompt: "Which branch?" }));
    expect(askSettledBy(request, undefined)).toBe(request);
    const terminal = readAsk(askRow("driver_ask.responded", { response: "develop" }));
    expect(askSettledBy(terminal, terminal)).toBe(terminal);
  });
});
