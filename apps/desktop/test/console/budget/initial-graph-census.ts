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
// `<chunk>.js.map` is the set of modules rolldown put in that chunk AND could name.
// Nothing here re-derives reachability, and nothing here parses an import.
//
// That distinction is measured rather than hedged: a module the bundler compiled out of
// a VIRTUAL specifier has no file behind it and contributes no `sources` entry, so it
// rides the chunk in no row. The console's compiled glyph faces are thirty-six such
// modules today. What a map names therefore bounds a chunk's membership from below and
// never from above — which is a property of the reading, and is why the pin next door
// says so where a reader meets it rather than only here.
//
// AND ONLY `sources`, NOT `mappings`. Attributing BYTES to a module means decoding the
// VLQ segment stream, and a decoder is a second implementation of something no other
// module in this package needs — while the claim this census makes is about MEMBERSHIP:
// a family that arrives on the initial graph is the finding, and the byte figure that
// follows from it is the budget row's, which is already gated next door.
//
// THIS FILE READS THE BUILD AND NOTHING ELSE. Which directory owns a module is
// `initial-graph-owners.ts`'s, for the reason that module's header gives and
// `built-renderer-tree.ts` already applies next door: a test-tier module that reads
// files of its own may hold no opinion about what counts as renderer source, because
// source has exactly one admission and a second opinion drifts from it in silence.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RendererBundleMeasurer,
  RendererBundleOutputMissingError,
  type RendererBundleMeasurement,
} from "../../../scripts/budget/measure-bundle.mjs";
import { initialGraphOwnerOf } from "./initial-graph-owners.js";

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

/** An emitted asset named without its content hash: `assets/index-CkKsISpn.css` → `index.css`. */
function stableChunkName(relativePath: string): string {
  return path.posix.basename(relativePath).replace(CHUNK_CONTENT_HASH, "$1");
}

/**
 * The modules one emitted chunk holds, out of the map the build wrote beside it.
 *
 * REFUSES A MISSING MAP rather than reporting an empty chunk, and refuses a malformed
 * one rather than reading the members it recognises. A census that read no modules — or
 * all but one of them — would report a smaller initial graph than the one that shipped,
 * and it would do it while every assertion over that census passed.
 */
function chunkSources(rendererOutputDirectory: string, relativePath: string): readonly string[] {
  const mapPath = path.join(
    rendererOutputDirectory,
    ...`${relativePath}.map`.split(path.posix.sep),
  );
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
  // EVERY MEMBER IS CHECKED, AND A BAD ONE REFUSES THE MAP. Filtering one out is the
  // same silence the arm above refuses one line earlier, only smaller: the census
  // reports fewer modules than the chunk holds, and the membership pin stays green on
  // what the other chunks contribute — so a bundler or plugin emitting a malformed map
  // would take a family off this list without failing a single check.
  const sourceMembers: readonly unknown[] = sources;
  const modules: string[] = [];
  for (const [index, member] of sourceMembers.entries()) {
    if (typeof member !== "string") {
      throw new RendererBundleOutputMissingError(
        rendererOutputDirectory,
        `${relativePath}.map carries a non-string \`sources\` member at index ${index} ` +
          `(\`${typeof member}\`), so the modules that chunk holds cannot be read`,
      );
    }
    modules.push(member);
  }
  return modules;
}

/**
 * Read the initial graph and attribute every module on it to a directory.
 *
 * @param rendererOutputDirectory - An escape for censusing an out-of-tree build; NOT an
 *   escape from censusing one. Defaults to what the budget harness measures, so the two
 *   always describe the same tree.
 * @throws {RendererBundleOutputMissingError} when there is no build to read, or when a
 *   chunk on the initial graph has no map beside it, or a map it cannot read whole.
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
