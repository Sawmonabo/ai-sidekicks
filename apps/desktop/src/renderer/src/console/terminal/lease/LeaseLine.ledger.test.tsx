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
    // The negative control for the case below: an empty ledger over a log that
    // carried nothing claims the zero and renders no notice, so the notice there is
    // the unreadable count and not a banner every empty ledger wears.
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
  });

  it("says an all-unreadable history is unreadable rather than claiming zero moves", async () => {
    // The empty-rows state that is NOT "nothing arrived". Every `pty.control_changed`
    // this log carried named a reason outside the closed set, so the fold pushed no
    // row and counted each one — and the absence's other sentence would say the lease
    // "has changed hands zero times" over deliveries the fold recorded, directly under
    // a line on the same pane that says the shell DID change hands.
    const { container } = renderLease(
      leaseState({
        transitions: [],
        transitionCount: 0,
        unreadableTransitionCount: 2,
        unreadTransition: {
          sequence: 2,
          occurredAtIso: "2026-01-01T16:40:02.000Z",
          reason: "quarantined_by_operator",
        },
      }),
    );
    fireEvent.click(disclosureControl(container));

    // The count and the disposition, through the one incomplete-reading vocabulary.
    const notice = container.querySelector(".meridian-partial-read");
    expect(notice?.textContent).toContain("2");
    expect(notice?.textContent).toContain("deliveries could not be read");
    expect(container.textContent).toContain("arrived in a form this build cannot read");

    // And the claim the ledger cannot make. The line above it renders the unread
    // transition off the same fold, so the two would have contradicted each other.
    expect(container.textContent).not.toContain("changed hands zero times");
    expect(container.textContent).toContain(
      "The shell changed hands under a transition this build cannot read",
    );
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

  it("renders an orderable instant past the ninth row, where the seconds field carries", async () => {
    // The cap is thirty-two rows, so every ledger case that fills one crosses ten.
    // The builder's own instant used to be spelled with a one-digit seconds slot,
    // which mints `16:40:010` at sequence 10 — not an instant, and `formatClockTime`
    // answers an em dash for it. The failure is silent: the row still renders, in a
    // column of dashes, so what the ledger cannot say is WHEN anything happened.
    const acrossTheCarry = [
      transitionAt(9, "taken"),
      transitionAt(10, "released"),
      transitionAt(11, "taken"),
    ];
    const { container } = renderLease(
      leaseState({
        holding: "unheld",
        holderVouching: "vouched",
        transitions: acrossTheCarry,
        transitionCount: acrossTheCarry.length,
      }),
    );
    fireEvent.click(disclosureControl(container));

    const clockTimes = [
      ...container.querySelectorAll(".meridian-ledger-row__gutter .meridian-figure"),
    ].map((element) => element.textContent ?? "");
    expect(clockTimes).toHaveLength(acrossTheCarry.length);
    expect(clockTimes).not.toContain("—");
    // Distinct AND ascending: an instant that merely parses would still be wrong if
    // every row carried the same one, which is the other way a derived clock breaks.
    expect(new Set(clockTimes).size).toBe(acrossTheCarry.length);
    expect([...clockTimes].sort()).toStrictEqual(clockTimes);
  });

  it("negative control: a ledger that named one reason five times would collapse them", () => {
    const collapsed = transitions.map((transition) => ({ ...transition, reason: "released" }));
    expect(new Set(collapsed.map((transition) => transition.reason)).size).toBe(1);
  });
});
