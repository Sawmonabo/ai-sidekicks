// The loader's refusals, one known-bad input per rule.
//
// Every claim `budget-registry.test.ts` makes about the registry's shape rests on
// the loader rejecting malformed input, so "the registry parsed" is evidence only
// if the parser has been shown to reject something: a checker that has never been
// shown to bite has not been shown to check anything.
//
// Each case is one rule, driven through the real `ConsoleBudgetRegistry.load()`
// over a temporary fixture, and the first case is the positive control the rest
// are measured against — without it a loader that refused every document would
// pass this whole file.
//
// ONE TREE PER CASE, REMOVED IN `afterEach`. The suite used to plant a single
// directory before its cases and remove it in `afterAll`, so a document written by
// one case was still on disk while every later case ran — suite-wide filesystem
// state, and outside the per-test cleanup discipline `apps/desktop/AGENTS.md`
// §Pre-PR self-audit closes with. `loadFixture` therefore plants the directory it
// writes into, which is what makes emptying the trail between cases safe: no case
// writes into a directory another case created.
//
// AND THE CLEANUP CONTROLS BELOW ARE SELF-CONTAINED, each planting, removing, and
// observing inside one case, so `-t` on either of them and a shuffled order both run
// the claim rather than failing on a variable a sibling case never assigned.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
  ConsoleBudgetRegistry,
  ConsoleBudgetRegistryError,
} from "../../../scripts/budget/budget-registry.mjs";
import { TemporaryDirectoryTrail } from "../temporary-directory.js";

const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

/** A path inside a tree planted for this case alone — written to, or deliberately not. */
function fixturePathFor(name: string): string {
  return path.join(plantedFixtures.create("console-budget-registry-"), `${name}.json`);
}

describe("registry validation (negative controls)", () => {
  const loadFixture = (name: string, document: unknown): (() => ConsoleBudgetRegistry) => {
    const fixturePath = fixturePathFor(name);
    writeFileSync(fixturePath, JSON.stringify(document), "utf8");
    return () => ConsoleBudgetRegistry.load(fixturePath);
  };

  const validEntry = {
    id: "example",
    label: "Example",
    subject: "An example budget.",
    specTarget: "≤ 1 kB",
    limit: { comparison: "<=", value: 1, unit: "kB", canonicalValue: 1000, canonicalUnit: "bytes" },
    scope: "product",
    status: "enforced",
    producedBy: "T-023p-1C-1",
    measuredBy: "apps/desktop/scripts/budget/measure-bundle.mjs",
    subjectSymbol: "RendererBundleMeasurer",
    notes: "Example notes.",
  };
  const validDocument = { schemaVersion: 3, source: "spec", budgets: [validEntry] };

  it("accepts a well-formed registry (the positive control the rest are measured against)", () => {
    expect(loadFixture("valid", validDocument)().budgets).toHaveLength(1);
  });

  it("rejects a missing file", () => {
    // The one case whose fixture is the ABSENCE of a file, so it plants the tree and
    // writes nothing into it — a path under the system temporary directory that has
    // never held a document, rather than one a sibling case happened to leave empty.
    expect(() => ConsoleBudgetRegistry.load(fixturePathFor("absent"))).toThrow(
      ConsoleBudgetRegistryError,
    );
  });

  it("rejects an unsupported schema version", () => {
    expect(loadFixture("bad-schema", { ...validDocument, schemaVersion: 1 })).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects an `n/a` entry with no producing task", () => {
    const entry = {
      ...validEntry,
      status: "n/a",
      measuredBy: null,
      subjectSymbol: null,
      notMeasurableReason: "why",
    };
    const { producedBy: _omitted, ...withoutProducedBy } = entry;
    expect(
      loadFixture("no-produced-by", { ...validDocument, budgets: [withoutProducedBy] }),
    ).toThrow(/producedBy/);
  });

  it("rejects an `n/a` entry with no reason", () => {
    const entry = { ...validEntry, status: "n/a", measuredBy: null, subjectSymbol: null };
    expect(loadFixture("no-reason", { ...validDocument, budgets: [entry] })).toThrow(
      /notMeasurableReason/,
    );
  });

  it("rejects an `enforced` entry with no measuring harness", () => {
    const { measuredBy: _omitted, ...withoutHarness } = validEntry;
    expect(loadFixture("no-harness", { ...validDocument, budgets: [withoutHarness] })).toThrow(
      /measuredBy/,
    );
  });

  it("rejects an `enforced` entry that names no subject symbol", () => {
    // Without it `measuredBy` is checkable only by `existsSync`, which is what
    // let two rows name a harness that drives neither of their subjects.
    const { subjectSymbol: _omitted, ...withoutSubject } = validEntry;
    expect(loadFixture("no-subject", { ...validDocument, budgets: [withoutSubject] })).toThrow(
      /subjectSymbol/,
    );
  });

  it("rejects an `n/a` entry that names a subject symbol anyway", () => {
    const entry = { ...validEntry, status: "n/a", measuredBy: null, notMeasurableReason: "why" };
    expect(loadFixture("subject-on-na", { ...validDocument, budgets: [entry] })).toThrow(
      /subjectSymbol/,
    );
  });

  it("rejects a duplicate budget id", () => {
    expect(
      loadFixture("duplicate", { ...validDocument, budgets: [validEntry, { ...validEntry }] }),
    ).toThrow(/duplicate budget id/);
  });

  it("rejects a comparison that is not a ceiling", () => {
    const entry = { ...validEntry, limit: { ...validEntry.limit, comparison: ">=" } };
    expect(loadFixture("bad-comparison", { ...validDocument, budgets: [entry] })).toThrow(
      /comparison/,
    );
  });

  it("rejects a non-numeric limit", () => {
    const entry = { ...validEntry, limit: { ...validEntry.limit, canonicalValue: "450000" } };
    expect(loadFixture("bad-limit", { ...validDocument, budgets: [entry] })).toThrow(
      /canonicalValue/,
    );
  });

  it("rejects an unknown status", () => {
    const entry = { ...validEntry, status: "deferred" };
    expect(loadFixture("bad-status", { ...validDocument, budgets: [entry] })).toThrow(/status/);
  });

  it("rejects an unknown scope", () => {
    // A row that declares neither kind would be counted by neither completeness
    // claim in `budget-registry.test.ts`, which is the one way a budget can
    // rejoin the set of numbers nothing checks.
    const entry = { ...validEntry, scope: "internal" };
    expect(loadFixture("bad-scope", { ...validDocument, budgets: [entry] })).toThrow(/scope/);
  });

  it("rejects a `harness` row in a document that states no derivation", () => {
    // A bound the scaffolding applies to itself, with the reason for its figure
    // written nowhere, is a number gated by nothing — which is what the harness
    // rows were before they joined this file.
    const entry = { ...validEntry, scope: "harness" };
    expect(loadFixture("no-derivation", { ...validDocument, budgets: [entry] })).toThrow(
      /harnessBudgetDerivation/,
    );
  });

  it("accepts the same `harness` row once the derivation is stated", () => {
    // The positive half: without it the case above passes over a loader that
    // refused every harness row, whatever the document said.
    const entry = { ...validEntry, scope: "harness" };
    const loaded = loadFixture("with-derivation", {
      ...validDocument,
      harnessBudgetDerivation: "Why the scaffolding's own bounds are the figures they are.",
      budgets: [entry],
    })();
    expect(loaded.harnessBudgetDerivation).not.toBeNull();
    expect(loaded.harnessBudgets()).toHaveLength(1);
  });

  it("rejects a row with no scope at all", () => {
    const { scope: _omitted, ...withoutScope } = validEntry;
    expect(loadFixture("no-scope", { ...validDocument, budgets: [withoutScope] })).toThrow(/scope/);
  });
});

describe("registry fixture cleanup", () => {
  // The floor under the `afterEach` above: the removal that hook performs is
  // `TemporaryDirectoryTrail.removeAll()`, so the control drives THAT — writing a
  // document on the very trail the validation cases write on, draining it, and reading
  // the disk afterwards, all inside one case. It used to be two cases sharing a `let`,
  // which made the observing one unrunnable on its own and unrunnable in a shuffled
  // order: it read an empty path and failed on its own scaffolding.

  it("removes every tree this file's own trail is holding", () => {
    const planted = fixturePathFor("cleanup-control");
    writeFileSync(planted, "{}", "utf8");
    expect(existsSync(planted)).toBe(true);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([path.dirname(planted)]);

    plantedFixtures.removeAll();

    expect(
      existsSync(path.dirname(planted)),
      "a registry fixture outlived the removal that was asked to take it, so every " +
        "later case in this file runs against documents it did not write",
    ).toBe(false);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([]);
  });

  it("negative control: a trail nobody drains leaves its tree on disk", () => {
    // What makes the case above a check rather than a tautology. A removal that never
    // ran and a removal that ran and did nothing leave the same disk, so this plants on
    // a trail the suite's hook does not hold, does NOT drain it, and shows the tree is
    // still there — the state the assertion above would report.
    const undrained = new TemporaryDirectoryTrail();
    onTestFinished(() => {
      undrained.removeAll();
    });

    const planted = undrained.create("console-budget-registry-undrained-");

    expect(existsSync(planted)).toBe(true);
    expect(undrained.plantedDirectories).toStrictEqual([planted]);
  });
});
