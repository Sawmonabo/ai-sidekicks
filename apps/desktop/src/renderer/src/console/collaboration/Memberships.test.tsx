// The membership ledger: which facts it prints, which controls it offers, and the
// one screen it gives up entirely for a confirmation.
//
// The properties worth the most are the ones that would be WRONG rather than
// missing. A row that showed a role no event stated would be a fabricated fact; a
// revoke control hidden from the last owner would replace an answer a person can
// act on with a control they cannot find; and a ledger that rendered its own
// controls behind a pending confirmation would offer two jobs on one screen at
// the moment the person has to concentrate on one.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { SessionStore } from "../store/index.js";
import type { SidebarSectionContext } from "../workspace/index.js";
import { Memberships } from "./Memberships.js";
import type { PendingInviteConfirmation } from "./InviteConfirmation.js";

type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];

const SESSION_ID = "session-collaboration";

const EMPTY_SCENARIO: FixtureScenario = {
  id: "collaboration-members-test",
  label: "Memberships, with nothing scripted",
  purpose: "Drives the membership ledger against a bridge that scripts no reply.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

interface ProjectedMembership {
  readonly participantId: string;
  readonly role?: string;
  readonly membershipId?: string;
  readonly state?: string;
}

/**
 * A store holding exactly the memberships a case is about.
 *
 * The REAL store, initialised from a snapshot — not a stand-in for it. What the
 * section derives from a projection is the thing under test, so the projection
 * has to be the real one.
 */
function storeHolding(memberships: readonly ProjectedMembership[]): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: 0,
    participantJoinLog: memberships.map((membership) => membership.participantId),
    entities: memberships.map((membership) => ({
      kind: "participant" as const,
      id: membership.participantId,
      ...(membership.state === undefined ? {} : { state: membership.state }),
      body: {
        ...(membership.role === undefined ? {} : { role: membership.role }),
        ...(membership.membershipId === undefined ? {} : { membershipId: membership.membershipId }),
      },
    })),
  });
  return store;
}

function contextFor(store: SessionStore, bridge?: ConsoleBridge): SidebarSectionContext {
  return {
    sessionStore: store,
    bridge: bridge ?? createFixtureBridge({ scenario: EMPTY_SCENARIO }),
    openPane: () => undefined,
    isOpen: true,
  };
}

const OWNER_AND_COLLABORATOR: readonly ProjectedMembership[] = [
  {
    participantId: "participant-you",
    role: "owner",
    membershipId: "membership-1",
    state: "active",
  },
  {
    participantId: "participant-priya",
    role: "collaborator",
    membershipId: "membership-2",
    state: "suspended",
  },
];

describe("memberships — the facts on a row", () => {
  it("prints the role and the membership state as wire figures", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    const chips = [...container.querySelectorAll(".meridian-chip__label")].map(
      (chip) => chip.textContent ?? "",
    );
    expect(chips).toContain("owner");
    expect(chips).toContain("collaborator");
    expect(chips).toContain("suspended");
  });

  it("keeps a suspended membership as a row rather than removing it", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.querySelectorAll(".meridian-members__row")).toHaveLength(2);
    expect(container.textContent ?? "").toContain("participant-priya");
  });

  it("says a role was not read rather than choosing one", () => {
    const { container } = render(
      <Memberships
        context={contextFor(
          storeHolding([{ participantId: "participant-tomas", membershipId: "membership-3" }]),
        )}
      />,
    );
    expect(container.textContent ?? "").toContain("Role not read");
    const chips = [...container.querySelectorAll(".meridian-chip__label")].map(
      (chip) => chip.textContent ?? "",
    );
    expect(chips).not.toContain("viewer");
  });

  it("negative control: a row whose role WAS read prints no absence", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.textContent ?? "").not.toContain("Role not read");
  });
});

describe("memberships — the last remaining owner", () => {
  it("states that ownership has to be transferred first", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.textContent ?? "").toContain("transferred before this membership");
  });

  it("still offers the revoke control on that very row", () => {
    // The daemon's `membership.last_owner` refusal is the truthful answer, and it
    // carries a remedy. Hiding the control to avoid provoking it hides the answer.
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    const revokeLabels = [...container.querySelectorAll(".meridian-members__revoke")].map(
      (control) => control.getAttribute("aria-label") ?? "",
    );
    expect(revokeLabels).toContain("Revoke the membership of participant-you");
  });

  it("negative control: two owners means no such note on either row", () => {
    const { container } = render(
      <Memberships
        context={contextFor(
          storeHolding([
            { participantId: "participant-you", role: "owner", membershipId: "membership-1" },
            { participantId: "participant-priya", role: "owner", membershipId: "membership-2" },
          ]),
        )}
      />,
    );
    expect(container.textContent ?? "").not.toContain("transferred before this membership");
  });
});

describe("memberships — a row with no membership id", () => {
  it("offers no controls and names the read that would supply one", () => {
    const { container } = render(
      <Memberships
        context={contextFor(storeHolding([{ participantId: "participant-tomas", role: "viewer" }]))}
      />,
    );
    expect(container.querySelector(".meridian-members__manage")).toBeNull();
    expect(container.querySelector(".meridian-members__revoke")).toBeNull();
    expect(container.textContent ?? "").toContain("No controls for this row");
    // The badge carries its sentence as the accessible title rather than as body
    // text, so the reason is asserted where a person actually meets it.
    const badges = [...container.querySelectorAll(".meridian-nothing__badge-label")].map(
      (badge) => badge.getAttribute("title") ?? "",
    );
    expect(badges.some((title) => title.includes("names its membership id"))).toBe(true);
  });

  it("negative control: a row WITH one offers both controls", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.querySelector(".meridian-members__manage")).not.toBeNull();
    expect(container.querySelector(".meridian-members__revoke")).not.toBeNull();
  });
});

describe("memberships — nothing projected", () => {
  it("says nobody asked rather than that the session is empty", () => {
    const { container } = render(<Memberships context={contextFor(storeHolding([]))} />);
    const text = container.textContent ?? "";
    expect(text).toContain("No membership has been read");
    expect(text).toContain("nobody asked");
  });

  it("negative control: a projected membership renders a count instead", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.textContent ?? "").toContain("2 memberships");
    expect(container.textContent ?? "").not.toContain("No membership has been read");
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
