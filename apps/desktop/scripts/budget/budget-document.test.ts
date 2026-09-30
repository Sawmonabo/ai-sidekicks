// Negative controls for the budget loader, one known-bad input per rule, driven through
// `BudgetRegistry.load()`. The first case is the positive control: a loader that refused every
// document could not pass this file. Each case plants its own temporary tree, removed in
// `afterEach`, so a case never sees another's files and runs alone or in any order.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { BudgetRegistry } from "./budget-registry.mjs";
import { BudgetRegistryError } from "./budget-document.mjs";
import { TemporaryDirectoryTrail } from "../../tests/helpers/temporary-directory.js";

const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

/** A path inside a tree planted for this case alone — written to, or deliberately not. */
function fixturePathFor(name: string): string {
  return path.join(plantedFixtures.create("console-budget-registry-"), `${name}.json`);
}

describe("registry validation (negative controls)", () => {
  const loadFixture = (name: string, document: unknown): (() => BudgetRegistry) => {
    const fixturePath = fixturePathFor(name);
    writeFileSync(fixturePath, JSON.stringify(document), "utf8");
    return () => BudgetRegistry.load(fixturePath);
  };

  const validEntry = {
    id: "example",
    label: "Example",
    subject: "An example budget.",
    specTarget: "≤ 1 kB",
    limit: { comparison: "<=", value: 1, unit: "kB", canonicalValue: 1000, canonicalUnit: "bytes" },
    scope: "product",
    status: "enforced",
    measuredBy: "apps/desktop/scripts/budget/measure-bundle.mjs",
    subjectSymbol: "RendererBundleMeasurer",
    notes: "Example notes.",
  };
  const validDocument = { schemaVersion: 3, budgets: [validEntry] };

  it("accepts a well-formed registry (the positive control the rest are measured against)", () => {
    expect(loadFixture("valid", validDocument)().budgets).toHaveLength(1);
  });

  it("rejects a missing file", () => {
    // The fixture is the absence of a file: the tree is planted and nothing is written into it.
    expect(() => BudgetRegistry.load(fixturePathFor("absent"))).toThrow(BudgetRegistryError);
  });

  it("rejects an unsupported schema version", () => {
    expect(loadFixture("bad-schema", { ...validDocument, schemaVersion: 1 })).toThrow(
      /schemaVersion/,
    );
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
    // Without it `measuredBy` could only be checked by `existsSync`, which cannot tell whether the
    // harness drives the row's subject.
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
    // A row with neither scope would be counted by no completeness claim in the registry test.
    const entry = { ...validEntry, scope: "internal" };
    expect(loadFixture("bad-scope", { ...validDocument, budgets: [entry] })).toThrow(/scope/);
  });

  it("rejects a `harness` row in a document that states no derivation", () => {
    // A bound whose figure is explained nowhere is a number nothing reviews.
    const entry = { ...validEntry, scope: "harness" };
    expect(loadFixture("no-derivation", { ...validDocument, budgets: [entry] })).toThrow(
      /harnessBudgetDerivation/,
    );
  });

  it("accepts the same `harness` row once the derivation is stated", () => {
    // The positive half: without it the case above would pass over a loader that refused every
    // `harness` row.
    const entry = { ...validEntry, scope: "harness" };
    const loaded = loadFixture("with-derivation", {
      ...validDocument,
      harnessBudgetDerivation: "Why the scaffolding's own bounds are the figures they are.",
      budgets: [entry],
    })();
    expect(loaded.harnessBudgetDerivation).not.toBeNull();
    expect(loaded.harnessBudgets()).toHaveLength(1);
  });

  it("accepts a row that carries the figure its ceiling was derived to refuse", () => {
    const entry = { ...validEntry, refusalControlBytes: 13_300 };
    expect(
      loadFixture("refusal-control", { ...validDocument, budgets: [entry] })().budgets[0]
        ?.refusalControlBytes,
    ).toBe(13_300);
  });

  it("leaves the refusal control null on a row that states none", () => {
    // Optional because most ceilings are not chosen against one particular file; absent must not
    // read as zero.
    expect(loadFixture("no-refusal-control", validDocument)().budgets[0]?.refusalControlBytes).toBe(
      null,
    );
  });

  it("rejects a refusal control that is not a positive number", () => {
    // A control planted at zero bytes passes every ceiling, so a mistyped figure must refuse.
    const entry = { ...validEntry, refusalControlBytes: 0 };
    expect(loadFixture("bad-refusal-control", { ...validDocument, budgets: [entry] })).toThrow(
      /refusalControlBytes/,
    );
  });

  it("rejects a row with no scope at all", () => {
    const { scope: _omitted, ...withoutScope } = validEntry;
    expect(loadFixture("no-scope", { ...validDocument, budgets: [withoutScope] })).toThrow(/scope/);
  });
});

describe("registry fixture cleanup", () => {
  // Drives `TemporaryDirectoryTrail.removeAll()`, the removal the `afterEach` hook performs, and
  // reads the disk afterwards, all inside one case so it runs alone.

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
    // Makes the case above a check rather than a tautology: a removal that never ran and one that
    // did nothing leave the same disk, so this trail is deliberately left undrained.
    const undrained = new TemporaryDirectoryTrail();
    onTestFinished(() => {
      undrained.removeAll();
    });

    const planted = undrained.create("console-budget-registry-undrained-");

    expect(existsSync(planted)).toBe(true);
    expect(undrained.plantedDirectories).toStrictEqual([planted]);
  });
});
