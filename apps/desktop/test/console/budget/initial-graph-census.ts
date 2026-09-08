// Who is on the renderer's INITIAL import graph, read out of the build rather than
// argued from the source tree.
//
// WHY A SECOND READER BESIDE `measure-bundle.mts`. That harness answers one question —
// how many bytes the initial graph weighs — and answers it over emitted FILES, which is
// the unit a budget is stated in. It cannot answer the question a diet asks, which is
// which directories those bytes belong to: five assets carry roughly seven hundred
// modules between them, and a chunk that grew says nothing about what grew it. This
// module reads the same initial graph, through the same measurer so the initial/lazy
// split has ONE derivation, and resolves each chunk to the modules it holds.
//
// THE MODULE LIST COMES FROM THE CHUNK'S OWN SOURCE MAP, which is a fact the bundler
// emitted rather than a graph walk this file performs. `electron.vite.config.ts` builds
// the renderer with `sourcemap: "hidden"` — the map is written beside every chunk and
// no `sourceMappingURL` comment points at it — so the `sources` array of
// `<chunk>.js.map` is exactly the set of modules rolldown put in that chunk. Nothing
// here re-derives reachability, and nothing here parses an import.
//
// AND ONLY `sources`, NOT `mappings`. Attributing BYTES to a module means decoding the
// VLQ segment stream, and a decoder is a second implementation of something no other
// module in this package needs — while the claim this census makes is about MEMBERSHIP:
// a family that arrives on the initial graph is the finding, and the byte figure that
// follows from it is the budget row's, which is already gated next door.
//
// OWNERSHIP IS THE DIRECTORY, CAPPED. A module is attributed to its own directory
// truncated to at most {@link OWNER_PATH_SEGMENT_LIMIT} segments below the renderer
// source root, so `console/repos/mounts/roots/RootDisposalConfirmation.tsx` is
// `console/repos/mounts` and a whole sub-tree arriving eagerly reads as one row. Per
// FILE the census would be seven hundred rows that turn red whenever a family adds a
// module for reasons that have nothing to do with the initial graph; per FAMILY it
// could not have reported the settings page that arrived through a pane family's door.
// Three segments is where a sub-tree becomes visible and a file does not.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RendererBundleMeasurer,
  RendererBundleOutputMissingError,
  type RendererBundleMeasurement,
} from "../../../scripts/budget/measure-bundle.mjs";

/**
 * How many path segments an owner name carries below the renderer source root.
 *
 * Three: the family tree (`console`), the family (`repos`), and the sub-module
 * (`mounts`). A renderer subtree outside the console spends its first segment on the
 * subtree itself (`shell/composer/router`), which is the same depth counted from the
 * same root rather than a second rule for the second tree.
 */
export const OWNER_PATH_SEGMENT_LIMIT = 3;

/** Where renderer source lives, as a source-map path contains it. */
const RENDERER_SOURCE_ROOT = "src/renderer/src/";

/** The cross-process leaf, which sits beside the renderer rather than inside it. */
const CROSS_PROCESS_SOURCE_ROOT = "src/shared/";

/**
 * A dependency inside an installed tree, scoped or bare.
 *
 * Written to match the pnpm store layout this repository installs into
 * (`node_modules/.pnpm/<ident>/node_modules/<name>`) AND a flat `node_modules/<name>`,
 * by anchoring on the LAST `node_modules/` segment rather than on the store's shape: a
 * pattern that knew only about `.pnpm` would classify a hoisted dependency as
 * unclassified, and an unclassified module is a census row nobody can read.
 */
const INSTALLED_PACKAGE = /node_modules\/(@[^/]+\/[^/]+|[^/]+)(?:\/|$)(?![\s\S]*node_modules\/)/u;

/** A workspace package, which is built from this repository rather than installed. */
const WORKSPACE_PACKAGE = /(?:^|\/)packages\/([^/]+)\//u;

/** Vite's default `[name]-[hash]` suffix, so a chunk can be named without its hash. */
const CHUNK_CONTENT_HASH = /-[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)$/u;

/** What the census reports, and what a test pins. */
export interface InitialGraphCensus {
  /** The measurement the owner set was derived from, so a reader can print the bytes. */
  readonly measurement: RendererBundleMeasurement;
  /** Every initial asset, named without its content hash, sorted. */
  readonly chunkNames: readonly string[];
  /** Owner → the modules it put on the initial graph, sorted, keyed in sorted order. */
  readonly modulesByOwner: ReadonlyMap<string, readonly string[]>;
}

/**
 * Which directory owns one source-map source path.
 *
 * TOTAL, and the fall-through is a NAMED row rather than a discard: a source shape this
 * function does not recognise becomes `unclassified:<path>`, which shows up in the
 * census as an owner nobody pinned and fails the check that reads it. Dropping it would
 * make the census quietly smaller than the graph it claims to describe.
 */
export function initialGraphOwnerOf(source: string): string {
  const normalized = source.replaceAll(path.win32.sep, path.posix.sep);
  const installed = INSTALLED_PACKAGE.exec(normalized);
  if (installed?.[1] !== undefined) {
    return `package:${installed[1]}`;
  }
  const workspace = WORKSPACE_PACKAGE.exec(normalized);
  if (workspace?.[1] !== undefined) {
    return `workspace:${workspace[1]}`;
  }
  const rendererIndex = normalized.lastIndexOf(RENDERER_SOURCE_ROOT);
  if (rendererIndex >= 0) {
    return rendererOwnerOf(normalized.slice(rendererIndex + RENDERER_SOURCE_ROOT.length));
  }
  if (normalized.includes(CROSS_PROCESS_SOURCE_ROOT)) {
    return "src/shared";
  }
  return `unclassified:${normalized}`;
}

/**
 * The owner of a path already known to be renderer source, relative to that root.
 *
 * A module directly under the root belongs to no directory, and the sentinel says so in
 * words rather than as an empty string — which sorts first, reads as a missing value,
 * and is a prefix of every other name.
 */
function rendererOwnerOf(relativePath: string): string {
  const segments = relativePath.split(path.posix.sep);
  const directorySegments = segments.slice(0, Math.max(0, segments.length - 1));
  if (directorySegments.length === 0) {
    return "<renderer root>";
  }
  return directorySegments.slice(0, OWNER_PATH_SEGMENT_LIMIT).join(path.posix.sep);
}

/** An emitted asset named without its content hash: `assets/index-CkKsISpn.css` → `index.css`. */
function stableChunkName(relativePath: string): string {
  return path.posix.basename(relativePath).replace(CHUNK_CONTENT_HASH, "$1");
}

/**
 * The modules one emitted chunk holds, out of the map the build wrote beside it.
 *
 * REFUSES A MISSING MAP rather than reporting an empty chunk. A census that read no
 * modules would report a smaller initial graph than the one that shipped, and it would
 * do it while every assertion over that census passed.
 */
function chunkSources(rendererOutputDirectory: string, relativePath: string): readonly string[] {
  const mapPath = path.join(rendererOutputDirectory, ...`${relativePath}.map`.split("/"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    throw new RendererBundleOutputMissingError(
      rendererOutputDirectory,
      `${relativePath} has no readable source map beside it, so the modules it holds ` +
        'cannot be read. The renderer is built with `sourcemap: "hidden"`; a build ' +
        "that stopped emitting maps has to be reported rather than censused as empty",
    );
  }
  const sources = (parsed as { readonly sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    throw new RendererBundleOutputMissingError(
      rendererOutputDirectory,
      `${relativePath}.map carries no \`sources\` array`,
    );
  }
  return sources.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Read the initial graph and attribute every module on it to a directory.
 *
 * @param rendererOutputDirectory - An escape for censusing an out-of-tree build; NOT an
 *   escape from censusing one. Defaults to what the budget harness measures, so the two
 *   always describe the same tree.
 * @throws {RendererBundleOutputMissingError} when there is no build to read, or when a
 *   chunk on the initial graph has no map beside it.
 */
export function readInitialGraphCensus(
  rendererOutputDirectory: string = DEFAULT_RENDERER_OUTPUT_DIRECTORY,
): InitialGraphCensus {
  const measurement = new RendererBundleMeasurer(rendererOutputDirectory).measure();
  const modulesByOwner = new Map<string, string[]>();
  for (const asset of measurement.assets) {
    if (!asset.relativePath.endsWith(".js")) {
      // A stylesheet carries no modules of its own — it IS the concatenation of the
      // sheets on the graph — so it is censused by NAME above and by nothing here.
      continue;
    }
    for (const source of chunkSources(rendererOutputDirectory, asset.relativePath)) {
      const owner = initialGraphOwnerOf(source);
      const held = modulesByOwner.get(owner);
      if (held === undefined) {
        modulesByOwner.set(owner, [source]);
        continue;
      }
      held.push(source);
    }
  }
  return {
    measurement,
    chunkNames: measurement.assets.map((asset) => stableChunkName(asset.relativePath)).sort(),
    modulesByOwner: new Map(
      [...modulesByOwner.entries()]
        // Code-unit order and never `localeCompare`, which reads the host's collation:
        // a census pinned on one runner and compared on another would differ by where
        // that locale files `<` and `:` against a letter, and the diff would name a
        // reordering rather than the eager arrival this check exists to report.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([owner, modules]) => [owner, [...modules].sort()] as const),
    ),
  };
}
