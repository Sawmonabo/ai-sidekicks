// What the framing says beyond the card: the provenance sentence and the requested resource
// rendered inline rather than behind the card's disclosure.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderAskDetails } from "./ProviderAskDetails.js";

describe("what the framing says beyond the card", () => {
  it("names the ask and shows the requested resource inline", () => {
    const { container } = render(
      <ProviderAskDetails
        ask={{ askId: "ask-force-push" }}
        requestedResource={{ command: "git push --force origin feature/rebased" }}
      />,
    );

    expect(container.querySelector(".meridian-approval-ask__origin")?.textContent).toContain(
      "ask-force-push",
    );
    // Inline, above the action row: for a permission ask the resource is the whole question.
    const inline = container.querySelector(".meridian-approval-ask__input");
    expect(inline?.textContent).toContain("git push --force origin feature/rebased");
  });

  it("says an empty descriptor is empty rather than rendering a blank panel", () => {
    render(<ProviderAskDetails ask={{ askId: "ask-force-push" }} requestedResource={{}} />);

    expect(screen.getByText(/descriptor with nothing in it/u)).not.toBeNull();
  });
});
