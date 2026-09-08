// The per-row control, the window's one menu, and what opening it puts on screen.
//
// The offers themselves are the builder's and the binding's, and both have their own
// suites; what is proved here is the four things only a render can settle — that the
// row wears exactly one control rather than a strip of buttons, that the control names
// the ENTRY it belongs to rather than an opaque id, that pressing an item runs that
// item's own act, and that a window of many rows carries ONE menu which answers for
// whichever row was pressed.
//
// THAT LAST ONE IS A COST CLAIM WITH A BEHAVIOURAL TEST, which is the only kind worth
// keeping. A menu per row is not visibly different from a shared one until you count
// what a viewport of rows retains, so what is asserted here is the property a reader
// can lose if the shape is undone: two rows, one popup, and the offers of the row that
// was actually pressed.
//
// THE MENU'S BEHAVIOUR IS THE LIBRARY'S AND IS NOT RE-ASSERTED HERE. Base UI owns
// the roles, the keyboard walk, Escape, outside press, and focus return; a case
// checking those would be checking a dependency rather than this component, and
// would go red on an upgrade that changed nothing about this file.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { sampleGeneralRow } from "../../../cards/row-samples.test-support.js";
import { LedgerRowMenu } from "./LedgerRowMenu.js";
import { LedgerRowOffersMenu } from "./LedgerRowOffersMenu.js";
import { type LedgerRowOffer } from "./ledger-row-offers.js";
import { type LedgerRowOfferRequest } from "./ledger-row-offers-binding.js";
import { sampleRowOffersBinding } from "./ledger-row-offers-binding.test-support.js";

/** One window: a control per row, and the single menu they all open. */
function renderWindow(
  rows: readonly TimelineRow[],
  answer: (request: LedgerRowOfferRequest) => readonly LedgerRowOffer[],
): HTMLElement {
  const binding = sampleRowOffersBinding(answer);
  const { container } = render(
    <>
      {rows.map((row) => (
        <LedgerRowMenu
          key={row.id}
          row={row}
          density="collapsed"
          chapterRunId={undefined}
          bodyText={undefined}
          pathReference={undefined}
          offers={binding}
        />
      ))}
      <LedgerRowOffersMenu offers={binding} />
    </>,
  );
  return container;
}

/** One row's window, for the cases that are about a single row's control. */
function renderRowMenu(offers: readonly LedgerRowOffer[]): HTMLElement {
  return renderWindow([sampleGeneralRow({ summary: "The session was created." })], () => offers);
}

describe("the row's offer menu", () => {
  it("wears exactly one control, revealed by the row rather than by itself", () => {
    const container = renderRowMenu([]);
    const triggers = container.querySelectorAll("button");
    expect(triggers).toHaveLength(1);
    // The primitives family publishes the reveal slot; nothing in this family
    // writes a hover rule of its own.
    expect(triggers[0]?.className).toContain("meridian-ledger-row__revealed");
  });

  it("names the entry it belongs to, not the entry's opaque id", () => {
    renderRowMenu([]);
    const trigger = screen.getByRole("button", {
      name: "Offers for the entry The session was created.",
    });
    expect(trigger).not.toBeNull();
  });

  it("draws one item per offer, in the order the builder gave them", () => {
    renderRowMenu([
      { kind: "open-row", label: "Open", perform: () => undefined },
      { kind: "copy-row-id", label: "Copy entry id", perform: () => undefined },
      { kind: "copy-body", label: "Copy body", perform: () => undefined },
    ]);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toStrictEqual([
      "Open",
      "Copy entry id",
      "Copy body",
    ]);
  });

  it("runs the pressed offer's own act and no other", () => {
    const openRow = vi.fn();
    const copyBody = vi.fn();
    renderRowMenu([
      { kind: "open-row", label: "Open", perform: openRow },
      { kind: "copy-body", label: "Copy body", perform: copyBody },
    ]);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy body" }));
    expect(copyBody).toHaveBeenCalledTimes(1);
    expect(openRow).not.toHaveBeenCalled();
  });

  it("draws no items at all before it is opened", () => {
    // The negative control for the two cases above: a popup rendered eagerly would
    // put every row's offers in the document for a window of thousands of rows.
    renderRowMenu([{ kind: "open-row", label: "Open", perform: () => undefined }]);
    expect(screen.queryAllByRole("menuitem")).toStrictEqual([]);
  });

  it("carries ONE menu for the whole window, answering for the row that was pressed", () => {
    // The rows differ only in what they are, and the offer names its own row — so a
    // popup filled from anything other than the pressed trigger says so out loud.
    renderWindow(
      [
        sampleGeneralRow({ id: "row-first", summary: "The first entry." }),
        sampleGeneralRow({ id: "row-second", summary: "The second entry." }),
      ],
      (request) => [
        {
          kind: "copy-row-id",
          label: `Offers of ${request.row.summary}`,
          perform: () => undefined,
        },
      ],
    );
    fireEvent.click(screen.getByRole("button", { name: "Offers for the entry The second entry." }));
    // One popup, not one per row: a menu per row would draw a second `menu` the
    // moment two rows were on screen, whether or not either was open.
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toStrictEqual([
      "Offers of The second entry.",
    ]);
  });
});
