// The renderer initial-graph budget gates.
//
// One walk of the built `out/renderer` tree, held against two rows of
// `budgets.json`: `renderer-initial-bundle` over the CODE it emits, gzipped
// (≤ 450 kB gzip excluding lazy chunks), and `renderer-initial-fonts` over the font files on that same
// graph, raw. The split is a change of unit rather than an exclusion, and the
// two negative controls at the bottom are what make that a claim with evidence:
// one more font file fails the font row, and a font byte never reaches the code one.
//
// THIS TEST NEVER SKIPS ITSELF: a budget gate that turns itself off when its
// subject is missing reports green for a bundle nobody measured. The console
// budget Turbo task declares a `dependsOn: ["build"]` edge, so the build is
// present by construction in CI and in `pnpm test`; a bare `vitest run` in a
// clean checkout fails with the command that produces one. The refusal tests at
// the bottom are what make that claim evidence rather than an assumption.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  evaluateBudget,
  formatUnavailableBudgetReport,
  type ConsoleBudget,
} from "../../../scripts/budget/budget-registry.mjs";
import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RENDERER_BUNDLE_BUDGET_ID,
  RENDERER_BUNDLE_GATES,
  RENDERER_FONTS_BUDGET_ID,
  RENDERER_MANIFEST_RELATIVE_PATH,
  RendererBundleMeasurer,
  RendererBundleOutputMissingError,
  formatRendererBundleReport,
  rendererBundleAssetClassOf,
  type RendererBundleMeasurement,
} from "../../../scripts/budget/measure-bundle.mjs";
import { TemporaryDirectoryTrail } from "../temporary-directory.js";

const registry = ConsoleBudgetRegistry.load();

/** An escape for measuring an out-of-tree build; NOT an escape from measuring. */
const rendererOutputDirectory: string =
  process.env["CONSOLE_BUDGET_RENDERER_OUT_DIR"] ?? DEFAULT_RENDERER_OUTPUT_DIRECTORY;

/**
 * Compression only shrinks input above roughly a container's worth of bytes; a
 * 60-byte declaration file gzips larger than it started. Assets below this size
 * are asserted to have a compressed reading at all, not a smaller one.
 */
const COMPRESSION_ASSERTION_FLOOR_BYTES = 1024;

/** The font row, read once — the ceiling the controls below drive and its own figures. */
const fontsBudget: ConsoleBudget = registry.requireBudget(RENDERER_FONTS_BUDGET_ID);

/**
 * The size the `renderer-initial-fonts` ceiling was derived to refuse ONE MORE font
 * file at — the smallest `woff2` split either IBM Plex variable package publishes at
 * the pinned versions — read off the row itself.
 *
 * The control below plants exactly it: any real additional file is this large or
 * larger, and a control planted at a comfortable size proves only that some larger
 * number is over. Read from the registry rather than restated here, because the row
 * already states the figure in its own derivation and a threshold written twice in a
 * test that also loads the file is the second home the config-single-sourcing rule
 * in `apps/desktop/AGENTS.md` rejects. It is not read out of `node_modules` either: the budget
 * tier weighs the BUILD's output, and a tier that reaches into a package layout to
 * write its own control acquires a second subject.
 */
const smallestPublishedSplitBytes: number = refusalControlBytesOf(fontsBudget);

/** @throws rather than planting a zero-byte control that every ceiling admits. */
function refusalControlBytesOf(budget: ConsoleBudget): number {
  if (budget.refusalControlBytes === null) {
    throw new Error(
      `\`${budget.id}\` states no \`refusalControlBytes\`, so the negative control below has ` +
        "no size to plant. The figure the ceiling was derived to refuse lives on the row.",
    );
  }
  return budget.refusalControlBytes;
}

function measureOrFailLoudly(): RendererBundleMeasurement {
  try {
    return new RendererBundleMeasurer(rendererOutputDirectory).measure();
  } catch (measurementError) {
    if (measurementError instanceof RendererBundleOutputMissingError) {
      throw new Error(
        `${measurementError.message}\nThis gate fails rather than skips when its subject is ` +
          `missing. Budgets not gated at this revision, so the full set stays ` +
          `visible:\n\n${formatUnavailableBudgetReport(registry)}`,
        { cause: measurementError },
      );
    }
    throw measurementError;
  }
}

/** Every fixture tree the refusal cases plant, removed after each of them. */
const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

/** A renderer out-dir holding a manifest and, optionally, the files it names. */
function outputDirectoryWithManifest(
  name: string,
  manifest: unknown,
  emittedFiles: ReadonlyMap<string, string> = new Map(),
): string {
  const directory = plantedFixtures.create(`console-bundle-${name}-`);
  const manifestPath = path.join(directory, ...RENDERER_MANIFEST_RELATIVE_PATH.split("/"));
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  for (const [relativePath, sourcePath] of emittedFiles) {
    const emittedPath = path.join(directory, ...relativePath.split("/"));
    mkdirSync(path.dirname(emittedPath), { recursive: true });
    copyFileSync(sourcePath, emittedPath);
  }
  return directory;
}

/** A one-entry manifest over `assetPaths`, the shape Vite writes for the entry document. */
function manifestNaming(assetPaths: readonly string[]): unknown {
  const [entryFile, ...remaining] = assetPaths;
  return { "index.html": { file: entryFile, isEntry: true, assets: remaining } };
}

/** One walk, read by both describes below — measuring twice is two readings that can disagree. */
const measurement: RendererBundleMeasurement = measureOrFailLoudly();

describe("renderer initial-graph budgets", () => {
  const gateReadings = RENDERER_BUNDLE_GATES.map((gate) => {
    const budget: ConsoleBudget = registry.requireBudget(gate.budgetId);
    return {
      budget,
      verdict: evaluateBudget(budget, gate.compare(measurement)),
      measuredDescription: gate.measuredDescription(measurement),
    };
  });

  it("measures a non-empty initial graph rooted in a manifest entry", () => {
    expect(measurement.entryKeys.length).toBeGreaterThan(0);
    expect(measurement.assets.length).toBeGreaterThan(0);
    const relativePaths = measurement.assets.map((asset) => asset.relativePath);
    expect(new Set(relativePaths).size, "an asset counted twice").toBe(relativePaths.length);
  });

  it("compresses every asset it counts", () => {
    for (const asset of measurement.assets) {
      expect(asset.gzipByteCount, `${asset.relativePath}: gzip`).toBeGreaterThan(0);
      expect(asset.brotliByteCount, `${asset.relativePath}: brotli`).toBeGreaterThan(0);
      if (asset.assetClass === "code" && asset.rawByteCount >= COMPRESSION_ASSERTION_FLOOR_BYTES) {
        // Only code compresses. A `woff2` is a Brotli container already, which is
        // the whole reason the font row is gated raw — asserting it here would be
        // asserting the opposite of what this split was measured to establish.
        expect(asset.gzipByteCount, `${asset.relativePath}: gzip < raw`).toBeLessThan(
          asset.rawByteCount,
        );
        expect(asset.brotliByteCount, `${asset.relativePath}: brotli < raw`).toBeLessThan(
          asset.rawByteCount,
        );
      }
    }
  });

  it("splits every asset into exactly one class, and totals exactly that class", () => {
    for (const { assetClass, totals } of [
      { assetClass: "code", totals: measurement.code },
      { assetClass: "font", totals: measurement.fonts },
    ] as const) {
      const inClass = measurement.assets.filter((asset) => asset.assetClass === assetClass);
      const sumOf = (read: (asset: (typeof inClass)[number]) => number): number =>
        inClass.reduce((total, asset) => total + read(asset), 0);
      expect(totals.assetCount, `${assetClass}: assets`).toBe(inClass.length);
      expect(totals.rawByteCount, `${assetClass}: raw`).toBe(sumOf((asset) => asset.rawByteCount));
      expect(totals.gzipByteCount, `${assetClass}: gzip`).toBe(
        sumOf((asset) => asset.gzipByteCount),
      );
      expect(totals.brotliByteCount, `${assetClass}: brotli`).toBe(
        sumOf((asset) => asset.brotliByteCount),
      );
    }
    expect(measurement.code.assetCount + measurement.fonts.assetCount).toBe(
      measurement.assets.length,
    );
  });

  it.each(gateReadings.map((gateReading) => [gateReading.budget.id, gateReading] as const))(
    "%s stays within its ceiling",
    (_budgetId, gateReading) => {
      expect(
        gateReading.verdict.withinBudget,
        `${gateReading.budget.label} is ` +
          `${gateReading.verdict.measuredCanonicalValue.toLocaleString("en-US")} B ` +
          `(${gateReading.measuredDescription}) against a ` +
          `${gateReading.verdict.limitCanonicalValue.toLocaleString("en-US")} B budget ` +
          `(${(gateReading.verdict.utilizationFraction * 100).toFixed(1)} % of budget). ` +
          "Move code behind a dynamic import so it lands in a lazy chunk, or drop a face — and " +
          "amend `budgets.json` only with the reasoning its row and `harnessBudgetDerivation` " +
          "already carry, since the registry mirrors its sources rather than setting them.",
      ).toBe(true);
    },
  );

  it("reports both rows in one report", () => {
    const report = formatRendererBundleReport(measurement, gateReadings, registry);
    console.log(report);
    expect(report).toContain(registry.requireBudget(RENDERER_BUNDLE_BUDGET_ID).label);
    expect(report).toContain(fontsBudget.label);
  });
});

// Negative controls. Each is a way a measurement could report green over bytes
// nobody bounded; the harness must refuse or fail rather than pass.
describe("initial-graph measurement refusals", () => {
  it("refuses a tree with no chunk manifest", () => {
    const directory = plantedFixtures.create("console-bundle-empty-");
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(
      RendererBundleOutputMissingError,
    );
  });

  it("refuses a manifest that marks no entry", () => {
    const directory = outputDirectoryWithManifest("no-entry", {
      "src/lazy.ts": { file: "assets/lazy.js" },
    });
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(/isEntry/);
  });

  it("refuses a manifest naming a file the tree does not hold", () => {
    const directory = outputDirectoryWithManifest("absent-file", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(/assets\/index\.js/);
  });

  it("refuses an asset whose extension belongs to neither class", () => {
    // The fail-closed half of the split: an unclassified asset sums into neither
    // row, which is the same silent under-count as a file that is not there.
    expect(rendererBundleAssetClassOf("assets/logo.png")).toBeUndefined();
    const directory = outputDirectoryWithManifest("unclassified", {
      "index.html": { file: "assets/logo.png", isEntry: true },
    });
    expect(() => new RendererBundleMeasurer(directory).measure()).toThrow(/asset class/);
  });
});

describe("the two rows bound disjoint bytes", () => {
  const fontAssets = measurement.assets.filter((asset) => asset.assetClass === "font");

  it("classes every emitted face as a font and every script and sheet as code", () => {
    expect(fontAssets.length, "the initial graph carries the self-hosted faces").toBeGreaterThan(0);
    for (const asset of measurement.assets) {
      expect(rendererBundleAssetClassOf(asset.relativePath), asset.relativePath).toBe(
        asset.assetClass,
      );
      expect(asset.assetClass, asset.relativePath).toBe(
        /\.woff2?$/u.test(asset.relativePath) ? "font" : "code",
      );
    }
  });

  it("negative control: a font byte never lands in the code row", () => {
    // Planted: a tree holding one stylesheet and one real face. The code figure
    // is the sheet's alone, so re-classing `woff2` as code fails this case.
    const stylesheet = measurement.assets.find((asset) => asset.relativePath.endsWith(".css"));
    const face = fontAssets[0];
    expect(stylesheet, "a stylesheet on the initial graph").toBeDefined();
    expect(face, "a face on the initial graph").toBeDefined();
    if (stylesheet === undefined || face === undefined) {
      return;
    }
    const directory = outputDirectoryWithManifest(
      "one-of-each",
      manifestNaming([stylesheet.relativePath, face.relativePath]),
      new Map([
        [stylesheet.relativePath, path.join(rendererOutputDirectory, stylesheet.relativePath)],
        [face.relativePath, path.join(rendererOutputDirectory, face.relativePath)],
      ]),
    );
    const planted = new RendererBundleMeasurer(directory).measure();
    expect(planted.code.assetCount).toBe(1);
    expect(planted.code.gzipByteCount).toBe(stylesheet.gzipByteCount);
    expect(planted.fonts.assetCount).toBe(1);
    expect(planted.fonts.rawByteCount).toBe(face.rawByteCount);
  });

  it("negative control: one more font file fails the font row", () => {
    // The property the 232 kB figure was chosen for, driven rather than asserted:
    // every shipped variable face plus one more file at the SMALLEST size either
    // foundry package publishes, measured by the real measurer and judged by the
    // real row. Planted at that size rather than as a copy of a shipped face,
    // because a copy of the 32 576 B mono face would clear the ceiling and pass a
    // control a far looser ceiling also passed — it would drive the sign of the
    // refusal without driving the figure. The bytes are zeros: this gate weighs
    // files and parses none, so the only property the plant needs is its length,
    // and a real face would make the control depend on which one.
    const additionalFacePath = "assets/additional-face-planted.woff2";
    const emittedFaces = new Map(
      fontAssets.map((asset) => [
        asset.relativePath,
        path.join(rendererOutputDirectory, asset.relativePath),
      ]),
    );
    const directory = outputDirectoryWithManifest(
      "additional-face",
      manifestNaming([...emittedFaces.keys(), additionalFacePath]),
      emittedFaces,
    );
    writeFileSync(
      path.join(directory, ...additionalFacePath.split("/")),
      Buffer.alloc(smallestPublishedSplitBytes),
    );
    const planted = new RendererBundleMeasurer(directory).measure();
    expect(planted.fonts.assetCount).toBe(fontAssets.length + 1);
    expect(
      evaluateBudget(fontsBudget, measurement.fonts.rawByteCount).withinBudget,
      "every shipped face together is within the ceiling",
    ).toBe(true);
    expect(
      evaluateBudget(fontsBudget, planted.fonts.rawByteCount).withinBudget,
      `one more font file measured ${planted.fonts.rawByteCount.toLocaleString("en-US")} B ` +
        `against a ${fontsBudget.limit.canonicalValue.toLocaleString("en-US")} B ceiling and ` +
        `still passed`,
    ).toBe(false);
  });
});
