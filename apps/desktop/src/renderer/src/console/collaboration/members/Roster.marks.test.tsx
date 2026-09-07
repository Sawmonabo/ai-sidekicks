// What a loaded roster row MARKS: the role, the shared terminal, and the devices behind it.
//
// Three readings that are not the presence read and are not each other. A role comes
// from the membership rows the section derived, a holder from a session-scoped read of
// one write lease, and a device fan-out from a per-participant read the caller only
// performs for the row a person opened. Rendering any of them from the presence read
// would be the console inventing an answer the daemon owns — and drawing an unread
// holder as a free lease would invite somebody to take a shell another participant is
// holding, on the strength of a read that never answered.

import { describe, expect, it } from "vitest";

import { participant, renderRoster } from "./Roster.test-support.js";

describe("roster — the role, the holder, and the devices behind a row", () => {
  it("renders each row's role from the membership rows the section derived", () => {
    const { container } = renderRoster(
      [participant("participant-one", "online"), participant("participant-two", "idle")],
      { roleFor: (participantId) => (participantId === "participant-one" ? "owner" : undefined) },
    );
    const text = container.textContent ?? "";
    expect(text).toContain("owner");
    // Negative control on the same render: a participant neither source stated a role
    // for wears no chip, rather than defaulting into the commonest role.
    expect(text).not.toContain("collaborator");
  });

  it("marks the terminal-control holder on their own row and names them under the list", () => {
    const { container } = renderRoster(
      [participant("participant-one", "online"), participant("participant-two", "idle")],
      { holding: { kind: "held", participantId: "participant-two" } },
    );
    const marked = [...container.querySelectorAll(".meridian-roster-row")].filter(
      (row) => row.querySelector(".meridian-roster-row__holder") !== null,
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent ?? "").toContain("two");
    expect(container.textContent ?? "").toContain("two is holding the shared terminal.");
  });

  it("says a free lease out loud and an unread one not at all", () => {
    const unheld = renderRoster([participant("participant-one", "online")], {
      holding: { kind: "unheld" },
    });
    expect(unheld.container.textContent ?? "").toContain("Nobody is holding the shared terminal.");
    expect(unheld.container.querySelector(".meridian-roster-row__holder")).toBeNull();

    // The negative control, and the reason the holding has three values rather than
    // two: an unread holder must not render as a free lease, because a person would
    // read that as an invitation to take a shell somebody else is holding.
    const unread = renderRoster([participant("participant-one", "online")]);
    expect(unread.container.querySelector(".meridian-roster__terminal-control")).toBeNull();
  });

  it("opens one row's device fan-out and asks about that row alone", () => {
    const opened: string[] = [];
    const { container } = renderRoster(
      [participant("participant-one", "online"), participant("participant-two", "idle")],
      {
        openDetailParticipantId: "participant-two",
        detailReading: {
          kind: "answered",
          outcome: {
            status: "served",
            value: {
              participantId: "participant-two",
              aggregateState: "idle",
              devices: [
                { deviceId: "device-desk", state: "idle", lastSeen: "2026-01-01T09:59:30.000Z" },
              ],
            },
          },
        },
        onToggleDetail: (participantId) => {
          opened.push(participantId);
        },
      },
    );
    expect(container.querySelectorAll(".meridian-roster-row__detail")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("device-desk");

    const toggles = [...container.querySelectorAll(".meridian-roster-row__detail-toggle")];
    (toggles[0] as HTMLButtonElement).click();
    expect(opened).toStrictEqual(["participant-one"]);
  });
});
