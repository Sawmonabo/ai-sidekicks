// The membership ledger: which facts it prints, and what a refused enrichment
// costs it.
//
// The properties worth the most are the ones that would be WRONG rather than
// missing. A row that showed a role no event stated would be a fabricated fact,
// and a ledger that dropped its rows when the identifier read refused would
// answer "this session has no members" to a question about identifiers.
//
// What a person can DO to a row is the sibling file, `Memberships.acts.test.tsx`;
// the harness both drive is `Memberships.test-support.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Memberships,
  OWNER_AND_COLLABORATOR,
  contextFor,
  storeHolding,
} from "./Memberships.test-support.js";

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
          storeHolding([
            {
              participantId: "participant-tomas",
              membershipId: "019b7912-0001-7000-8000-000000000003",
            },
          ]),
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
            {
              participantId: "participant-you",
              role: "owner",
              membershipId: "019b7912-0001-7000-8000-000000000001",
            },
            {
              participantId: "participant-priya",
              role: "owner",
              membershipId: "019b7912-0001-7000-8000-000000000002",
            },
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

describe("memberships — nothing read", () => {
  it("names both sources rather than saying the session is empty", () => {
    const { container } = render(<Memberships context={contextFor(storeHolding([]))} />);
    const text = container.textContent ?? "";
    expect(text).toContain("No membership has been read");
    expect(text).toContain("event log and from the membership roster read");
    expect(text).toContain("not an empty session");
  });

  it("negative control: a projected membership renders a count instead", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.textContent ?? "").toContain("2 memberships");
    expect(container.textContent ?? "").not.toContain("No membership has been read");
  });
});

describe("memberships — what the two reads cost when one of them refuses", () => {
  it("says the roster read refused beside the rows rather than instead of them", () => {
    const { container } = render(
      <Memberships
        context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))}
        rosterRefusal={{
          origin: "membership-roster",
          code: "growth.wire_unregistered",
          detail: "membershipRosterRead has no wire.",
        }}
      />,
    );
    const text = container.textContent ?? "";
    // The rows are still there. That is the whole claim: a refused enrichment costs
    // the ledger its identifiers, never its memberships.
    expect(container.querySelectorAll(".meridian-members__row")).toHaveLength(2);
    expect(text).toContain("growth.wire_unregistered");
    expect(text).toContain("these memberships");
  });

  it("negative control: a served read leaves no notice at all", () => {
    const { container } = render(
      <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR))} />,
    );
    expect(container.textContent ?? "").not.toContain("growth.wire_unregistered");
    expect(container.querySelector(".meridian-reading-notice")).toBeNull();
  });
});
