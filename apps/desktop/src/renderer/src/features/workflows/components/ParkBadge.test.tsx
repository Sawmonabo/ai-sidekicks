// Every arm of the badge is asserted and each is the others' control, so an implementation that
// rendered one shape for every park fails a case. Parks are built through `parkSchedule`, the
// projection's own classifier, because a hand-written `schedule` literal would agree with
// whichever component was asked.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatClockTime, formatDateTime } from "@renderer/lib/wire-figures.js";
import { ParkBadge } from "./ParkBadge.js";
import {
  parkSchedule,
  type WorkflowParkedPhase,
  type WorkflowPhasePark,
} from "../runs/run-list-rows.js";

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
 * A usage-limit park whose armed boundary no parser accepts. Shaped like a real instant because a
 * daemon's malformed boundary looks like a timestamp.
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

/** The armed instant as the badge draws it. */
function scheduleFigureText(park: WorkflowPhasePark): string {
  return (
    renderBadge(park).querySelector(".meridian-park__schedule .meridian-figure--wire")
      ?.textContent ?? ""
  );
}

describe("a park with an armed schedule", () => {
  it("wears no color, because nobody is being asked for anything", () => {
    const badge = renderBadge(WAITING_ON_CAPACITY);
    expect(badge.querySelector(".meridian-chip--attention")).toBeNull();
    expect(badge.querySelector(".meridian-chip--neutral")).not.toBeNull();
  });

  it("shows the armed instant and keeps the exact wire value on it", () => {
    const badge = renderBadge(WAITING_ON_CAPACITY);
    const schedule = badge.querySelector(".meridian-park__schedule");
    const figure = schedule?.querySelector(".meridian-figure--wire");
    expect(figure?.getAttribute("title")).toBe(WAITING_ON_CAPACITY.autoResumeAt);
    // A formatted reading, not the raw string, so the title carries what the text does not.
    expect(figure?.textContent).not.toBe(WAITING_ON_CAPACITY.autoResumeAt);
  });
});

describe("an armed instant that falls on another day", () => {
  // Two boundaries at the same wall-clock time, three days apart. No badge stands under a day
  // divider, so the transcript's date-free reading collapses this pair into one figure.
  const armedOnTheFirst: WorkflowPhasePark = {
    ...WAITING_ON_CAPACITY,
    autoResumeAt: "2026-09-01T11:30:00.000Z",
  };
  const armedOnTheFourth: WorkflowPhasePark = {
    ...WAITING_ON_CAPACITY,
    autoResumeAt: "2026-09-04T11:30:00.000Z",
  };

  it("reads differently from one armed at the same time on a different day", () => {
    expect(scheduleFigureText(armedOnTheFourth)).not.toBe(scheduleFigureText(armedOnTheFirst));
  });

  it("negative control: the transcript's date-free reading renders the two identically", () => {
    // Shows why the transcript's date-free formatter cannot serve a card with no day divider.
    expect(formatClockTime(armedOnTheFourth.autoResumeAt ?? "")).toBe(
      formatClockTime(armedOnTheFirst.autoResumeAt ?? ""),
    );
  });

  it("draws the figure chokepoint's date-carrying reading, and not a second one", () => {
    // Against the real formatter: a locale-shaped regexp would pass a badge that composed its own
    // date.
    expect(scheduleFigureText(armedOnTheFirst)).toBe(
      formatDateTime(armedOnTheFirst.autoResumeAt ?? ""),
    );
  });
});

describe("a park whose armed instant this console cannot read", () => {
  it("negative control: the fixture really is unreadable", () => {
    // Both cases below rest on this. Asserted through the projection's own classification, not the
    // host parser, which accepts values the projection refuses and refuses values it accepts.
    expect(parkSchedule(CAPACITY_WITH_AN_UNREADABLE_BOUNDARY).kind).toBe("unreadable");
  });

  it("is drawn as unscheduled rather than as a resume with no time in it", () => {
    // The defect: a malformed instant took the scheduled branch and rendered a placeholder time.
    const badge = renderBadge(CAPACITY_WITH_AN_UNREADABLE_BOUNDARY);
    expect(scheduleText(badge)).not.toContain("Scheduled to resume at");
    expect(scheduleText(badge)).toContain("waits until a run control does");
    expect(badge.querySelector(".meridian-chip--attention")).not.toBeNull();
  });

  it("reports the value the engine sent rather than swallowing it", () => {
    // It is the only evidence a boundary was armed at all.
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
    // The run pane mounts this phase's form; a run control points away from what the engine awaits.
    const badge = renderBadge(WAITING_ON_A_PERSON);
    expect(scheduleText(badge)).toContain("submits this phase's form");
    expect(scheduleText(badge)).not.toContain("run control");
    expect(badge.querySelector(".meridian-chip--attention")).not.toBeNull();
  });

  it("sends an unscheduled capacity wait to a run control, naming the missing boundary", () => {
    // The control for the case above: one copy for both reasons fails exactly one of the two.
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
    const named = renderBadge(WAITING_ON_A_PERSON, "Sign-off");
    expect(named.querySelector(".meridian-park__phase-name")?.textContent).toBe("Sign-off");
    // The name is the console's prose and wears no provenance signature; the wire key beside it
    // does.
    expect(named.querySelector(".meridian-park__phase-name .meridian-figure--wire")).toBeNull();
  });

  it("identifies the phase by its wire key even when no name was read", () => {
    // A name comes only from a read that carries one, and the run read carries none, so the id
    // stands alone; passing it as the name would dress an opaque key as an authored name.
    const badge = renderBadge(WAITING_ON_A_PERSON);
    const identity = badge.querySelector(".meridian-park__phase");

    expect(identity?.querySelector(".meridian-figure--wire")?.textContent).toBe("phase-1");
    // Nothing is invented in the name's place.
    expect(identity?.querySelector(".meridian-park__phase-name")).toBeNull();
    expect(identity?.textContent).toBe("phase-1");
  });
});
