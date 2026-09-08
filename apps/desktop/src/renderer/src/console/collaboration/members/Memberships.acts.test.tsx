// The membership ledger's controls: which it offers, and which it withholds.
//
// A revoke control hidden from the last owner would replace an answer a person can
// act on with a control they cannot find, and a ledger that left every control shut
// after one change settled would be indistinguishable from one that had broken.
//
// THE DEEP-LINK INVITATION IS NOT DRIVEN HERE ANY MORE. Its lifecycle is the window's
// rather than this section's — an invitation is about a session this window is not in,
// and the recipient most often has none open — so the cases that drove it moved with
// it to `../invites/InviteLifecycleOverlay.test.tsx`. What is left here is the one
// claim this file can still make about it: this section announces nothing.
//
// What a row SAYS is the sibling file, `Memberships.test.tsx`; the harness both
// drive is `Memberships.test-support.tsx`.

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import { scenarioWithArrivals } from "../invites/pending-invite.test-support.js";
import {
  Memberships,
  OWNER_AND_COLLABORATOR,
  SESSION_ID,
  contextFor,
  offlineFrameStore,
  storeHolding,
} from "./Memberships.test-support.js";

/**
 * A scenario that hands this window two invitations on the deep link.
 *
 * The invite suites' own scenario, re-addressed to the session this harness builds a
 * store for: what is being asserted here is that the section stays silent while
 * invitations really are waiting, which needs a bridge that really delivers them.
 */
const SCENARIO_WITH_INVITATION = { ...scenarioWithArrivals(), sessionId: SESSION_ID };

describe("memberships — a shell that cannot send", () => {
  it("keeps every row and closes every control, naming the shell's own refusal", () => {
    // Closed and never hidden: a control that vanished would leave a person unable
    // to find what they came for, while a disabled one with the cause as its own
    // reason says what is wrong and that it will come back.
    const { container } = render(
      <Memberships
        context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), undefined, offlineFrameStore())}
      />,
    );
    expect(container.querySelectorAll(".meridian-members__row")).toHaveLength(2);
    expect(container.textContent ?? "").toContain("shell-offline");
    const manage = container.querySelector<HTMLButtonElement>(".meridian-members__manage");
    expect(manage?.disabled).toBe(true);
    expect(manage?.getAttribute("title") ?? "").toContain("did not come back");
    expect(container.querySelector<HTMLButtonElement>(".meridian-members__revoke")?.disabled).toBe(
      true,
    );
  });

  it("negative control: with nothing reported the controls are offered", () => {
    // Silence is not an outage. A fresh window has heard nothing from its supervisor,
    // and a ledger that read that as an outage would disable every control in a
    // console that works.
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.textContent ?? "").not.toContain("shell-offline");
    expect(container.querySelector(".meridian-members__manage")).not.toBeNull();
  });
});

describe("memberships — a projection that is behind", () => {
  it("says the rows are last-known and leaves every control offered", () => {
    // The defect this case is the control for: the four controls were gated on the
    // session store's degraded flag, so a window that missed one event in the stream
    // lost every membership control it had — permanently, on a flag only a completed
    // re-pull clears — while `membership.update` stayed perfectly reachable.
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} isLastKnown />,
    );
    expect(container.querySelectorAll(".meridian-members__read-only")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("the last state this window was sent");
    expect(container.querySelector(".meridian-members__manage")).not.toBeNull();
  });

  it("shows the last-known reading beside the shell's refusal when both hold", () => {
    // Two facts with two owners, and neither stands in for the other: the rows are
    // stale AND nothing can be sent, and a person is told both.
    const { container } = render(
      <Memberships
        context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), undefined, offlineFrameStore())}
        isLastKnown
      />,
    );
    expect(container.querySelectorAll(".meridian-members__read-only")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("shell-offline");
    expect(container.querySelector<HTMLButtonElement>(".meridian-members__manage")?.disabled).toBe(
      true,
    );
  });
});

describe("memberships — the deep link is not this section's", () => {
  it("announces no invitation, whatever is waiting on the window", async () => {
    // The notice and the confirmation are the window's now. A second announcement
    // here would be a second place to answer one invitation, and it would be the one
    // the reader happened not to be looking at.
    const bridge = createFixtureBridge({ scenario: SCENARIO_WITH_INVITATION });
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), bridge)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(container.querySelector(".meridian-invite-notice")).toBeNull();
    expect(container.ownerDocument.querySelector(".meridian-invite-confirmation")).toBeNull();
  });

  it("negative control: the section's own controls are reachable all the same", async () => {
    // Without this the case above would pass over a section that had failed to render
    // at all, which draws no notice for a reason that is not the one being claimed.
    const bridge = createFixtureBridge({ scenario: SCENARIO_WITH_INVITATION });
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), bridge)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(container.querySelector(".meridian-members__manage")).not.toBeNull();
  });
});

describe("memberships — one change at a time", () => {
  /** Every row's manage trigger and revoke trigger, read fresh after each render. */
  function rowControls(container: HTMLElement): readonly HTMLButtonElement[] {
    return [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".meridian-members__manage, .meridian-members__revoke",
      ),
    ];
  }

  /** Open one row's revoke confirmation and press through it. */
  function confirmRevoke(container: HTMLElement, rowIndex: number): void {
    act(() => {
      container.querySelectorAll<HTMLButtonElement>(".meridian-members__revoke")[rowIndex]?.click();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>(".meridian-confirm__confirm")?.click();
    });
  }

  it("closes every row's controls while one row's change is unsettled", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(rowControls(container).every((control) => !control.disabled)).toBe(true);

    // Synchronous acts on purpose: the coordinator publishes its pending key
    // before the call it awaits settles, so this reads the tree at exactly the
    // moment one membership change is in flight.
    confirmRevoke(container, 0);

    const controls = rowControls(container);
    expect(controls).toHaveLength(4);
    expect(controls.every((control) => control.disabled)).toBe(true);
    // The row that was pressed says what it is doing; its neighbour is only shut.
    const manageLabels = [...container.querySelectorAll(".meridian-members__manage")].map(
      (control) => control.textContent ?? "",
    );
    expect(manageLabels).toStrictEqual(["Applying…", "Manage"]);
  });

  it("negative control: every control opens again once that change settles", async () => {
    // Without this, the case above would pass over a ledger that disabled every
    // control permanently.
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );

    confirmRevoke(container, 0);
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    // The scenario scripts no `membership.update` reply, so the fixture refuses —
    // and the refusal renders in place rather than leaving the surface shut. Its
    // words are the DOOR's: the coordinator installs a refusal verbatim and adds no
    // prefix of its own, so what a person reads names the call that had no answer.
    expect(container.textContent ?? "").toContain("membership.update");
    expect(container.textContent ?? "").toContain("reply-unscripted");
    expect(rowControls(container).every((control) => !control.disabled)).toBe(true);
  });
});

describe("memberships — what a person reads", () => {
  it("names no governance work anywhere", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("labels every control it draws", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    const unlabelled = [...container.querySelectorAll("button")].filter(
      (button) =>
        (button.textContent ?? "").trim() === "" && button.getAttribute("aria-label") === null,
    );
    expect(unlabelled).toStrictEqual([]);
  });
});
