// The renderer initial-bundle budget gate — Plan-023 Phase 1C (T-023p-1C-1).
//
// Gates `Spec-023 §Console Design (Meridian)` §Budgets row 1 (≤ 450 kB gzip,
// excluding lazy chunks) against the built `out/renderer` tree.
//
// THIS TEST NEVER SKIPS ITSELF: a budget gate that turns itself off when its
// subject is missing reports green for a bundle nobody measured. The console
// budget Turbo task declares a `dependsOn: ["build"]` edge, so the build is
// present by construction in CI and in `pnpm test`; a bare `vitest run` in a
// clean checkout fails with the command that produces one. The refusal tests at
// the bottom are what make that claim evidence rather than an assumption.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  evaluateBudget,
  formatUnavailableBudgetReport,
} from "../../../scripts/budget/budget-registry.mjs";
import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RENDERER_BUNDLE_BUDGET_ID,
  RENDERER_MANIFEST_RELATIVE_PATH,
  RendererBundleMeasurer,
  RendererBundleOutputMissingError,
  formatRendererBundleReport,
  type RendererBundleMeasurement,
} from "../../../scripts/budget/measure-bundle.mjs";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(RENDERER_BUNDLE_BUDGET_ID);

/** An escape for measuring an out-of-tree build; NOT an escape from measuring. */
const rendererOutputDirectory: string =
  process.env["CONSOLE_BUDGET_RENDERER_OUT_DIR"] ?? DEFAULT_RENDERER_OUTPUT_DIRECTORY;

/**
 * Compression only shrinks input above roughly a container's worth of bytes; a
 * 60-byte declaration file gzips larger than it started. Assets below this size
 * are asserted to have a compressed reading at all, not a smaller one.
 */
const COMPRESSION_ASSERTION_FLOOR_BYTES = 1024;

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

/** A renderer out-dir holding exactly the manifest given, for the refusal paths. */
function outputDirectoryWithManifest(name: string, manifest: unknown): string {
  const directory = mkdtempSync(path.join(tmpdir(), `console-bundle-${name}-`));
  const manifestPath = path.join(directory, ...RENDERER_MANIFEST_RELATIVE_PATH.split("/"));
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  return directory;
}

describe("renderer initial-bundle budget", () => {
  const measurement = measureOrFailLoudly();
  const verdict = evaluateBudget(budget, measurement.gzipByteCount);

  it("measures a non-empty initial graph rooted in a manifest entry", () => {
    expect(measurement.entryKeys.length).toBeGreaterThan(0);
    expect(measurement.assets.length).toBeGreaterThan(0);
    expect(measurement.rawByteCount).toBeGreaterThan(0);
    const relativePaths = measurement.assets.map((asset) => asset.relativePath);
    expect(new Set(relativePaths).size, "an asset counted twice").toBe(relativePaths.length);
  });

  it("compresses every asset it counts, and totals exactly those assets", () => {
    for (const asset of measurement.assets) {
      expect(asset.gzipByteCount, `${asset.relativePath}: gzip`).toBeGreaterThan(0);
      expect(asset.brotliByteCount, `${asset.relativePath}: brotli`).toBeGreaterThan(0);
      if (asset.rawByteCount >= COMPRESSION_ASSERTION_FLOOR_BYTES) {
        expect(asset.gzipByteCount, `${asset.relativePath}: gzip < raw`).toBeLessThan(
          asset.rawByteCount,
        );
        expect(asset.brotliByteCount, `${asset.relativePath}: brotli < raw`).toBeLessThan(
          asset.rawByteCount,
        );
      }
    }
    const sumOf = (read: (asset: (typeof measurement.assets)[number]) => number): number =>
      measurement.assets.reduce((total, asset) => total + read(asset), 0);
    expect(measurement.rawByteCount).toBe(sumOf((asset) => asset.rawByteCount));
    expect(measurement.gzipByteCount).toBe(sumOf((asset) => asset.gzipByteCount));
    expect(measurement.brotliByteCount).toBe(sumOf((asset) => asset.brotliByteCount));
  });

  it(`stays within ${budget.specTarget}`, () => {
    console.log(formatRendererBundleReport(measurement, budget, verdict, registry));
    expect(
      verdict.withinBudget,
      `Renderer initial bundle is ${verdict.measuredCanonicalValue.toLocaleString("en-US")} B gzip ` +
        `against a ${verdict.limitCanonicalValue.toLocaleString("en-US")} B budget ` +
        `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget). ` +
        "Move code behind a dynamic import so it lands in a lazy chunk, or amend the budget in " +
        "`Spec-023 §Console Design (Meridian)` §Budgets first — the registry mirrors the spec, it does not set it.",
    ).toBe(true);
  });
});

// Negative controls. Each is a way the measurement could report zero bytes
// against a 450 kB ceiling; the harness must refuse rather than pass.
describe("bundle measurement refusals", () => {
  it("refuses a tree with no chunk manifest", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "console-bundle-empty-"));
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
});
