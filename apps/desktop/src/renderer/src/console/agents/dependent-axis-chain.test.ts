// The chain rule, driven directly rather than through either form that keeps it.
//
// The case both forms got wrong is the MIXED chain: one axis chosen by a person and
// the rest inherited from a definition row or from the agent's own binding. So every
// case here composes a chain whose halves came from different places, which is what a
// resolved reading is, and asserts against the vocabulary the catalog actually
// publishes rather than against the value that was typed.

import { describe, expect, it } from "vitest";

import { PROVIDER_AXES } from "./agent-wire.js";
import { DEPENDENT_AXES, unvouchedAxesOf } from "./dependent-axis-chain.js";
import { OVERLAPPING_DRIVER_CATALOG_FIXTURE } from "./driver-catalog.test-support.js";

const CATALOG = OVERLAPPING_DRIVER_CATALOG_FIXTURE;

describe("the dependent-axis chain — what a published vocabulary vouches for", () => {
  it("vouches for a chain every vocabulary carries", () => {
    expect(
      unvouchedAxesOf({ driverName: "claude", modelId: "shared-model", effort: "high" }, CATALOG),
    ).toEqual([]);
  });

  it("refuses a model the named driver does not carry", () => {
    expect(
      unvouchedAxesOf({ driverName: "codex", modelId: "claude-only", effort: "low" }, CATALOG),
    ).toEqual(["modelId", "effort"]);
  });

  it("refuses an effort the named model does not publish", () => {
    // The defect in one line: `high` is `claude`'s reading of `shared-model` and
    // `codex` publishes only `low` for the same id, so an inherited effort is wrong
    // the moment the driver above it moves — with nothing about the effort edited.
    expect(
      unvouchedAxesOf({ driverName: "codex", modelId: "shared-model", effort: "high" }, CATALOG),
    ).toEqual(["effort"]);
  });

  it("refuses a driver the catalog never named", () => {
    expect(unvouchedAxesOf({ driverName: "gemini" }, CATALOG)).toEqual(["driverName"]);
  });

  it("reports the axes parent first, so a person reads the cause before the consequence", () => {
    expect(
      unvouchedAxesOf({ driverName: "gemini", modelId: "shared-model", effort: "low" }, CATALOG),
    ).toEqual(["driverName", "modelId", "effort"]);
  });

  it("negative control: an unsettled axis is not a refused one", () => {
    // Without this the cases above would pass over a rule that refused everything it
    // could not find, which would make an empty form report three refusals.
    expect(unvouchedAxesOf({}, CATALOG)).toEqual([]);
    expect(unvouchedAxesOf({ driverName: "claude" }, CATALOG)).toEqual([]);
  });

  it("refuses a settled axis whose parent is unsettled rather than excusing it", () => {
    // An effort chosen against a model that has since been dropped is exactly the
    // entry the rule exists to catch: there is no vocabulary that could carry it, and
    // treating the second absence as permission is how it survived to the daemon.
    expect(unvouchedAxesOf({ driverName: "claude", effort: "low" }, CATALOG)).toEqual(["effort"]);
  });

  it("fails closed on an unread catalog rather than vouching for the chain", () => {
    expect(
      unvouchedAxesOf({ driverName: "claude", modelId: "shared-model", effort: "low" }, undefined),
    ).toEqual(["driverName", "modelId", "effort"]);
  });

  it("negative control: an unread catalog still refuses nothing that was never settled", () => {
    // Without this, the case above would pass over a rule that reported every axis
    // whenever the catalog was missing, which would name fields nobody had filled.
    expect(unvouchedAxesOf({}, undefined)).toEqual([]);
  });

  it("is every provider axis but the two that have no parent", () => {
    // The chain is a SUBTRACTION from the wire's own axis set. A sixth axis reaches
    // it through the FILTER rather than through this assertion; what this case
    // guards is the drift a literal would reintroduce — replace the filter with a
    // written-out list and this fails the moment `PROVIDER_AXES` moves past it.
    expect([...DEPENDENT_AXES, "providerAccountId", "outputSpeed"].sort()).toEqual(
      [...PROVIDER_AXES].sort(),
    );
  });

  it("keeps the chain parent-first, which the filter inherits rather than states", () => {
    // The order is what a form lists what is still needed in, so a person reads the
    // cause before the consequence. Deriving the set from `PROVIDER_AXES` makes that
    // order a property of THAT set, and nothing over there records why it holds — so
    // this pins it here, where the rule is. Reorder the wire's set and this is red.
    expect([...DEPENDENT_AXES]).toEqual(["driverName", "modelId", "effort"]);
  });
});
