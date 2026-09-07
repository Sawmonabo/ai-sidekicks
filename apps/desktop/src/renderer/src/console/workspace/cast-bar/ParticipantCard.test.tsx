// The participant card: the two facts this console can answer and the two it cannot.
//
// The card is rendered DIRECTLY here rather than through the chip's tooltip. What is
// under test is which facts the card reads and how it renders each absence; the
// tooltip's own open-on-hover behaviour is the library's and is covered where the chip
// is driven. Rendering through the popup would put a portal, a positioner and a
// pointer sequence between the assertion and the claim.
//
// The store is the real `SessionStore`, driven through `initialise` with the same
// projected shapes the roster and run projectors write, so the card is read the way it
// will be read in a running console.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleEntity } from "../../store/index.js";
import { ParticipantCard } from "./ParticipantCard.js";

const SESSION_ID = "session-participant-card";
const PARTICIPANT_ID = "participant-priya";

function rosterEntry(role: unknown): ConsoleEntity {
  return { kind: "participant", id: PARTICIPANT_ID, body: { role } };
}

function run(
  id: string,
  state: string,
  options: { readonly attributedTo?: string; readonly touchedAt?: string } = {},
): ConsoleEntity {
  return {
    kind: "run",
    id,
    state,
    touchedAt: options.touchedAt ?? "2026-09-01T00:00:00.000Z",
    attributedTo: options.attributedTo ?? PARTICIPANT_ID,
  };
}

function renderCard(options: {
  readonly entities?: readonly ConsoleEntity[];
  readonly label?: string;
}): HTMLElement {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: options.entities ?? [], participantJoinLog: [] });
  const { container } = render(
    <ParticipantCard sessionStore={store} participantId={PARTICIPANT_ID} label={options.label} />,
  );
  return container;
}

function factValue(card: HTMLElement, label: string): string {
  const terms = [...card.querySelectorAll("dt")];
  const term = terms.find((element) => element.textContent === label);
  return String(term?.nextElementSibling?.textContent ?? "");
}

describe("ParticipantCard — the role comes from the roster and is never defaulted", () => {
  it("shows the role the roster entry carries", () => {
    const card = renderCard({ entities: [rosterEntry("owner")] });
    expect(factValue(card, "Role")).toContain("owner");
  });

  it("says no roster entry names a role where the partition holds none", () => {
    const card = renderCard({});
    // Never `viewer` and never `owner`: a defaulted role would hide a control an owner
    // is entitled to, or offer one the daemon will refuse.
    expect(factValue(card, "Role")).toContain("No roster entry names a role.");
  });

  it("says the same where the entry carries a role the contract does not parse", () => {
    const card = renderCard({ entities: [rosterEntry(7)] });
    expect(factValue(card, "Role")).toContain("No roster entry names a role.");
  });
});

describe("ParticipantCard — the current run is the newest one still going", () => {
  it("names the newest live run attributed to this participant", () => {
    const card = renderCard({
      entities: [
        run("run-older", "running", { touchedAt: "2026-09-01T09:00:00.000Z" }),
        // An hour later in wall-clock terms and lexically SMALLER, so a comparison
        // over strings rather than moments would pick the wrong one.
        run("run-newer", "waiting_for_approval", { touchedAt: "2026-09-01T08:00:00.000-02:00" }),
      ],
    });
    expect(factValue(card, "Current run")).toContain("run-newer");
    expect(factValue(card, "Current run")).toContain("waiting_for_approval");
  });

  it("ignores a run attributed to somebody else", () => {
    const card = renderCard({
      entities: [run("run-theirs", "running", { attributedTo: "participant-someone-else" })],
    });
    expect(factValue(card, "Current run")).toContain("No run of theirs is going.");
  });

  it("ignores a completed run", () => {
    const card = renderCard({ entities: [run("run-done", "completed")] });
    expect(factValue(card, "Current run")).toContain("No run of theirs is going.");
  });

  it("treats a state this build does not carry as not going, rather than as going", () => {
    const card = renderCard({ entities: [run("run-x", "hibernating")] });
    expect(factValue(card, "Current run")).toContain("No run of theirs is going.");
  });
});

describe("ParticipantCard — the two facts no wire reaches are absences, not blanks", () => {
  it("says presence has not been read", () => {
    const card = renderCard({});
    expect(factValue(card, "Presence since")).toContain("Presence has not been read.");
  });

  it("says no receipt has been read for the paying account", () => {
    const card = renderCard({});
    // Not "no paying account": the console has not asked, which is a different fact.
    expect(factValue(card, "Paying account")).toContain("No receipt has been read.");
  });

  it("renders both as the not-checked absence rather than as empty", () => {
    const card = renderCard({});
    expect(card.querySelectorAll(".meridian-nothing--not-checked").length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

describe("ParticipantCard — the identifier the chip's `title` used to carry", () => {
  it("carries the id as a wire figure beside the name", () => {
    const card = renderCard({ entities: [], label: "priya" });
    expect(card.textContent).toContain("priya");
    expect(card.textContent).toContain(PARTICIPANT_ID);
  });

  it("shows the id alone where the log named the participant nothing", () => {
    const card = renderCard({});
    expect(card.querySelector(".meridian-participant-card__id")).toBeNull();
    expect(String(card.querySelector(".meridian-participant-card__name")?.textContent)).toContain(
      PARTICIPANT_ID,
    );
  });
});
