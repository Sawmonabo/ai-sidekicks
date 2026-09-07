// The one per-row control, and what opening it puts on screen.
//
// The offers themselves are the builder's and the binding's, and both have their own
// suites; what is proved here is the three things only a render can settle — that
// the row wears exactly one control rather than a strip of buttons, that the control
// names the ENTRY it belongs to rather than an opaque id, and that pressing an item
// runs that item's own act.
//
// THE MENU'S BEHAVIOUR IS THE LIBRARY'S AND IS NOT RE-ASSERTED HERE. Base UI owns
// the roles, the keyboard walk, Escape, outside press, and focus return; a case
// checking those would be checking a dependency rather than this component, and
// would go red on an upgrade that changed nothing about this file.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleGeneralRow } from "../../../cards/row-samples.test-support.js";
import { LedgerRowMenu } from "./LedgerRowMenu.js";
import { type LedgerRowOffer } from "./ledger-row-offers.js";
import { type LedgerRowOffersBinding } from "./ledger-row-offers-binding.js";

/** A binding that answers with exactly the offers a case names. */
function bindingOffering(offers: readonly LedgerRowOffer[]): LedgerRowOffersBinding {
  return { offersFor: () => offers };
}

function renderRowMenu(offers: readonly LedgerRowOffer[]): HTMLElement {
  const { container } = render(
    <LedgerRowMenu
      row={sampleGeneralRow({ summary: "The session was created." })}
      density="collapsed"
      chapterRunId={undefined}
      bodyText={undefined}
      pathReference={undefined}
      offers={bindingOffering(offers)}
    />,
  );
  return container;
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
});
