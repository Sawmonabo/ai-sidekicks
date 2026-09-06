// The membership ledger's controls: which it offers, which it withholds, and the
// one screen it gives up entirely for a confirmation.
//
// A revoke control hidden from the last owner would replace an answer a person can
// act on with a control they cannot find; a ledger that rendered its own controls
// behind a pending confirmation would offer two jobs on one screen at the moment
// the person has to concentrate on one; and a ledger that left every control shut
// after one change settled would be indistinguishable from one that had broken.
//
// What a row SAYS is the sibling file, `Memberships.test.tsx`; the harness both
// drive is `Memberships.test-support.tsx`.

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PendingInviteConfirmation } from "../invites/InviteConfirmation.js";
import {
  Memberships,
  OWNER_AND_COLLABORATOR,
  SESSION_ID,
  contextFor,
  storeHolding,
} from "./Memberships.test-support.js";

describe("memberships — the control plane out of reach", () => {
  it("keeps every row and offers no control, under one line saying why", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} isLastKnown />,
    );
    expect(container.querySelectorAll(".meridian-members__row")).toHaveLength(2);
    expect(container.querySelectorAll(".meridian-members__read-only")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("no membership can be changed from here");
    expect(container.querySelector(".meridian-members__manage")).toBeNull();
    expect(container.querySelector(".meridian-members__revoke")).toBeNull();
  });

  it("negative control: with the control plane reachable the controls are offered", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.querySelector(".meridian-members__read-only")).toBeNull();
    expect(container.querySelector(".meridian-members__manage")).not.toBeNull();
  });
});

describe("memberships — a pending confirmation takes the whole surface", () => {
  const PENDING: PendingInviteConfirmation = {
    token: "v4.local.opaque-token",
    sessionId: SESSION_ID,
  };

  it("renders the confirmation and none of the section's own controls", () => {
    const { container } = render(
      <Memberships
        context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))}
        pendingInvite={PENDING}
      />,
    );
    expect(container.querySelector(".meridian-invite-confirmation")).not.toBeNull();
    expect(container.querySelector(".meridian-members__manage")).toBeNull();
    expect(container.querySelector(".meridian-invites")).toBeNull();
  });

  it("returns the section once the confirmation is put away", () => {
    const { container } = render(
      <Memberships
        context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))}
        pendingInvite={PENDING}
      />,
    );
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-invite-confirmation__dismiss")?.click();
    });
    expect(container.querySelector(".meridian-invite-confirmation")).toBeNull();
    expect(container.querySelector(".meridian-members__manage")).not.toBeNull();
  });

  it("negative control: with no pending invitation the section renders straight away", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.querySelector(".meridian-invite-confirmation")).toBeNull();
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
      document.querySelector<HTMLButtonElement>(".meridian-members__dialog-confirm")?.click();
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
