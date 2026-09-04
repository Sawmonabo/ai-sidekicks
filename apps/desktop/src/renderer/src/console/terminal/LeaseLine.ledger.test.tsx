// The transition ledger — one click away, every reason its own line.
//
// 8.8 puts the history behind a disclosure, and `lease-transition.ts`'s sentence
// table is total over the closed reason set — so the three automatic reasons must not
// collapse into one line. What this file asserts is the DISCLOSURE and the rendering;
// the fold that produces the transitions is `lease-transition.test.ts`'s.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TerminalLeaseTransition } from "./lease-transition.js";
import {
  disclosureControl,
  leaseState,
  renderLease,
  transitionAt,
} from "./LeaseLine.test-support.js";

describe("the transition ledger — one click away, every reason its own line", () => {
  const transitions: readonly TerminalLeaseTransition[] = [
    transitionAt(1, "taken"),
    transitionAt(2, "released"),
    transitionAt(3, "auto_released_disconnect"),
    transitionAt(4, "auto_released_authorization_lost"),
    transitionAt(5, "auto_released_run_idle"),
  ];

  it("shows output and the holder line only until it is asked for", () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched", transitions, transitionCount: 5 }),
    );
    expect(container.querySelector(".meridian-lease-line__ledger")).toBeNull();
    // The count is on the disclosure, so density costs no information.
    expect(container.querySelector(".meridian-lease-line__disclosure")?.textContent).toContain("5");
  });

  it("keeps the three automatic reasons distinct once opened", async () => {
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched", transitions, transitionCount: 5 }),
    );
    fireEvent.click(disclosureControl(container));
    const sentences = [...container.querySelectorAll(".meridian-lease-line__sentence")].map(
      (element) => element.textContent,
    );
    expect(sentences).toHaveLength(5);
    expect(new Set(sentences).size).toBe(5);
  });

  it("says an unread history is unread rather than showing an empty list", async () => {
    const { container } = renderLease(leaseState({ holding: "unheld", holderVouching: "vouched" }));
    fireEvent.click(disclosureControl(container));
    expect(container.textContent).toContain("No transition has been read.");
    expect(container.textContent).toContain("not the same as the shell never having moved");
  });

  it("negative control: a ledger that named one reason five times would collapse them", () => {
    const collapsed = transitions.map((transition) => ({ ...transition, reason: "released" }));
    expect(new Set(collapsed.map((transition) => transition.reason)).size).toBe(1);
  });
});
