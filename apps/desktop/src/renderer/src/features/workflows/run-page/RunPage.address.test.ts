// The address guard: which subjects this pane will open, and what it does with the
// rest.
//
// The pane layout hands a pane whichever entity its layout carried, and the run pane can be
// pointed at a workflow definition, so "will not open" has to be a refusal the pane
// states.

import { describe, expect, it } from "vitest";

import { ADDRESSED_RUN, MISADDRESSED, paneContext, renderRunPage } from "./RunPage.test-support.js";

describe("workflow run pane — with an address that names no run", () => {
  it("refuses the address rather than reading a definition id as a run id", () => {
    // An id taken off any kind at all would present a definition as a run.
    const section = renderRunPage(paneContext(MISADDRESSED));

    expect(section.querySelector(".meridian-refusal--banner")).not.toBeNull();
    expect(section.textContent ?? "").toContain("pane-address-invalid");
  });

  it("negative control: the same pane opens the kind it does show", () => {
    // Without this, the case above passes over a pane that refused every address. An
    // addressed run draws the strip's summary line and no absence of any kind.
    const section = renderRunPage(paneContext(ADDRESSED_RUN));

    expect(section.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(section.querySelector(".meridian-workflow__summary")?.textContent ?? "").toContain(
      "One run's state",
    );
    expect(section.querySelector(".meridian-nothing")).toBeNull();
  });
});
