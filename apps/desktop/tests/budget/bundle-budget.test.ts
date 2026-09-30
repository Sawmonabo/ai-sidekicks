// The renderer initial-graph budget gates.
//
// One walk of the built `out/renderer` tree, held against two rows of `budgets.json`:
// `renderer-initial-bundle` over the code it emits, gzipped (≤ 450 kB excluding lazy chunks),
// and `renderer-initial-fonts` over the font files on the same graph, raw. The split is a change
// of unit, not an exclusion; the two negative controls at the bottom show it: one more font file
// fails the font row, and a font byte never reaches the code row.
//
// This test never skips itself: a gate that turns off when its subject is missing reports green
// for a bundle nobody measured. The Turbo task depends on `build`, so the build is present in CI
// and in `pnpm test`; a bare `vitest run` without one fails with the command that produces it.
// The measurer's refusals are in `scripts/budget/measure-bundle.test.ts`.

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import { BudgetRegistry } from "../../scripts/budget/budget-registry.mjs";
import { evaluateBudget } from "../../scripts/budget/budget-evaluation.mjs";
import { formatUnavailableBudgetReport } from "../../scripts/budget/budget-report.mjs";
import { type Budget } from "../../scripts/budget/budget-document.mjs";
import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RENDERER_BUNDLE_BUDGET_ID,
  RENDERER_BUNDLE_GATES,
  RENDERER_FONTS_BUDGET_ID,
  RendererBundleMeasurer,
  RendererBundleOutputMissingError,
  formatRendererBundleReport,
  rendererBundleAssetClassOf,
  type RendererBundleMeasurement,
} from "../../scripts/budget/measure-bundle.mjs";
import { TemporaryDirectoryTrail } from "../helpers/temporary-directory.js";
import { plantRendererOutput } from "../helpers/renderer-output-fixture.js";

const registry = BudgetRegistry.load();

/** Lets an out-of-tree build be measured; it is not a way to skip measuring. */
const rendererOutputDirectory: string =
  process.env["CONSOLE_BUDGET_RENDERER_OUT_DIR"] ?? DEFAULT_RENDERER_OUTPUT_DIRECTORY;

/**
 * Compression only shrinks input above roughly a container's worth of bytes (a 60-byte file
 * gzips larger). Smaller assets are asserted to have a compressed reading, not a smaller one.
 */
const COMPRESSION_ASSERTION_FLOOR_BYTES = 1024;

/** The font row, read once — the ceiling the controls below drive and its own figures. */
const fontsBudget: Budget = registry.requireBudget(RENDERER_FONTS_BUDGET_ID);

/**
 * The size the `renderer-initial-fonts` ceiling was derived to refuse one more font file at:
 * the smallest `woff2` split either IBM Plex variable package publishes at the pinned versions.
 * The control plants exactly it, since any real extra file is at least this large. It is read
 * from the row rather than restated, and not from `node_modules`, because this tier weighs the
 * build's output.
 */
const smallestPublishedSplitBytes: number = refusalControlBytesOf(fontsBudget);

/** The row's control size; throws rather than plant a zero-byte control every ceiling admits. */
function refusalControlBytesOf(budget: Budget): number {
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

/** Every fixture tree the refusal cases plant, removed after each case. */
const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

/** A one-entry manifest over `assetPaths`, the shape Vite writes for the entry document. */
function manifestNaming(assetPaths: readonly string[]): unknown {
  const [entryFile, ...remaining] = assetPaths;
  return { "index.html": { file: entryFile, isEntry: true, assets: remaining } };
}

/** One walk, read by both describes below; two measurements could disagree. */
const measurement: RendererBundleMeasurement = measureOrFailLoudly();

describe("renderer initial-graph budgets", () => {
  const gateReadings = RENDERER_BUNDLE_GATES.map((gate) => {
    const budget: Budget = registry.requireBudget(gate.budgetId);
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
        // Only code compresses: a `woff2` is a Brotli container already, which is why the font
        // row is gated raw.
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
    // Planted: a tree holding one stylesheet and one real face. The code figure is the sheet's
    // alone, so re-classing `woff2` as code fails this case.
    const stylesheet = measurement.assets.find((asset) => asset.relativePath.endsWith(".css"));
    const face = fontAssets[0];
    expect(stylesheet, "a stylesheet on the initial graph").toBeDefined();
    expect(face, "a face on the initial graph").toBeDefined();
    if (stylesheet === undefined || face === undefined) {
      return;
    }
    const directory = plantRendererOutput(
      plantedFixtures,
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
    // The property the 232 kB figure was chosen for, driven rather than asserted: every shipped
    // variable face plus one more file at the smallest size either foundry package publishes,
    // measured by the real measurer and judged by the real row. It is planted at that size, not
    // as a copy of a shipped face, because a copy of the 32 576 B mono face would clear the
    // ceiling and pass a far looser one too. The bytes are zeros: this gate weighs files and
    // parses none, so only the length matters.
    const additionalFacePath = "assets/additional-face-planted.woff2";
    const emittedFaces = new Map(
      fontAssets.map((asset) => [
        asset.relativePath,
        path.join(rendererOutputDirectory, asset.relativePath),
      ]),
    );
    const directory = plantRendererOutput(
      plantedFixtures,
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
