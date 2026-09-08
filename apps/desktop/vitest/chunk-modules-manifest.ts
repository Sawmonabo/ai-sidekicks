// The bundler's own account of how many modules each emitted chunk holds, written beside
// Vite's chunk manifest so a reader of the build can tell a chunk that holds NOTHING from
// a chunk whose source map went missing.
//
// WHY THE SOURCE MAP IS NOT ENOUGH. `test/console/budget/initial-graph-census.ts` reads a
// chunk's membership out of the `sources` array of the map rolldown writes beside it, and
// refuses a chunk with no map rather than censusing it as empty — the right refusal, since
// a build that stopped emitting maps would otherwise read as a graph that emptied. But
// rolldown also emits chunks that were compiled out of NO module: when two or more chunks
// share CommonJS interop it hoists the `__commonJS` / `__toESM` runtime into a chunk of its
// own, and a chunk with no module behind it gets no map. Measured on the renderer build the
// first time a second lazy body shared that interop: `assets/chunk-<hash>.js`, statically
// imported by the entry, no map beside it, no `src` in the manifest — and the manifest
// cannot tell it apart from any other shared chunk, because the manifest records files and
// never modules.
//
// SO THE BUNDLER SAYS SO ITSELF. At `generateBundle` every chunk carries `moduleIds`, the
// list of modules rolldown put in it, and this plugin writes that COUNT per chunk. A chunk
// the table declares module-free is the one shape the census may admit without a map; a
// chunk the table declares modules for and that still has no map is exactly the refusal
// the census keeps.
//
// COUNTS AND NOT IDS, on purpose. The id list itself would be a second membership reading
// beside the map, and two readings of one fact drift. The census keeps the map as its
// membership source; this table answers only "does this chunk hold any module a map could
// name", which is why the count is split: a `\0`-prefixed id is a module the bundler
// compiled out of no file — the console's compiled glyph faces are such modules — and no
// map names it, so only the file-backed remainder says whether a map is owed.

import type { Plugin } from "vitest/config";

/** Where the table lands, beside Vite's own `.vite/manifest.json`. */
export const CHUNK_MODULES_MANIFEST_RELATIVE_PATH: string = ".vite/chunk-modules.json";

/** What the table records per emitted chunk, keyed by the chunk's output-relative path. */
export interface ChunkModulesRecord {
  /** Every module rolldown put in the chunk, virtual ones included. */
  readonly moduleCount: number;
  /** The `\0`-prefixed members of that count: compiled out of no file, named by no map. */
  readonly virtualModuleCount: number;
  /** The module this chunk is a facade for, where it is one. */
  readonly facadeModuleId: string | null;
  readonly isEntry: boolean;
  readonly isDynamicEntry: boolean;
}

/** The prefix rollup-family bundlers put on a module id that resolves to no file. */
const VIRTUAL_MODULE_ID_PREFIX = "\0";

/**
 * Write `.vite/chunk-modules.json` on every renderer build.
 *
 * `apply: "build"` because the table describes emitted chunks and a dev server emits none.
 * Keys are sorted in code-unit order so two builds of one tree write one file.
 */
export function chunkModulesManifestPlugin(): Plugin {
  return {
    name: "sidekicks:chunk-modules-manifest",
    apply: "build",
    generateBundle(_outputOptions, bundle) {
      const records: Record<string, ChunkModulesRecord> = {};
      for (const fileName of Object.keys(bundle).sort()) {
        const output = bundle[fileName];
        if (output === undefined || output.type !== "chunk") {
          continue;
        }
        records[fileName] = {
          moduleCount: output.moduleIds.length,
          virtualModuleCount: output.moduleIds.filter((moduleId) =>
            moduleId.startsWith(VIRTUAL_MODULE_ID_PREFIX),
          ).length,
          facadeModuleId: output.facadeModuleId,
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
        };
      }
      this.emitFile({
        type: "asset",
        fileName: CHUNK_MODULES_MANIFEST_RELATIVE_PATH,
        source: `${JSON.stringify(records, null, 2)}\n`,
      });
    },
  };
}
