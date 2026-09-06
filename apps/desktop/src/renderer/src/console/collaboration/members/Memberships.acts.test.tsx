// The membership ledger's controls: which it offers, which it withholds, and how an
// invitation arriving on the deep link announces itself here.
//
// A revoke control hidden from the last owner would replace an answer a person can
// act on with a control they cannot find; a confirmation that opened itself would
// take the screen from whatever was being done at the moment it arrived; and a
// ledger that left every control shut after one change settled would be
// indistinguishable from one that had broken.
//
// What a row SAYS is the sibling file, `Memberships.test.tsx`; the harness both
// drive is `Memberships.test-support.tsx`.

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
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

describe("memberships — an invitation waiting on the deep link", () => {
  type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];

  /** A scenario that hands this window one pending invitation at the first tick. */
  const SCENARIO_WITH_INVITATION: FixtureScenario = {
    id: "collaboration-members-invitation",
    label: "Memberships, with one invitation arriving",
    purpose: "Drives the ledger's deep-link notice against a scripted arrival.",
    sessionId: SESSION_ID,
    participantIdsInJoinOrder: [],
    beats: [],
    replies: [],
    startedAtIso: "2026-01-01T10:05:00.000Z",
    pendingInvites: [
      {
        atMs: 0,
        invite: {
          reference: "pending-ref-members-test",
          sessionId: "019b7913-0001-7000-8000-000000000001",
          joinMode: "collaborator",
          expiresAt: "2026-01-08T10:05:00.000Z",
          sessionName: "Design review",
          inviterDisplayName: "Priya Raman",
        },
        onConfirm: {
          kind: "joined",
          reference: "pending-ref-members-test",
          sessionId: "019b7913-0001-7000-8000-000000000001",
          membershipId: "019b7913-0002-7000-8000-000000000002",
          role: "collaborator",
        },
      },
    ],
  };

  /** The section, driven against a bridge whose scenario scripts the arrival. */
  async function sectionWithInvitation(): Promise<HTMLElement> {
    const bridge = createFixtureBridge({ scenario: SCENARIO_WITH_INVITATION });
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), bridge)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    return container;
  }

  it("draws a notice and opens nothing by itself", async () => {
    // An arrival is on somebody else's schedule. The notice is unmissable and
    // persistent; the confirmation is one press later, and never a moment the
    // person did not choose.
    const container = await sectionWithInvitation();
    expect(container.textContent ?? "").toContain("You have an invitation waiting.");
    expect(container.ownerDocument.querySelector(".meridian-invite-confirmation")).toBeNull();
  });

  it("keeps the section's own controls reachable while one waits", async () => {
    const container = await sectionWithInvitation();
    expect(container.querySelector(".meridian-members__manage")).not.toBeNull();
  });

  it("opens the confirmation on the press, and not before", async () => {
    const container = await sectionWithInvitation();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".meridian-members__invitation-open")?.click();
      await crossMacrotaskBoundary();
    });
    const popup = container.ownerDocument.querySelector(".meridian-invite-confirmation");
    expect(popup).not.toBeNull();
    expect(popup?.textContent ?? "").toContain("Design review");
  });

  it("negative control: a scenario that scripts no arrival draws no notice", async () => {
    // Without this the cases above would pass over a section that announced an
    // invitation whether or not one had come.
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(container.querySelector(".meridian-members__invitation")).toBeNull();
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
