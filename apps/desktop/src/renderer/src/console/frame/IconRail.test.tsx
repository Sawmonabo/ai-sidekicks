// The rail's entry table is total, and the compiler is what makes it so.
//
// The table used to be an array, which enforced nothing: a fourth `RailDestination`
// would have typechecked and rendered nowhere, and every runtime check written
// against the array would have gone on passing because the array was internally
// consistent with itself. So the guard being asserted here is the TYPE — a total
// `Record` over the destination union — and the runtime cases exist to make the
// claim readable and to fail loudly if the type is ever widened to `Partial`.
//
// Each positive case is paired with a control that fails the same way a real gap
// would, because "no destination is missing" is worth nothing unless the check can
// tell a missing one from a present one.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RAIL_DESTINATIONS, type RailDestination } from "../routing/index.js";
import {
  IconRail,
  RAIL_ENTRY_TEMPLATES,
  type RailEntry,
  type RailEntryTemplate,
} from "./IconRail.js";

/**
 * The compile-time control.
 *
 * A table missing `settings` is not a total `Record<RailDestination, …>`, and the
 * directive below asserts exactly that: if the table's type were ever loosened, the
 * suppressed error would stop occurring and `@ts-expect-error` would itself become
 * the error. The claim cannot rot quietly in either direction.
 */
// @ts-expect-error — deliberately missing `settings`; totality is the property.
const TABLE_THE_COMPILER_REJECTS: Readonly<Record<RailDestination, RailEntryTemplate>> = {
  sessions: { label: "Sessions", glyph: "sessions" },
  workflows: { label: "Workflows", glyph: "workflow" },
};

/** A table missing an entry at runtime, for the control cases below. */
const TABLE_MISSING_WORKFLOWS: Partial<Record<RailDestination, RailEntryTemplate>> = {
  sessions: RAIL_ENTRY_TEMPLATES.sessions,
  settings: RAIL_ENTRY_TEMPLATES.settings,
};

/** The assertion under test: which declared destinations the table cannot answer. */
function destinationsWithoutEntry(
  table: Partial<Record<RailDestination, RailEntryTemplate>>,
): readonly RailDestination[] {
  return RAIL_DESTINATIONS.filter((destination) => table[destination] === undefined);
}

function entryFor(destination: RailDestination): RailEntry {
  return { destination, ...RAIL_ENTRY_TEMPLATES[destination] };
}

describe("the rail's entry table — one entry per declared destination", () => {
  it("answers every destination the routing family declares", () => {
    expect(destinationsWithoutEntry(RAIL_ENTRY_TEMPLATES)).toStrictEqual([]);
  });

  it("negative control: the same check names the destination when an entry is gone", () => {
    expect(destinationsWithoutEntry(TABLE_MISSING_WORKFLOWS)).toStrictEqual(["workflows"]);
  });

  it("negative control: the table the compiler rejects is short at runtime too", () => {
    // The `@ts-expect-error` above is the real guard; this reads the same object
    // back so the suppressed line is not merely a comment nobody executes.
    expect(destinationsWithoutEntry(TABLE_THE_COMPILER_REJECTS)).toStrictEqual(["settings"]);
  });

  it("gives every entry a label and a glyph, because the rail renders both", () => {
    for (const destination of RAIL_DESTINATIONS) {
      const template = RAIL_ENTRY_TEMPLATES[destination];
      expect(template.label.length, destination).toBeGreaterThan(0);
      expect(template.glyph.length, destination).toBeGreaterThan(0);
    }
  });
});

describe("IconRail — absent, never disabled", () => {
  it("renders the entries it is handed, in the order it is handed them", () => {
    const entries = RAIL_DESTINATIONS.map(entryFor);
    const { container } = render(
      <IconRail entries={entries} current="sessions" onSelect={() => undefined} />,
    );
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(entries.map((entry) => entry.label));
  });

  it("renders no button at all for a destination it was not handed", () => {
    // "Absent, not disabled" is structural here rather than conditional: the rail
    // carries no availability flag, so a destination a caller leaves out has no
    // greyed-out shape to render and no way to acquire one.
    const entries = RAIL_DESTINATIONS.filter((destination) => destination !== "workflows").map(
      entryFor,
    );
    const { container } = render(
      <IconRail entries={entries} current="sessions" onSelect={() => undefined} />,
    );
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).not.toContain(RAIL_ENTRY_TEMPLATES.workflows.label);
    expect(labels).toContain(RAIL_ENTRY_TEMPLATES.sessions.label);
  });
});

// The attention count.
//
// `Spec-023 §The surface set` asks for a COUNT on the sessions destination, and the
// rail used to render a dot for a boolean nothing produced. What is asserted here is
// the three things that make a count honest: the number is on screen, it is in the
// button's accessible NAME so a reader is told it without seeing the badge, and an
// absent count renders nothing at all rather than a zero.

describe("IconRail — the attention count", () => {
  const entriesWith = (attentionCount: number | undefined): readonly RailEntry[] =>
    RAIL_DESTINATIONS.map((destination) => ({
      destination,
      ...RAIL_ENTRY_TEMPLATES[destination],
      ...(destination === "sessions" && attentionCount !== undefined ? { attentionCount } : {}),
    }));

  it("renders the number and puts it in the accessible name", () => {
    const { getByRole, container } = render(
      <IconRail entries={entriesWith(3)} current="sessions" onSelect={() => undefined} />,
    );
    expect(getByRole("button", { name: "Sessions, 3 waiting" })).toBeTruthy();
    expect(container.querySelector(".meridian-rail__attention")?.textContent).toBe("3");
  });

  it("renders nothing where no count was published — the control", () => {
    // The control the positive case is worth nothing without: a rail that always
    // rendered a badge would pass the case above and be wrong in the state every
    // healthy console is in.
    const { getByRole, container } = render(
      <IconRail entries={entriesWith(undefined)} current="sessions" onSelect={() => undefined} />,
    );
    expect(getByRole("button", { name: "Sessions" })).toBeTruthy();
    expect(container.querySelector(".meridian-rail__attention")).toBeNull();
  });

  it("puts the count on the sessions destination only", () => {
    const { getByRole } = render(
      <IconRail entries={entriesWith(2)} current="sessions" onSelect={() => undefined} />,
    );
    expect(getByRole("button", { name: "Workflows" })).toBeTruthy();
    expect(getByRole("button", { name: "Settings" })).toBeTruthy();
  });
});
