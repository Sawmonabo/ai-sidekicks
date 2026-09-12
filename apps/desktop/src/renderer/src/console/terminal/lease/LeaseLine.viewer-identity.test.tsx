// The claim control is gated on knowing which window this is.
//
// The last of the line's prohibitions, and its own file because it is the one that
// withholds the control entirely: the surface acts on this window's behalf and the fold
// names the holder by user id, so until that identity has been READ there is no
// control here at all. A control offered without it is one the daemon will honour and
// this line will then report as a hold from somewhere else.
//
// Nothing else gates it. The shell belongs to the one person using this machine.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { leaseState, refusingBridge, renderLease } from "./LeaseLine.test-support.js";
import { OTHER_USER, VIEWER_USER } from "./lease-model.test-support.js";

describe("the claim control is gated on knowing which window this is", () => {
  /** The claim control, or `null` — the shape the withheld cases need. */
  function offeredClaimControl(container: HTMLElement): Element | null {
    return container.querySelector(".meridian-lease-line__claim");
  }

  const HELD_BY_SOMEBODY = leaseState({
    holding: "held-by-another",
    holderUserId: OTHER_USER,
    holderVouching: "vouched",
    transitionCount: 1,
  });

  it("offers no control while the identity read is still out, and says why", () => {
    const { container } = renderLease(HELD_BY_SOMEBODY, refusingBridge(), {
      status: "not-loaded",
    });
    expect(offeredClaimControl(container)).toBeNull();
    // An absence rather than a disabled button: a greyed control reads as "not right
    // now", and the truth is that the console does not yet know which window would be
    // claiming.
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-loaded");
    expect(container.textContent).toContain("Reading which window this is");
    // The disclosure is untouched — the history is readable without an identity.
    expect(container.querySelector(".meridian-lease-line__disclosure")).not.toBeNull();
  });

  it("renders the wire's own refusal, and the next move, when the read was refused", () => {
    const { container } = renderLease(HELD_BY_SOMEBODY, refusingBridge(), {
      status: "refused",
      refusal: refuse(
        "terminal-viewer-identity",
        "wire-unregistered",
        "Not checked — the caller's user identity is not registered on this build yet.",
      ),
    });
    expect(offeredClaimControl(container)).toBeNull();
    expect(container.textContent).toContain("wire-unregistered");
    // Verbatim, and the console's own sentence in the action slot beside it rather
    // than folded into the daemon's text.
    expect(container.textContent).toContain("is not registered on this build yet");
    expect(container.textContent).toContain("offered again once the console can say");
  });

  it("offers Release to the window the log names as the holder", () => {
    // The whole point of feeding the identity in: this window's own take reads as its
    // own, so the control offered is the one that gives the shell back.
    const { container } = renderLease(
      leaseState({
        holding: "held-by-you",
        holderUserId: VIEWER_USER,
        holderVouching: "vouched",
        transitionCount: 1,
      }),
    );
    expect(offeredClaimControl(container)?.textContent).toBe("Release the shell");
  });

  it("negative control: a read identity DOES get the control", () => {
    // Without this the two withheld cases would pass against a line that had simply
    // stopped rendering the claim control at all.
    const { container } = renderLease(HELD_BY_SOMEBODY);
    expect(offeredClaimControl(container)?.textContent).toBe("Claim the shell");
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });
});
