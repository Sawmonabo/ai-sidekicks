#!/usr/bin/env node
// Measures the renderer's initial import graph against `renderer-initial-bundle` and
// `renderer-initial-fonts`. The graph comes from Vite's `.vite/manifest.json`
// (`renderer.build.manifest: true` in electron.vite.config.ts): every entry chunk plus its
// transitive static imports, stylesheets and assets. A `dynamicImports` edge is never crossed, so
// lazy chunks stay out; the initial/lazy split is the bundler's and is not re-derived here.
//
// One walk, two sums, because code and fonts are not commensurable:
//   - code: scripts and stylesheets, gated gzipped, since the spec's figure is a gzip figure.
//   - fonts: the self-hosted `woff2` faces `src/renderer/src/styles/typeface.ts` declares, gated
//     raw. A `woff2` is already Brotli-compressed; gzipping one measured 28 B larger than the file.
//
// An asset in neither class is refused rather than dropped, because a byte that falls out of both
// sums is the silent under-count these gates exist to prevent.
//
//   node --experimental-strip-types scripts/budget/measure-bundle.mts
// Exit: 0 within both budgets · 1 over either · 2 no build output / bad usage.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { errorText } from "./budget-document.mts";
import { DESKTOP_PACKAGE_ROOT, type BudgetRegistry } from "./budget-registry.mts";
import {
  BudgetSubjectMissingError,
  formatBudgetReport,
  formatBytes,
  runBudgetHarness,
  type BudgetGate,
  type BudgetGateReading,
} from "./budget-harness.mts";

/** The compressed-code ceiling for the renderer's initial graph. */
export const RENDERER_BUNDLE_BUDGET_ID: string = "renderer-initial-bundle";

/** The raw-font-byte ceiling, a `harness` row beside the spec's code row. */
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
 * What an initial-graph asset is, and so which row bounds it. Read from the emitted file's
 * extension, which is what the bundler decided: a `.woff2` is a font whichever module imported it.
 */
export type RendererBundleAssetClass = "code" | "font";

/**
 * The extension each class is emitted with. A closed map, so an emitted extension nobody
 * classified is refused rather than falling into whichever arm an `else` happened to be.
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

/** One file of the initial graph, with its size raw and compressed. */
export interface RendererBundleAsset {
  /** Relative to the output directory, POSIX separators. */
  readonly relativePath: string;
  readonly assetClass: RendererBundleAssetClass;
  readonly rawByteCount: number;
  readonly gzipByteCount: number;
}

/** One class's share of the walk. Each figure sums exactly the assets of that class. */
export interface RendererBundleClassTotals {
  readonly assetCount: number;
  readonly rawByteCount: number;
  readonly gzipByteCount: number;
}

/** One walk of the initial graph: every asset, and the totals of each class. */
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

/** Walks the renderer build's initial graph and sums its assets by class. */
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
    } catch (manifestError) {
      this.#refuse(
        `no readable chunk manifest at ${RENDERER_MANIFEST_RELATIVE_PATH} ` +
          `(${errorText(manifestError)})`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.#refuse(`${RENDERER_MANIFEST_RELATIVE_PATH} is not a record of chunks`);
    }
    return parsed as Record<string, RendererManifestRecord>;
  }

  #measureAsset(relativePath: string): RendererBundleAsset {
    const assetClass = rendererBundleAssetClassOf(relativePath);
    if (assetClass === undefined) {
      // An unclassified asset would sum into neither row, the same silent under-count as a missing
      // file.
      this.#refuse(
        `the chunk manifest names ${relativePath}, whose extension belongs to no asset class ` +
          `(${[...ASSET_CLASS_BY_EXTENSION.keys()].join(", ")}) — classify it before it can be budgeted`,
      );
    }
    let contents: Buffer;
    try {
      contents = readFileSync(this.#resolve(relativePath));
    } catch (readError) {
      // Counting a named-but-unreadable file as zero bytes would be a silent under-count.
      this.#refuse(
        `the chunk manifest names ${relativePath}, which the output tree cannot give ` +
          `(${errorText(readError)})`,
      );
    }
    return {
      relativePath,
      assetClass,
      rawByteCount: contents.byteLength,
      gzipByteCount: gzipSync(contents, { level: GZIP_LEVEL }).byteLength,
    };
  }

  /** The figures of one class, summed over exactly the assets in it. */
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
    };
  }

  /** @throws {RendererBundleOutputMissingError} when the build output is absent. */
  measure(): RendererBundleMeasurement {
    const records = this.#readManifest();
    const entryKeys = Object.keys(records).filter((key) => records[key]?.isEntry === true);
    if (entryKeys.length === 0) {
      // An empty graph would measure zero bytes and pass any ceiling.
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
      // `dynamicImports` is not followed: a chunk reached only across one is lazy and excluded.
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
  return `raw ${formatBytes(asset.rawByteCount)}  gzip ${formatBytes(asset.gzipByteCount)}`;
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
    `  TOTAL  raw ${formatBytes(totals.rawByteCount)}  gzip ${formatBytes(totals.gzipByteCount)}`,
  ];
}

/** The report both gates print: each class's assets and totals, then the verdicts. */
export function formatRendererBundleReport(
  measurement: RendererBundleMeasurement,
  gateReadings: readonly BudgetGateReading[],
  registry: BudgetRegistry,
): string {
  return formatBudgetReport(
    {
      title: "Renderer initial-graph budgets",
      provenance: [
        `  output tree:   ${measurement.rendererOutputDirectory}`,
        `  chunk graph:   ${RENDERER_MANIFEST_RELATIVE_PATH}, entries: ${measurement.entryKeys.join(", ")}`,
        `  measured at:   ${measurement.measuredAt}`,
      ],
      readings: [
        ...formatClassReadings("Code (gated gzipped)", measurement, "code", measurement.code),
        "",
        ...formatClassReadings("Fonts (gated raw)", measurement, "font", measurement.fonts),
      ],
    },
    gateReadings,
    registry,
  );
}

/**
 * The two rows one walk of the initial graph answers, and the figure each takes. Exported so the
 * bundle tier drives these gates rather than a copy that could drift from what the CLI runs.
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
 * CLI entry point; returns the process exit code. It takes no options: the output directory is the
 * measurer's constructor argument.
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
  });
}

// CLI only when this file is the entry point, so Vitest can import it without side effects. Both
// sides go through `realpathSync`: Node resolves the module URL through symlinks while argv[1]
// keeps the path as typed, so the naive comparison silently no-ops through a symlinked or spaced
// checkout and exits 0 over an unrun gate (`tools/__tests__/entry-guard.test.mjs` pins this).
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runBundleBudgetCommand(process.argv.slice(2));
}
