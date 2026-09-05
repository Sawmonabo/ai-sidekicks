// The framing itself: what it says beyond the card, and what it never invents.
//
// The pane's own file proves the framing reaches the right card and no other; this
// one proves what is IN it — the two sentences that exist only here, and the
// requested resource rendered inline rather than behind the card's disclosure. Both
// are claims about one component's output, so they are checked over one component.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderAskFraming } from "./ProviderAskFraming.js";

/**
 * 2026-01-01T13:30:00Z, so the deadline below reads as four hours out.
 *
 * Built rather than parsed: a base a test PARSES is a test that reads a stamp, which
 * is the reading the console's own parser owns.
 */
const NOW_MILLISECONDS = Date.UTC(2026, 0, 1, 13, 30);
const EXPIRY = "2026-01-01T17:30:00.000Z";

describe("what the framing says beyond the card", () => {
  it("names the ask and shows the requested resource inline", () => {
    const { container } = render(
      <ProviderAskFraming
        ask={{ askId: "ask-force-push", expiryAt: EXPIRY }}
        requestedResource={{ command: "git push --force origin feature/rebased" }}
        nowMilliseconds={NOW_MILLISECONDS}
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
    // The outcome of silence, which is the one thing a person answering this has to
    // know and which no member of the record says.
    expect(screen.getByText(/never approved by silence/u)).not.toBeNull();
  });

  it("reads the deadline against the clock it was handed and shows the instant too", () => {
    render(
      <ProviderAskFraming
        ask={{ askId: "ask-force-push", expiryAt: EXPIRY }}
        requestedResource={{}}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );

    const deadline = screen.getByText(/Answer needed/u);
    expect(deadline.textContent).toContain("in 4 hours");
    // The exact instant stays on screen beside the reading: no formatted figure hides
    // the value the daemon sent.
    expect(deadline.textContent).toContain(EXPIRY);
  });

  it("says an empty descriptor is empty rather than rendering a blank panel", () => {
    render(
      <ProviderAskFraming
        ask={{ askId: "ask-force-push", expiryAt: EXPIRY }}
        requestedResource={{}}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );

    expect(screen.getByText(/descriptor with nothing in it/u)).not.toBeNull();
  });

  it("shows no deadline at all where the ask carries none", () => {
    const { container } = render(
      <ProviderAskFraming
        ask={{ askId: "ask-force-push", expiryAt: undefined }}
        requestedResource={{ command: "git push --force" }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );

    expect(container.querySelector(".meridian-approval-ask__deadline")).toBeNull();
    expect(screen.getByText(/without the deadline the wire carries/u)).not.toBeNull();
    // The negative control on the reading itself: nothing anywhere in the framing
    // states a time, so no deadline was invented from another member.
    expect(container.textContent).not.toContain("Answer needed");
    expect(container.textContent).not.toContain("2026-01-01");
  });
});
