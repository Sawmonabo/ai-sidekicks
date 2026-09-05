// The transition ledger — one click away, every reason its own line.
//
// 8.8 puts the history behind a disclosure, and `lease-transition.ts`'s sentence
// table is total over the closed reason set — so the three automatic reasons must not
// collapse into one line. What this file asserts is the DISCLOSURE and the rendering;
// the fold that produces the transitions and their counts is `lease-model.test.ts`'s.

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

  it("says which transitions are missing when the fold dropped the oldest", async () => {
    // The disclosure's own label says forty-one; the feed holds five. Without the
    // notice a person answering "who had it, and why did it move" reads a list that
    // looks exhaustive, and the figure it does not match is one click away.
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "vouched",
        transitions,
        transitionCount: 41,
      }),
    );
    fireEvent.click(disclosureControl(container));
    const notice = container.querySelector(".meridian-partial-read");
    expect(notice?.textContent).toContain("5");
    expect(notice?.textContent).toContain(
      "read before the answer for this transition history was cut short",
    );
    expect(notice?.textContent).toContain("what is not shown here may still exist");
    // And the rows are still there: a notice withdraws the completeness claim, it
    // does not replace the best reading the surface has.
    expect(container.querySelectorAll(".meridian-lease-line__sentence")).toHaveLength(5);
  });

  it("says the history is incomplete when a transition arrived that it could not read", async () => {
    // The state the fold RECORDS as unreadable, rendered by the one arm that claims
    // completeness before this case existed. Three readable transitions and one the
    // build could not read leave `transitions.length === transitionCount === 3`, so a
    // reading derived from the cap alone is `served` and the disclosure shows three
    // rows with no notice at all — a feed presenting itself as exhaustive over a
    // fourth move the console holds and cannot read.
    //
    // The lease itself reads `unheld`, which is the state a later readable release
    // settled — so the line's own unread paragraph says nothing here and this notice
    // is the only place the missing move surfaces at all.
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "vouched",
        transitions: transitions.slice(0, 3),
        transitionCount: 3,
        unreadableTransitionCount: 1,
      }),
    );
    fireEvent.click(disclosureControl(container));
    const notice = container.querySelector(".meridian-partial-read");
    expect(notice?.textContent).toContain("1");
    expect(notice?.textContent).toContain("delivery could not be read");
    expect(notice?.textContent).toContain(
      "this transition history may be behind what the daemon has sent",
    );
    expect(container.querySelectorAll(".meridian-lease-line__sentence")).toHaveLength(3);
  });

  it("hands over both readings when the fold was cut AND could not read a delivery", async () => {
    // Two incompletenesses, two notices. `primitives/partial-read.ts` admits no call
    // shape that shows one reading and hides the other, and a merged sentence would
    // have to drop one of the two facts a person acts on differently.
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "vouched",
        transitions,
        transitionCount: 41,
        unreadableTransitionCount: 2,
      }),
    );
    fireEvent.click(disclosureControl(container));
    const notices = [...container.querySelectorAll(".meridian-partial-read")].map(
      (element) => element.textContent ?? "",
    );
    expect(notices).toHaveLength(2);
    expect(notices.some((copy) => copy.includes("was cut short"))).toBe(true);
    expect(notices.some((copy) => copy.includes("deliveries could not be read"))).toBe(true);
  });

  it("keeps the notice out of the feed, which owns articles and nothing else", async () => {
    // WAI-ARIA's `feed` owns `article` elements, which is what a `LedgerRow` renders.
    // A notice mounted inside it is skipped by the article-to-article navigation the
    // feed exists to support, so the reader most likely to walk this disclosure as a
    // feed would be the one never told that rows are missing.
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "vouched",
        transitions,
        transitionCount: 41,
      }),
    );
    fireEvent.click(disclosureControl(container));
    const feed = container.querySelector('[role="feed"]');
    expect(feed).not.toBeNull();
    expect(feed?.querySelector(".meridian-partial-read")).toBeNull();
    expect(container.querySelector(".meridian-partial-read")).not.toBeNull();
    // Every child the feed does own is an article, which is the other half of the
    // same rule and the half a notice moved outside does not prove on its own.
    expect([...(feed?.children ?? [])].every((child) => child.tagName === "ARTICLE")).toBe(true);
  });

  it("negative control: an untruncated ledger claims completeness and says nothing", () => {
    // The other half, and the one that makes the case above mean something: a notice
    // rendered on every ledger would be a warning nobody reads. The fold kept every
    // transition it counted and read every one that arrived, so BOTH readings are
    // `served` and `PartialRead` renders nothing at all.
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched", transitions, transitionCount: 5 }),
    );
    fireEvent.click(disclosureControl(container));
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
    expect(container.querySelectorAll(".meridian-lease-line__sentence")).toHaveLength(5);
  });

  it("negative control: a ledger that named one reason five times would collapse them", () => {
    const collapsed = transitions.map((transition) => ({ ...transition, reason: "released" }));
    expect(new Set(collapsed.map((transition) => transition.reason)).size).toBe(1);
  });
});
