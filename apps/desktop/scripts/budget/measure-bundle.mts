#!/usr/bin/env node
// Renderer initial-bundle budget — Plan-023 Phase 1C (T-023p-1C-1).
//
// Sums the renderer's initial import graph, read from Vite's own
// `.vite/manifest.json` (`renderer.build.manifest: true` in
// electron.vite.config.ts): every entry chunk plus its transitive STATIC
// imports, stylesheets, and assets. A `dynamicImports` edge is never crossed,
// so lazy chunks stay out of the sum — which is what the budget excludes. The
// initial/lazy split is the bundler's; this file never re-derives it.
//
// Gates the gzip sum against the `renderer-initial-bundle` row of
// `test/console/budget/budgets.json`. Brotli is reported, never gated.
//
//   node --experimental-strip-types scripts/budget/measure-bundle.mts
// Exit: 0 within budget · 1 over budget · 2 no build output / bad usage.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";

import {
  DESKTOP_PACKAGE_ROOT,
  type ConsoleBudget,
  type ConsoleBudgetRegistry,
  type ConsoleBudgetVerdict,
} from "./budget-registry.mts";
import {
  BudgetSubjectMissingError,
  formatBudgetReport,
  formatBytes,
  runBudgetHarness,
} from "./budget-harness.mts";

export const RENDERER_BUNDLE_BUDGET_ID: string = "renderer-initial-bundle";

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

export interface RendererBundleAsset {
  /** Relative to the output directory, POSIX separators. */
  readonly relativePath: string;
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
  readonly rawByteCount: number;
  /** The figure compared against the budget. */
  readonly gzipByteCount: number;
  readonly brotliByteCount: number;
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
      rawByteCount: contents.byteLength,
      gzipByteCount: gzipSync(contents, { level: GZIP_LEVEL }).byteLength,
      brotliByteCount: brotliCompressSync(contents).byteLength,
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
    const sumOf = (read: (asset: RendererBundleAsset) => number): number =>
      assets.reduce((total, asset) => total + read(asset), 0);
    return {
      rendererOutputDirectory: this.#rendererOutputDirectory,
      measuredAt: new Date().toISOString(),
      entryKeys,
      assets,
      rawByteCount: sumOf((asset) => asset.rawByteCount),
      gzipByteCount: sumOf((asset) => asset.gzipByteCount),
      brotliByteCount: sumOf((asset) => asset.brotliByteCount),
    };
  }
}

export function formatRendererBundleReport(
  measurement: RendererBundleMeasurement,
  budget: ConsoleBudget,
  verdict: ConsoleBudgetVerdict,
  registry: ConsoleBudgetRegistry,
): string {
  const sizes = (raw: number, gzip: number, brotli: number): string =>
    `raw ${formatBytes(raw)}  gzip ${formatBytes(gzip)}  brotli ${formatBytes(brotli)}`;
  return formatBudgetReport(
    {
      title: "Renderer bundle budget — Plan-023 T-023p-1C-1",
      provenance: [
        `  output tree:   ${measurement.rendererOutputDirectory}`,
        `  chunk graph:   ${RENDERER_MANIFEST_RELATIVE_PATH}, entries: ${measurement.entryKeys.join(", ")}`,
        `  measured at:   ${measurement.measuredAt}`,
      ],
      readings: [
        `Initial graph — ${measurement.assets.length} asset(s); brotli reported, never gated`,
        ...measurement.assets.map(
          (asset) =>
            `  ${asset.relativePath}  ` +
            sizes(asset.rawByteCount, asset.gzipByteCount, asset.brotliByteCount),
        ),
        `  TOTAL  ${sizes(measurement.rawByteCount, measurement.gzipByteCount, measurement.brotliByteCount)}`,
      ],
      measuredDescription: `gzip over ${measurement.assets.length} asset(s)`,
    },
    budget,
    verdict,
    registry,
  );
}

/**
 * CLI entry point; returns the process exit code. It takes no options: the one
 * knob a caller ever needed is the output directory, and that is the measurer's
 * constructor argument.
 */
export function runBundleBudgetCommand(argumentList: readonly string[]): Promise<number> {
  if (argumentList.length > 0) {
    console.error(`measure-bundle.mts takes no arguments; got \`${argumentList.join(" ")}\`.`);
    return Promise.resolve(2);
  }
  return runBudgetHarness({
    budgetId: RENDERER_BUNDLE_BUDGET_ID,
    measure: () => new RendererBundleMeasurer().measure(),
    compare: (measurement: RendererBundleMeasurement) => measurement.gzipByteCount,
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
