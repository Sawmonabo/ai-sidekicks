// The chain rule driven directly. The mixed chain, one axis chosen by a person and the rest
// inherited, is where an axis goes stale, so each case composes a chain from different places
// and asserts against the vocabulary the catalog publishes, not the value typed.

import { describe, expect, it } from "vitest";

import { findAxesOutsideCatalog } from "./dependent-axis-chain.js";
import { OVERLAPPING_DRIVER_CATALOG_FIXTURE } from "./driver-catalog.test-support.js";

const CATALOG = OVERLAPPING_DRIVER_CATALOG_FIXTURE;

describe("the dependent-axis chain — what a published vocabulary vouches for", () => {
  it("vouches for a chain every vocabulary carries", () => {
    expect(
      findAxesOutsideCatalog(
        { driverName: "claude", modelId: "shared-model", effort: "high" },
        CATALOG,
      ),
    ).toEqual([]);
  });

  it("refuses a model the named driver does not carry", () => {
    expect(
      findAxesOutsideCatalog(
        { driverName: "codex", modelId: "claude-only", effort: "low" },
        CATALOG,
      ),
    ).toEqual(["modelId", "effort"]);
  });

  it("refuses an effort the named model does not publish", () => {
    // `high` is `claude`'s reading of `shared-model` while `codex` publishes only `low`, so an
    // inherited effort goes wrong when the driver above it moves.
    expect(
      findAxesOutsideCatalog(
        { driverName: "codex", modelId: "shared-model", effort: "high" },
        CATALOG,
      ),
    ).toEqual(["effort"]);
  });

  it("refuses a driver the catalog never named", () => {
    expect(findAxesOutsideCatalog({ driverName: "gemini" }, CATALOG)).toEqual(["driverName"]);
  });

  it("negative control: an unsettled axis is not a refused one", () => {
    // Otherwise the cases above would pass for a rule that refuses whatever it cannot find, so
    // an empty form would report three refusals.
    expect(findAxesOutsideCatalog({}, CATALOG)).toEqual([]);
    expect(findAxesOutsideCatalog({ driverName: "claude" }, CATALOG)).toEqual([]);
  });

  it("refuses a settled axis whose parent is unsettled rather than excusing it", () => {
    // An effort chosen against a since-dropped model has no vocabulary that could carry it; a
    // second absence must not excuse it.
    expect(findAxesOutsideCatalog({ driverName: "claude", effort: "low" }, CATALOG)).toEqual([
      "effort",
    ]);
  });

  it("fails closed on an unread catalog rather than vouching for the chain", () => {
    expect(
      findAxesOutsideCatalog(
        { driverName: "claude", modelId: "shared-model", effort: "low" },
        undefined,
      ),
    ).toEqual(["driverName", "modelId", "effort"]);
  });

  it("negative control: an unread catalog still refuses nothing that was never settled", () => {
    // Otherwise the case above would pass for a rule that reports every axis whenever the
    // catalog is missing.
    expect(findAxesOutsideCatalog({}, undefined)).toEqual([]);
  });
});
