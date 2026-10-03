// Refusals of the bundle measurer. Each case is a way a measurement could report green over bytes
// nobody bounded, driven over a planted out-dir that is wrong in exactly one way.

import { afterEach, describe, expect, it } from "vitest";

import {
  RendererBundleMeasurer,
  RendererBundleOutputMissingError,
  rendererBundleAssetClassOf,
} from "./measure-bundle.mts";
import { plantRendererOutput } from "./measure-bundle.test-support.js";
import { TemporaryDirectoryTrail } from "../../tests/helpers/temporary-directory.js";

/** Every out-dir the cases plant, removed after each of them. */
const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

describe("initial-graph measurement refusals", () => {
  it("refuses a tree with no chunk manifest", () => {
    const directory = plantedFixtures.create("renderer-output-empty-");
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(
      RendererBundleOutputMissingError,
    );
  });

  it("refuses a manifest that marks no entry", () => {
    const directory = plantRendererOutput(plantedFixtures, "no-entry", {
      "src/lazy.ts": { file: "assets/lazy.js" },
    });
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(/isEntry/);
  });

  it("refuses a manifest naming a file the tree does not hold", () => {
    const directory = plantRendererOutput(plantedFixtures, "absent-file", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(/assets\/index\.js/);
  });

  it("refuses an asset whose extension belongs to neither class", () => {
    // Fail closed: an unclassified asset would sum into neither row, a silent under-count.
    expect(rendererBundleAssetClassOf("assets/logo.png")).toBeUndefined();
    const directory = plantRendererOutput(plantedFixtures, "unclassified", {
      "index.html": { file: "assets/logo.png", isEntry: true },
    });
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(/asset class/);
  });
});
