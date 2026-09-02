// The badge's whole job is to tell the kinds of park apart and to say what ends each
// one, so every arm is asserted and each is the others' control: an implementation
// that rendered one shape for every park fails at least one case here.
//
// Every park below is built through `parkSchedule` — the projection's own
// classifier — rather than by writing a `schedule` literal, because the defect this
// file pins was a badge that made its own classification. A test that hand-wrote the
// answer would agree with whichever component was asked.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkBadge } from "./ParkBadge.js";
import { parkSchedule } from "./run-list-rows.js";
import type { WorkflowParkedPhase, WorkflowPhasePark } from "./run-list-projection.js";

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

/**
 * A usage-limit park whose armed boundary no parser accepts.
 *
 * Shaped like a real instant on purpose: a daemon that emits a malformed boundary
 * emits something that LOOKS like a timestamp, and obvious rubbish would prove the
 * badge handles rubbish rather than the case that happens.
 */
const CAPACITY_WITH_AN_UNREADABLE_BOUNDARY: WorkflowPhasePark = {
  parkReason: "provider-usage-limited",
  parkCause: "The account's allowance is spent.",
  autoResumeAt: "2026-09-01T99:99:99.000Z",
};

function parked(park: WorkflowPhasePark, phaseName?: string): WorkflowParkedPhase {
  return {
    phaseId: "phase-1",
    phaseName,
    park,
    schedule: parkSchedule(park),
  };
}

function renderBadge(park: WorkflowPhasePark, phaseName?: string): HTMLElement {
  const { container } = render(<ParkBadge parked={parked(park, phaseName)} />);
  const badge = container.querySelector(".meridian-park");
  if (!(badge instanceof HTMLElement)) {
    throw new Error("the badge rendered nothing");
  }
  return badge;
}

function scheduleText(badge: HTMLElement): string {
  return badge.querySelector(".meridian-park__schedule")?.textContent ?? "";
}

describe("a park with an armed schedule", () => {
  it("wears no colour, because nobody is being asked for anything", () => {
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

describe("a park whose armed instant this console cannot read", () => {
  it("negative control: the fixture really is unparseable", () => {
    // Both cases below rest on this. A fixture that quietly parsed would make them
    // pass over a badge that treated it as an ordinary schedule.
    expect(Number.isNaN(Date.parse(CAPACITY_WITH_AN_UNREADABLE_BOUNDARY.autoResumeAt ?? ""))).toBe(
      true,
    );
  });

  it("is drawn as unscheduled rather than as a resume with no time in it", () => {
    // The defect exactly: a present-but-malformed instant took the scheduled branch,
    // so the badge promised "Scheduled to resume at" and then rendered a placeholder
    // where the time should have been.
    const badge = renderBadge(CAPACITY_WITH_AN_UNREADABLE_BOUNDARY);
    expect(scheduleText(badge)).not.toContain("Scheduled to resume at");
    expect(scheduleText(badge)).toContain("waits until a run control does");
    expect(badge.querySelector(".meridian-chip--attention")).not.toBeNull();
  });

  it("reports the value the engine sent rather than swallowing it", () => {
    // It is the only evidence a boundary was armed at all, and a badge that dropped
    // it would draw this park identically to one that armed nothing.
    const badge = renderBadge(CAPACITY_WITH_AN_UNREADABLE_BOUNDARY);
    const note = badge.querySelector(".meridian-park__unreadable");
    expect(note?.textContent).toContain("could not read");
    expect(note?.querySelector(".meridian-figure--wire")?.textContent).toBe(
      CAPACITY_WITH_AN_UNREADABLE_BOUNDARY.autoResumeAt,
    );
  });

  it("negative control: a readable boundary carries no such note", () => {
    expect(renderBadge(WAITING_ON_CAPACITY).querySelector(".meridian-park__unreadable")).toBeNull();
  });
});

describe("what ends an unscheduled wait, said per reason", () => {
  it("sends a human wait to the phase's form and not to a run control", () => {
    // The run pane mounts this phase's form; telling the operator to reach for a run
    // control pointed them away from the act the engine is actually waiting on.
    const badge = renderBadge(WAITING_ON_A_PERSON);
    expect(scheduleText(badge)).toContain("submits this phase's form");
    expect(scheduleText(badge)).not.toContain("run control");
    expect(badge.querySelector(".meridian-chip--attention")).not.toBeNull();
  });

  it("sends an unscheduled capacity wait to a run control, naming the missing boundary", () => {
    // The control for the case above: one copy for both reasons fails exactly one of
    // these two, whichever sentence it chose.
    const badge = renderBadge({
      parkReason: "provider-usage-limited",
      parkCause: "The account's allowance is spent.",
    });
    expect(scheduleText(badge)).toContain("No reset boundary was reported");
    expect(scheduleText(badge)).toContain("waits until a run control does");
    expect(scheduleText(badge)).not.toContain("form");
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
