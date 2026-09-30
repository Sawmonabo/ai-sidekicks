// The rail's entry table is total, which the type enforces (a `Record` over the destination union);
// the runtime cases make that readable and fail if the type is widened to `Partial`. Each positive
// case has a control showing the check can tell a missing entry from a present one.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RAIL_DESTINATIONS, type RailDestination } from "@renderer/routing/route-readers.js";
import {
  NavigationRail,
  RAIL_ENTRY_TEMPLATES,
  type RailEntry,
  type RailEntryTemplate,
} from "./NavigationRail.js";

/**
 * The compile-time control: a table missing `settings` is not a total `Record`, so if the type were
 * loosened the suppressed error would stop occurring and the directive itself would fail.
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
  it("answers every destination routing declares", () => {
    expect(destinationsWithoutEntry(RAIL_ENTRY_TEMPLATES)).toStrictEqual([]);
  });

  it("negative control: the same check names the destination when an entry is gone", () => {
    expect(destinationsWithoutEntry(TABLE_MISSING_WORKFLOWS)).toStrictEqual(["workflows"]);
  });

  it("negative control: the table the compiler rejects is short at runtime too", () => {
    // The `@ts-expect-error` above is the real guard; this executes the suppressed line.
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

describe("NavigationRail — absent, never disabled", () => {
  it("renders the entries it is handed, in the order it is handed them", () => {
    const entries = RAIL_DESTINATIONS.map(entryFor);
    const { container } = render(
      <NavigationRail entries={entries} current="sessions" onSelect={() => undefined} />,
    );
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(entries.map((entry) => entry.label));
  });

  it("renders no button at all for a destination it was not handed", () => {
    // The rail has no availability flag, so a destination left out has no greyed-out shape.
    const entries = RAIL_DESTINATIONS.filter((destination) => destination !== "workflows").map(
      entryFor,
    );
    const { container } = render(
      <NavigationRail entries={entries} current="sessions" onSelect={() => undefined} />,
    );
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).not.toContain(RAIL_ENTRY_TEMPLATES.workflows.label);
    expect(labels).toContain(RAIL_ENTRY_TEMPLATES.sessions.label);
  });
});
