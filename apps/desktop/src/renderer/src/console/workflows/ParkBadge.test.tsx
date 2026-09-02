// The badge's whole job is to tell the two kinds of park apart, so both arms are
// asserted and each is the other's control: an implementation that rendered one
// shape for every park would fail exactly one of the first two cases.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkBadge } from "./ParkBadge.js";
import type { WorkflowPhasePark } from "./run-list-projection.js";

const WAITING_ON_A_PERSON: WorkflowPhasePark = {
  parkReason: "waiting-human",
  parkCause: "Waiting for sign-off on the release notes.",
};

const WAITING_ON_CAPACITY: WorkflowPhasePark = {
  parkReason: "provider-usage-limited",
  parkCause: "The account's allowance is spent until 2026-09-01T11:30:00.000Z.",
  autoResumeAt: "2026-09-01T11:30:00.000Z",
  parkAttentionKey: "account-7",
};

function renderBadge(park: WorkflowPhasePark, phaseName?: string): HTMLElement {
  const { container } = render(<ParkBadge park={park} phaseName={phaseName} />);
  const badge = container.querySelector(".meridian-park");
  if (!(badge instanceof HTMLElement)) {
    throw new Error("the badge rendered nothing");
  }
  return badge;
}

describe("a park nothing is scheduled to lift", () => {
  it("wears the attention tone and says the wait ends when a control ends it", () => {
    const badge = renderBadge(WAITING_ON_A_PERSON);
    expect(badge.querySelector(".meridian-chip--attention")).not.toBeNull();
    expect(badge.querySelector(".meridian-park__schedule")?.textContent).toContain(
      "waits until a run control does",
    );
  });
});

describe("a park with an armed schedule", () => {
  it("wears no colour, because nobody is being asked for anything", () => {
    // The control for the case above: amber is spent on "a person is needed" and a
    // badge that wore it for every park would spend it on a machine's own wait.
    const badge = renderBadge(WAITING_ON_CAPACITY);
    expect(badge.querySelector(".meridian-chip--attention")).toBeNull();
    expect(badge.querySelector(".meridian-chip--neutral")).not.toBeNull();
  });

  it("shows the armed instant and keeps the exact wire value on it", () => {
    const badge = renderBadge(WAITING_ON_CAPACITY);
    const schedule = badge.querySelector(".meridian-park__schedule");
    const figure = schedule?.querySelector(".meridian-figure--wire");
    expect(figure?.getAttribute("title")).toBe(WAITING_ON_CAPACITY.autoResumeAt);
    // A formatted reading, not the raw string: the two differ, which is what makes
    // the title above load-bearing rather than decorative.
    expect(figure?.textContent).not.toBe(WAITING_ON_CAPACITY.autoResumeAt);
  });
});

describe("what the badge quotes and what it writes", () => {
  it("renders the engine's cause verbatim", () => {
    const badge = renderBadge(WAITING_ON_A_PERSON);
    expect(badge.querySelector(".meridian-park__cause")?.textContent).toBe(
      WAITING_ON_A_PERSON.parkCause,
    );
  });

  it("shows the reason's wire value beside the sentence the console wrote", () => {
    const badge = renderBadge(WAITING_ON_A_PERSON);
    expect(badge.querySelector(".meridian-figure--wire")?.textContent).toBe("waiting-human");
    expect(badge.textContent).toContain("Waiting on a person");
  });

  it("names the parked phase when it is shown away from that phase's own row", () => {
    expect(renderBadge(WAITING_ON_A_PERSON, "Sign-off").textContent).toContain("Sign-off");
    // The control: absent the name, nothing is invented in its place.
    expect(renderBadge(WAITING_ON_A_PERSON).querySelector(".meridian-park__phase")).toBeNull();
  });
});
