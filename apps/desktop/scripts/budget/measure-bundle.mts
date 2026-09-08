#!/usr/bin/env node
// Renderer initial-graph budgets — Plan-023 Phase 1C (T-023p-1C-1).
//
// Walks the renderer's initial import graph, read from Vite's own
// `.vite/manifest.json` (`renderer.build.manifest: true` in
// electron.vite.config.ts): every entry chunk plus its transitive STATIC
// imports, stylesheets, and assets. A `dynamicImports` edge is never crossed,
// so lazy chunks stay out of the sum — which is what the budget excludes. The
// initial/lazy split is the bundler's; this file never re-derives it.
//
// ONE WALK, TWO SUMS. The graph carries two classes of byte and they are not
// commensurable, so one figure over both measures neither:
//
//   • CODE — the scripts and stylesheets the bundler emits. Gated GZIPPED
//     against `renderer-initial-bundle`, because the spec's figure is a gzip
//     figure and a script really is served compressed.
//   • FONTS — the self-hosted `woff2` faces `frame/bindings/typeface.ts` declares. Gated
//     RAW against `renderer-initial-fonts`. A `woff2` container is Brotli-
//     compressed already: gzipping one measured 28 B LARGER than the file, so
//     folding these into the compressed sum both overstated the total and stated
//     it in a unit that describes nothing about how the bytes are served. They
//     are bounded, and bounded in the unit that describes them.
//
// Both rows are ceilings on the same walk; the split is a change of unit and of
// accounting, never an exclusion. An asset in neither class is REFUSED rather
// than dropped, because a byte that falls out of both sums is the silent
// under-count these gates exist to prevent.
//
//   node --experimental-strip-types scripts/budget/measure-bundle.mts
// Exit: 0 within both budgets · 1 over either · 2 no build output / bad usage.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";

import { DESKTOP_PACKAGE_ROOT, type ConsoleBudgetRegistry } from "./budget-registry.mts";
import {
  BudgetSubjectMissingError,
  formatBudgetReport,
  formatBytes,
  runBudgetHarness,
  type BudgetGate,
  type BudgetGateReading,
} from "./budget-harness.mts";

/** The compressed-code ceiling — `Spec-023 §Console Design (Meridian)` §Budgets row 1. */
export const RENDERER_BUNDLE_BUDGET_ID: string = "renderer-initial-bundle";

/** The raw-font-byte ceiling, this harness's own row beside the spec's. */
export const RENDERER_FONTS_BUDGET_ID: string = "renderer-initial-fonts";

/** `electron.vite.config.ts` → `renderer.build.outDir`. */
export const DEFAULT_RENDERER_OUTPUT_DIRECTORY: string = path.join(
  DESKTOP_PACKAGE_ROOT,
  "out",
  "renderer",
);

/** Where Vite writes the chunk graph, relative to the output directory. */
export const RENDERER_MANIFEST_RELATIVE_PATH: string = ".vite/manifest.json";

/** Fixed so two runs of this harness are comparable. */
const GZIP_LEVEL = 9;

/**
 * What an initial-graph asset IS, and therefore which row bounds it.
 *
 * Closed on purpose, and read from the emitted file's extension because that is
 * what the bundler decided: a `.woff2` is a font whichever module imported it,
 * and a `.css` is code the document parses whichever family declared it.
 */
export type RendererBundleAssetClass = "code" | "font";

/**
 * The extension each class is emitted with.
 *
 * A closed map rather than a predicate with an `else`, so an emitted extension
 * nobody classified is a refusal instead of falling into whichever arm the `else`
 * happened to be. Every entry is a suffix the renderer build can actually emit.
 */
const ASSET_CLASS_BY_EXTENSION: ReadonlyMap<string, RendererBundleAssetClass> = new Map([
  [".js", "code"],
  [".mjs", "code"],
  [".css", "code"],
  [".woff2", "font"],
  [".woff", "font"],
  [".ttf", "font"],
  [".otf", "font"],
]);

/** The class an emitted file belongs to, or `undefined` when it belongs to none. */
export function rendererBundleAssetClassOf(
  relativePath: string,
): RendererBundleAssetClass | undefined {
  return ASSET_CLASS_BY_EXTENSION.get(path.extname(relativePath).toLowerCase());
}

export interface RendererBundleAsset {
  /** Relative to the output directory, POSIX separators. */
  readonly relativePath: string;
  readonly assetClass: RendererBundleAssetClass;
  readonly rawByteCount: number;
  readonly gzipByteCount: number;
  readonly brotliByteCount: number;
}

/** One class's share of the walk. Each figure sums exactly the assets of that class. */
export interface RendererBundleClassTotals {
  readonly assetCount: number;
  readonly rawByteCount: number;
  readonly gzipByteCount: number;
  readonly brotliByteCount: number;
}

export interface RendererBundleMeasurement {
  readonly rendererOutputDirectory: string;
  readonly measuredAt: string;
  /** Manifest keys marked `isEntry` — the roots the graph was walked from. */
  readonly entryKeys: readonly string[];
  /** Every file in the initial graph, sorted, each counted exactly once. */
  readonly assets: readonly RendererBundleAsset[];
  /** Scripts and stylesheets; its `gzipByteCount` is the compressed-code figure gated. */
  readonly code: RendererBundleClassTotals;
  /** Font files; its `rawByteCount` is the figure gated. */
  readonly fonts: RendererBundleClassTotals;
}

/** As much of Vite's manifest as the initial graph needs. */
interface RendererManifestRecord {
  /** This chunk's emitted path; `imports` holds manifest KEYS instead. */
  readonly file?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

/** Carries the command that produces the subject: a missing build never passes by default. */
export class RendererBundleOutputMissingError extends BudgetSubjectMissingError {
  constructor(rendererOutputDirectory: string, reason: string) {
    super(
      `No renderer build output to measure at ${rendererOutputDirectory}: ${reason}\n` +
        "Build it first:\n\n    pnpm --filter @ai-sidekicks/desktop build\n",
    );
    this.name = "RendererBundleOutputMissingError";
  }
}

/** Guards the one cast this file makes: a manifest field that lies is dropped, not trusted. */
function stringsIn(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((member): member is string => typeof member === "string")
    : [];
}

export class RendererBundleMeasurer {
  readonly #rendererOutputDirectory: string;

  constructor(rendererOutputDirectory: string = DEFAULT_RENDERER_OUTPUT_DIRECTORY) {
    this.#rendererOutputDirectory = rendererOutputDirectory;
  }

  #refuse(reason: string): never {
    throw new RendererBundleOutputMissingError(this.#rendererOutputDirectory, reason);
  }

  #resolve(relativePath: string): string {
    return path.join(this.#rendererOutputDirectory, ...relativePath.split("/"));
  }

  #readManifest(): Record<string, RendererManifestRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#resolve(RENDERER_MANIFEST_RELATIVE_PATH), "utf8"));
    } catch {
      this.#refuse(`no readable chunk manifest at ${RENDERER_MANIFEST_RELATIVE_PATH}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.#refuse(`${RENDERER_MANIFEST_RELATIVE_PATH} is not a record of chunks`);
    }
    return parsed as Record<string, RendererManifestRecord>;
  }

  #measureAsset(relativePath: string): RendererBundleAsset {
    const assetClass = rendererBundleAssetClassOf(relativePath);
    if (assetClass === undefined) {
      // An unclassified asset would sum into neither row, which is the same
      // silent under-count as a file that is not there at all.
      this.#refuse(
        `the chunk manifest names ${relativePath}, whose extension belongs to no asset class ` +
          `(${[...ASSET_CLASS_BY_EXTENSION.keys()].join(", ")}) — classify it before it can be budgeted`,
      );
    }
    let contents: Buffer;
    try {
      contents = readFileSync(this.#resolve(relativePath));
    } catch {
      // Counting a named-but-absent file as zero bytes is the silent under-count
      // this gate exists to prevent, so it refuses instead.
      this.#refuse(`the chunk manifest names ${relativePath}, which the output tree does not hold`);
    }
    return {
      relativePath,
      assetClass,
      rawByteCount: contents.byteLength,
      gzipByteCount: gzipSync(contents, { level: GZIP_LEVEL }).byteLength,
      brotliByteCount: brotliCompressSync(contents).byteLength,
    };
  }

  /** The four figures of one class, summed over exactly the assets in it. */
  #totalsFor(
    assets: readonly RendererBundleAsset[],
    assetClass: RendererBundleAssetClass,
  ): RendererBundleClassTotals {
    const inClass = assets.filter((asset) => asset.assetClass === assetClass);
    const sumOf = (read: (asset: RendererBundleAsset) => number): number =>
      inClass.reduce((total, asset) => total + read(asset), 0);
    return {
      assetCount: inClass.length,
      rawByteCount: sumOf((asset) => asset.rawByteCount),
      gzipByteCount: sumOf((asset) => asset.gzipByteCount),
      brotliByteCount: sumOf((asset) => asset.brotliByteCount),
    };
  }

  /** @throws {RendererBundleOutputMissingError} when the build output is absent. */
  measure(): RendererBundleMeasurement {
    const records = this.#readManifest();
    const entryKeys = Object.keys(records).filter((key) => records[key]?.isEntry === true);
    if (entryKeys.length === 0) {
      // An empty graph would measure zero bytes against a 450 kB ceiling.
      this.#refuse(`no record in ${RENDERER_MANIFEST_RELATIVE_PATH} is marked \`isEntry\``);
    }

    const initialFiles = new Set<string>();
    const visitedKeys = new Set<string>();
    const pendingKeys = [...entryKeys];
    for (let stepIndex = 0; stepIndex < pendingKeys.length; stepIndex += 1) {
      const manifestKey = pendingKeys[stepIndex];
      const record = manifestKey === undefined ? undefined : records[manifestKey];
      if (manifestKey === undefined || record === undefined || visitedKeys.has(manifestKey)) {
        continue;
      }
      visitedKeys.add(manifestKey);
      for (const emitted of [record.file, ...stringsIn(record.css), ...stringsIn(record.assets)]) {
        if (typeof emitted === "string" && emitted !== "") {
          initialFiles.add(emitted);
        }
      }
      // `dynamicImports` is deliberately not followed — a chunk reached only
      // across one is a lazy chunk, which is what the budget excludes.
      pendingKeys.push(...stringsIn(record.imports));
    }

    const assets = [...initialFiles].sort().map((relativePath) => this.#measureAsset(relativePath));
    return {
      rendererOutputDirectory: this.#rendererOutputDirectory,
      measuredAt: new Date().toISOString(),
      entryKeys,
      assets,
      code: this.#totalsFor(assets, "code"),
      fonts: this.#totalsFor(assets, "font"),
    };
  }
}

function formatAssetSizes(asset: RendererBundleAsset): string {
  return (
    `raw ${formatBytes(asset.rawByteCount)}  ` +
    `gzip ${formatBytes(asset.gzipByteCount)}  brotli ${formatBytes(asset.brotliByteCount)}`
  );
}

/** One class's block: its assets, then the two figures that class can be read in. */
function formatClassReadings(
  heading: string,
  measurement: RendererBundleMeasurement,
  assetClass: RendererBundleAssetClass,
  totals: RendererBundleClassTotals,
): readonly string[] {
  return [
    `${heading} — ${totals.assetCount} asset(s)`,
    ...measurement.assets
      .filter((asset) => asset.assetClass === assetClass)
      .map((asset) => `  ${asset.relativePath}  ${formatAssetSizes(asset)}`),
    `  TOTAL  raw ${formatBytes(totals.rawByteCount)}  ` +
      `gzip ${formatBytes(totals.gzipByteCount)}  brotli ${formatBytes(totals.brotliByteCount)}`,
  ];
}

export function formatRendererBundleReport(
  measurement: RendererBundleMeasurement,
  gateReadings: readonly BudgetGateReading[],
  registry: ConsoleBudgetRegistry,
): string {
  return formatBudgetReport(
    {
      title: "Renderer initial-graph budgets — Plan-023 T-023p-1C-1",
      provenance: [
        `  output tree:   ${measurement.rendererOutputDirectory}`,
        `  chunk graph:   ${RENDERER_MANIFEST_RELATIVE_PATH}, entries: ${measurement.entryKeys.join(", ")}`,
        `  measured at:   ${measurement.measuredAt}`,
      ],
      readings: [
        ...formatClassReadings("Code (gated gzipped)", measurement, "code", measurement.code),
        "",
        ...formatClassReadings("Fonts (gated raw)", measurement, "font", measurement.fonts),
        "",
        "Brotli is reported for every asset and gated for none.",
      ],
    },
    gateReadings,
    registry,
  );
}

/**
 * The two rows one walk of the initial graph answers, and the figure each takes.
 *
 * Exported so the bundle tier drives THESE gates rather than a copy of them: a
 * test that re-declared "the code row compares the gzip sum" would agree with
 * this file only while someone kept the two in step, and the gate the CLI runs
 * is the one that has to be right.
 */
export const RENDERER_BUNDLE_GATES: readonly BudgetGate<RendererBundleMeasurement>[] = [
  {
    budgetId: RENDERER_BUNDLE_BUDGET_ID,
    compare: (measurement) => measurement.code.gzipByteCount,
    measuredDescription: (measurement) =>
      `gzip over ${String(measurement.code.assetCount)} code asset(s)`,
  },
  {
    budgetId: RENDERER_FONTS_BUDGET_ID,
    compare: (measurement) => measurement.fonts.rawByteCount,
    measuredDescription: (measurement) =>
      `raw over ${String(measurement.fonts.assetCount)} font asset(s)`,
  },
];

/**
 * CLI entry point; returns the process exit code. It takes no options: the one
 * knob a caller ever needed is the output directory, and that is the measurer's
 * constructor argument.
 *
 * Two gates over one walk — see the header for why the classes are measured in
 * different units and why neither figure is the other's substitute.
 */
export function runBundleBudgetCommand(argumentList: readonly string[]): Promise<number> {
  if (argumentList.length > 0) {
    console.error(`measure-bundle.mts takes no arguments; got \`${argumentList.join(" ")}\`.`);
    return Promise.resolve(2);
  }
  return runBudgetHarness({
    gates: RENDERER_BUNDLE_GATES,
    measure: () => new RendererBundleMeasurer().measure(),
    format: formatRendererBundleReport,
    emitJson: false,
  });
}

// CLI only when this file is the entry point, so the Vitest project can import
// it without side effects.
// Compared through `realpathSync` on BOTH sides, never `import.meta.url ===
// pathToFileURL(argv[1])`: Node resolves the module URL through symlinks while
// argv[1] keeps the path as typed, so the naive form silently no-ops through a
// symlinked or spaced checkout and exits 0 over an unrun budget gate
// (`tools/__tests__/entry-guard.test.mjs` pins exactly this).
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runBundleBudgetCommand(process.argv.slice(2));
}
