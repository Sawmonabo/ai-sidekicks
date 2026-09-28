// The framing itself: what it says beyond the card.
//
// The pane's own file proves the framing reaches the right card and no other; this
// one proves what is IN it — the provenance sentence and the requested resource
// rendered inline rather than behind the card's disclosure. Both are claims about one
// component's output, so they are checked over one component.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderAskFraming } from "./ProviderAskFraming.js";

describe("what the framing says beyond the card", () => {
  it("names the ask and shows the requested resource inline", () => {
    const { container } = render(
      <ProviderAskFraming
        ask={{ askId: "ask-force-push" }}
        requestedResource={{ command: "git push --force origin feature/rebased" }}
      />,
    );

    expect(container.querySelector(".meridian-approval-ask__origin")?.textContent).toContain(
      "ask-force-push",
    );
    // Inline, above the action row, because for a permission ask the resource is the
    // whole question — and rendered through the one module the card's disclosure
    // uses, so the two placements cannot say different things.
    const inline = container.querySelector(".meridian-approval-ask__input");
    expect(inline?.textContent).toContain("git push --force origin feature/rebased");
  });

  it("says an empty descriptor is empty rather than rendering a blank panel", () => {
    render(<ProviderAskFraming ask={{ askId: "ask-force-push" }} requestedResource={{}} />);

    expect(screen.getByText(/descriptor with nothing in it/u)).not.toBeNull();
  });
});
