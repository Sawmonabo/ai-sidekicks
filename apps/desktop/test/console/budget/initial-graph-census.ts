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
// AND A CHUNK WITH NO MAP IS ADMITTED ON EXACTLY ONE SHOWING. rolldown emits chunks it
// compiled out of no file: when two or more chunks share CommonJS interop it hoists the
// `__commonJS` / `__toESM` runtime into a chunk of its own, and a chunk with no module
// behind it gets no map. A map-less chunk is otherwise the refusal below, and it stays
// one — the tie-breaker is the bundler's own per-chunk module count, which
// `vitest/chunk-modules-manifest.ts` writes beside the manifest on every build. A chunk
// that table declares module-free (no file-backed module, so no map is owed) is censused
// as holding nothing and NAMED on `moduleFreeChunks`, where the pin next door holds the
// set to what has been measured; a chunk the table declares modules for, or does not
// name, or that has no readable table to ask, refuses exactly as before. A map that names
// members always wins: the table is consulted only where the map does not answer.
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
import {
  CHUNK_MODULES_MANIFEST_RELATIVE_PATH,
  type ChunkModulesRecord,
} from "../../../vitest/chunk-modules-manifest.js";
import { initialGraphAttributionOf } from "./initial-graph-owners.js";

/** Vite's default `[name]-[hash]` suffix, so a chunk can be named without its hash. */
const CHUNK_CONTENT_HASH = /-[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)$/u;

/** What the census reports, and what a test pins. */
export interface InitialGraphCensus {
  /** The measurement the owner set was derived from, so a reader can print the bytes. */
  readonly measurement: RendererBundleMeasurement;
  /** Every initial asset, named without its content hash, sorted. */
  readonly chunkNames: readonly string[];
  /**
   * Owner → the modules it put on the initial graph, sorted, keyed in sorted order.
   *
   * A module is named by its path BELOW its owner, which is what makes this map
   * pinnable: `initial-graph-owners.ts`'s header says why the path the bundler wrote is
   * not. The owner and the name reconstruct the module, so nothing is lost.
   */
  readonly modulesByOwner: ReadonlyMap<string, readonly string[]>;
  /**
   * The initial chunks the bundler's own table declares module-free — compiled out of no
   * file, so no map names anything for them — without their content hashes, sorted.
   *
   * Pinned next door rather than merely tolerated: a second such chunk is a change in how
   * the bundler splits the graph, and that is a reading worth a red check even though it
   * moves no module.
   */
  readonly moduleFreeChunks: readonly string[];
}

/** The two members of a chunk's table record this census reads; the rest is not its business. */
type ChunkModuleCounts = Pick<ChunkModulesRecord, "moduleCount" | "virtualModuleCount">;

/** What the bundler's chunk table says about one chunk whose map did not answer. */
type ChunkTableReading =
  | { readonly kind: "module-free" }
  | { readonly kind: "holds-modules"; readonly fileBackedModuleCount: number }
  | { readonly kind: "unnamed" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The member list of a chunk that holds nothing. Held once; nothing ever writes to it. */
const NO_MEMBERS: readonly string[] = [];

function isChunkModuleCounts(value: unknown): value is ChunkModuleCounts {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const { moduleCount, virtualModuleCount } = value as {
    readonly moduleCount?: unknown;
    readonly virtualModuleCount?: unknown;
  };
  return (
    Number.isInteger(moduleCount) &&
    Number.isInteger(virtualModuleCount) &&
    (virtualModuleCount as number) >= 0 &&
    (virtualModuleCount as number) <= (moduleCount as number)
  );
}

/**
 * The bundler's chunk table, opened once and only when a map does not answer.
 *
 * LAZY, because the table is the tie-breaker and not the membership source: a build whose
 * every initial chunk carries a map naming members is censused without opening it, and it
 * is consulted on exactly the two readings a map cannot settle — no map, or a map naming
 * nobody. It answers a narrower question than a map does, which is whether the chunk holds
 * any module a map could name: a `\0`-prefixed id is a module the bundler compiled out of
 * no file, and no map names it, so only the file-backed remainder says whether a map is
 * owed. An unreadable table is REMEMBERED rather than re-read per chunk, so the refusal
 * that follows names the table once and the same way for every chunk that needed it.
 */
class ChunkModulesTable {
  readonly #rendererOutputDirectory: string;
  #records: ReadonlyMap<string, ChunkModuleCounts> | undefined;
  #unreadableReason: string | undefined;

  constructor(rendererOutputDirectory: string) {
    this.#rendererOutputDirectory = rendererOutputDirectory;
  }

  readingOf(relativePath: string): ChunkTableReading {
    const records = this.#load();
    if (records === undefined) {
      return {
        kind: "unreadable",
        reason:
          this.#unreadableReason ?? `${CHUNK_MODULES_MANIFEST_RELATIVE_PATH} could not be read`,
      };
    }
    const record = records.get(relativePath);
    if (record === undefined) {
      return { kind: "unnamed" };
    }
    const fileBackedModuleCount = record.moduleCount - record.virtualModuleCount;
    return fileBackedModuleCount > 0
      ? { kind: "holds-modules", fileBackedModuleCount }
      : { kind: "module-free" };
  }

  #load(): ReadonlyMap<string, ChunkModuleCounts> | undefined {
    if (this.#records !== undefined || this.#unreadableReason !== undefined) {
      return this.#records;
    }
    const tablePath = path.join(
      this.#rendererOutputDirectory,
      ...CHUNK_MODULES_MANIFEST_RELATIVE_PATH.split(path.posix.sep),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(tablePath, "utf8"));
    } catch {
      this.#unreadableReason = `there is no readable chunk table at ${CHUNK_MODULES_MANIFEST_RELATIVE_PATH}`;
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.#unreadableReason = `${CHUNK_MODULES_MANIFEST_RELATIVE_PATH} is not a record of chunks`;
      return undefined;
    }
    const records = new Map<string, ChunkModuleCounts>();
    for (const [fileName, record] of Object.entries(parsed)) {
      if (!isChunkModuleCounts(record)) {
        this.#unreadableReason = `${CHUNK_MODULES_MANIFEST_RELATIVE_PATH} carries a malformed record for ${fileName}`;
        return undefined;
      }
      records.set(fileName, {
        moduleCount: record.moduleCount,
        virtualModuleCount: record.virtualModuleCount,
      });
    }
    this.#records = records;
    return records;
  }
}

/**
 * The members of a chunk whose map did not answer, settled by the bundler's table.
 *
 * `mapProblem` is the clause the map earned — it leads every refusal here, because the
 * missing map is what a reader has to go and look at, and the table is only why the
 * census could not fill in for it.
 */
function membersOfMaplessChunk(
  rendererOutputDirectory: string,
  relativePath: string,
  table: ChunkModulesTable,
  mapProblem: string,
): readonly string[] {
  const reading = table.readingOf(relativePath);
  switch (reading.kind) {
    case "module-free":
      return NO_MEMBERS;
    case "holds-modules":
      throw new RendererBundleOutputMissingError(
        rendererOutputDirectory,
        `${mapProblem}, and the bundler's chunk table (${CHUNK_MODULES_MANIFEST_RELATIVE_PATH}) ` +
          `says it holds ${reading.fileBackedModuleCount} file-backed module(s), so the modules ` +
          'it holds cannot be read. The renderer is built with `sourcemap: "hidden"`; a build ' +
          "that stopped emitting maps has to be reported rather than censused as empty",
      );
    case "unnamed":
      throw new RendererBundleOutputMissingError(
        rendererOutputDirectory,
        `${mapProblem}, and the bundler's chunk table (${CHUNK_MODULES_MANIFEST_RELATIVE_PATH}) ` +
          "does not name it, so whether it holds any module at all cannot be read. A chunk on " +
          "disk that the build's own table never wrote is a tree the build did not produce",
      );
    case "unreadable":
      throw new RendererBundleOutputMissingError(
        rendererOutputDirectory,
        `${mapProblem}, and ${reading.reason}, so whether that chunk holds any module at all ` +
          "cannot be read. `vitest/chunk-modules-manifest.ts` writes the table on every " +
          "renderer build; a tree without one has to be reported rather than censused as empty",
      );
  }
}

/** An emitted asset named without its content hash: assets/index-CkKsISpn.css → `index.css`. */
function stableChunkName(relativePath: string): string {
  return path.posix.basename(relativePath).replace(CHUNK_CONTENT_HASH, "$1");
}

/**
 * The modules one emitted chunk holds, out of the map the build wrote beside it.
 *
 * REFUSES A MISSING MAP rather than reporting an empty chunk, refuses an EMPTY member
 * list rather than censusing the chunk as holding nothing, and refuses a malformed one
 * rather than reading the members it recognises — with one showing that settles the
 * first two the other way: the bundler's own table declaring that the chunk holds no
 * module a map could name (`membersOfMaplessChunk`). A census that read no modules — or
 * all but one of them — would report a smaller initial graph than the one that shipped,
 * and it would do it while every assertion over that census passed.
 */
function chunkMembers(
  rendererOutputDirectory: string,
  relativePath: string,
  table: ChunkModulesTable,
): readonly string[] {
  const mapPath = path.join(
    rendererOutputDirectory,
    ...`${relativePath}.map`.split(path.posix.sep),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    return membersOfMaplessChunk(
      rendererOutputDirectory,
      relativePath,
      table,
      `${relativePath} has no readable source map beside it`,
    );
  }
  const sources = (parsed as { readonly sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    throw new RendererBundleOutputMissingError(
      rendererOutputDirectory,
      `${relativePath}.map carries no \`sources\` array`,
    );
  }
  if (sources.length === 0) {
    // A JavaScript chunk holds at least the module that produced it, so a list naming
    // none of them is either a map that stopped describing the chunk or a chunk the
    // bundler compiled out of no file at all — and only the bundler can say which.
    return membersOfMaplessChunk(
      rendererOutputDirectory,
      relativePath,
      table,
      `${relativePath}.map carries an empty \`sources\` array`,
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
 *   chunk on the initial graph has no map beside it, or a map that does not name the
 *   modules that chunk holds in full.
 */
export function readInitialGraphCensus(
  rendererOutputDirectory: string = DEFAULT_RENDERER_OUTPUT_DIRECTORY,
): InitialGraphCensus {
  const measurement = new RendererBundleMeasurer(rendererOutputDirectory).measure();
  const table = new ChunkModulesTable(rendererOutputDirectory);
  const modulesByOwner = new Map<string, string[]>();
  const moduleFreeChunks: string[] = [];
  for (const asset of measurement.assets) {
    if (!asset.relativePath.endsWith(".js")) {
      // A stylesheet carries no modules of its own — it IS the concatenation of the
      // sheets on the graph — so it is censused by NAME above and by nothing here.
      continue;
    }
    const members = chunkMembers(rendererOutputDirectory, asset.relativePath, table);
    if (members.length === 0) {
      // Reachable only through the table's module-free showing: a map naming nobody
      // was refused or settled above, so an empty list here IS the bundler's own word.
      moduleFreeChunks.push(stableChunkName(asset.relativePath));
      continue;
    }
    for (const source of members) {
      const { owner, moduleId } = initialGraphAttributionOf(source);
      const held = modulesByOwner.get(owner);
      if (held === undefined) {
        modulesByOwner.set(owner, [moduleId]);
        continue;
      }
      held.push(moduleId);
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
    moduleFreeChunks: moduleFreeChunks.sort(),
  };
}
