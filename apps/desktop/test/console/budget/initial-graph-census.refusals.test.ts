// The refusal paths of the renderer initial-graph census, and the cleanup that follows them.
//
// WHY THIS IS ITS OWN FILE. `initial-graph-census.test.ts` beside it reads the REAL build and
// plants nothing; every case here plants a tree and reads no build. The two halves share no
// fixture, no subject state, and no import beyond the modules under test — so the seam was
// already in the file, and `apps/desktop/AGENTS.md` §Module shape is what splits on one.
// Nothing is duplicated across the split: the census half kept its pin and
// its reading, this half kept the planting.
//
// WHAT A REFUSAL BUYS THE PIN NEXT DOOR. Each case here is a reading that would otherwise be
// GREEN while describing less than it claims — a tree with no manifest, a chunk with no source
// map beside it, a map whose `sources` array drops a member, a map that names no member at
// all. The pin catches none of them, because it pins what REMAINS: a census short by a module
// — or short by a whole chunk — is a census with a shorter list, and a shorter list reads as a
// diet that worked. The pin is therefore only as good as this census's refusal to report a
// subject it could not read in full, and these are the cases that hold it to that.
//
// AND THE ONE ADMISSION IS PLANTED BESIDE THE REFUSALS. A chunk with no map is admitted on
// exactly one showing — the bundler's own table declaring it holds no file-backed module —
// so the cases below plant that table in every shape it can take: declaring the chunk
// module-free, declaring modules for it, not naming it, unreadable, and outvoted by a map
// that names members. The admission is a reading the pin next door then holds, which is
// why `moduleFreeChunks` is asserted here and not merely tolerated.
//
// AND THE OTHER SIDE OF THE COMPARISON REFUSES TOO. A pin that is absent, unparseable, in the
// wrong shape, out of order, or holding a module twice would compare a real build against
// something no census can produce, so `initial-graph-pin.ts` throws on each of those and the
// cases below plant one of each. The missing pin is the worst of them: read as a census, `[]`
// reports the whole initial graph as newly arrived, which is a thousand-line failure nobody
// reads and therefore the same silence as no check at all.
//
// AND THE FIXTURES ARE REMOVED. Every tree planted here goes on one trail an `afterEach`
// empties, with the cleanup controls below driving that trail's own removal.
//
// EACH CONTROL IS ONE CASE, WHICH IS A PROPERTY AND NOT A STYLE. The pair used to be two
// cases sharing a `let`: the first planted and recorded the path, the second read it once
// the hook had run. Run alone under `-t`, or in a shuffled order, the second case read an
// empty string and failed on its own scaffolding rather than on the claim — so the only
// control over the cleanup discipline was a case that could not be run by itself. Both
// controls now plant, remove, and observe inside one case, and neither reads a variable a
// sibling assigned.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
  RENDERER_MANIFEST_RELATIVE_PATH,
  RendererBundleOutputMissingError,
} from "../../../scripts/budget/measure-bundle.mjs";
import { CHUNK_MODULES_MANIFEST_RELATIVE_PATH } from "../../../vitest/chunk-modules-manifest.js";
import { readInitialGraphCensus } from "./initial-graph-census.js";
import { InitialGraphPinUnreadableError, readInitialGraphPin } from "./initial-graph-pin.js";
import { TemporaryDirectoryTrail } from "../temporary-directory.js";

/** Every fixture tree the refusal cases plant, removed after each of them. */
const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

/** A renderer out-dir holding exactly the manifest given, for the refusal paths. */
function outputDirectoryWithManifest(name: string, manifest: unknown): string {
  const directory = plantedFixtures.create(`console-census-${name}-`);
  const manifestPath = path.join(directory, ...RENDERER_MANIFEST_RELATIVE_PATH.split("/"));
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  return directory;
}

/** The chunk the manifest above names, so the measurer resolves and the census reads. */
function plantInitialChunk(directory: string): string {
  const chunkPath = path.join(directory, "assets", "index.js");
  mkdirSync(path.dirname(chunkPath), { recursive: true });
  writeFileSync(chunkPath, "export {};\n", "utf8");
  return chunkPath;
}

/** A renderer out-dir holding one manifest naming one initial chunk, and that chunk. */
function outputDirectoryWithInitialChunk(name: string): string {
  const directory = outputDirectoryWithManifest(name, {
    "index.html": { file: "assets/index.js", isEntry: true },
  });
  plantInitialChunk(directory);
  return directory;
}

/** The bundler's chunk table, planted with exactly the text given. */
function plantChunkTable(directory: string, table: unknown): void {
  const tablePath = path.join(directory, ...CHUNK_MODULES_MANIFEST_RELATIVE_PATH.split("/"));
  mkdirSync(path.dirname(tablePath), { recursive: true });
  writeFileSync(tablePath, JSON.stringify(table), "utf8");
}

/** A source map beside the planted chunk, naming exactly the members given. */
function plantChunkMap(directory: string, sources: readonly unknown[]): void {
  writeFileSync(
    path.join(directory, "assets", "index.js.map"),
    JSON.stringify({ version: 3, sources, mappings: "" }),
    "utf8",
  );
}

/** The shape the renderer build measured for its interop-runtime chunk: one virtual module. */
const MODULE_FREE_RECORD = { moduleCount: 1, virtualModuleCount: 1 } as const;

describe("census refusals", () => {
  it("refuses a tree with no chunk manifest", () => {
    const directory = plantedFixtures.create("console-census-empty-");
    expect(() => readInitialGraphCensus(directory)).toThrow(RendererBundleOutputMissingError);
  });

  it("refuses an initial chunk with no source map beside it and no table to ask", () => {
    // The reading that would otherwise pass while describing nothing: the manifest
    // resolves, the chunk file is there, and the census reads no modules out of it.
    // No table is planted, so the one showing that could admit the chunk is absent too.
    const directory = outputDirectoryWithInitialChunk("no-map");
    expect(() => readInitialGraphCensus(directory)).toThrow(/source map/u);
    expect(() => readInitialGraphCensus(directory)).toThrow(/no readable chunk table/u);
  });

  it("refuses a source map whose `sources` array holds a non-string member", () => {
    // The reading that would otherwise be short by one module, and green: the owner set
    // pins the directories that REMAIN and the non-empty checks are met by the other
    // chunks, so a dropped member takes a family off the graph in silence. A good member
    // either side of the bad one makes the drop the only difference.
    const directory = outputDirectoryWithInitialChunk("malformed-sources");
    plantChunkMap(directory, ["a.ts", 7, "b.ts"]);
    expect(() => readInitialGraphCensus(directory)).toThrow(/at index 1 \(`number`\)/u);
  });

  it("refuses a source map whose `sources` array names no members at all", () => {
    // The reading that would otherwise take a WHOLE chunk off the census while staying
    // green: the map parses, `Array.isArray` is met, the member loop runs zero times, and
    // the chunk contributes nothing to `modulesByOwner`. The assertions over the census
    // ask the graph AS A WHOLE to hold modules, and the other chunks meet that on their
    // own — so a map that regressed to `sources: []` reads as a chunk that got smaller.
    // With no table planted, nothing can say the chunk was compiled out of no file.
    const directory = outputDirectoryWithInitialChunk("empty-sources");
    plantChunkMap(directory, []);
    expect(() => readInitialGraphCensus(directory)).toThrow(
      /assets\/index\.js\.map carries an empty `sources` array/u,
    );
  });
});

describe("module-free chunks", () => {
  it("admits a map-less chunk the bundler's table declares module-free, and names it", () => {
    // The shape the renderer build measured: rolldown's shared CommonJS-interop runtime,
    // one virtual module and no file behind it, so no map is owed and none is written.
    const directory = outputDirectoryWithInitialChunk("module-free");
    plantChunkTable(directory, { "assets/index.js": MODULE_FREE_RECORD });

    const census = readInitialGraphCensus(directory);

    expect(census.moduleFreeChunks).toStrictEqual(["index.js"]);
    expect(census.modulesByOwner.size).toBe(0);
  });

  it("admits a map naming no member when the table declares the chunk module-free", () => {
    const directory = outputDirectoryWithInitialChunk("module-free-empty-map");
    plantChunkMap(directory, []);
    plantChunkTable(directory, { "assets/index.js": MODULE_FREE_RECORD });

    expect(readInitialGraphCensus(directory).moduleFreeChunks).toStrictEqual(["index.js"]);
  });

  it("refuses a map-less chunk the table says holds file-backed modules", () => {
    // The refusal the admission must not widen: the table is the bundler saying this
    // chunk DOES hold modules a map would name, so the missing map is the defect.
    const directory = outputDirectoryWithInitialChunk("holds-modules");
    plantChunkTable(directory, { "assets/index.js": { moduleCount: 3, virtualModuleCount: 1 } });

    expect(() => readInitialGraphCensus(directory)).toThrow(/holds 2 file-backed module/u);
    expect(() => readInitialGraphCensus(directory)).toThrow(/no readable source map/u);
  });

  it("refuses a map-less chunk the table does not name", () => {
    const directory = outputDirectoryWithInitialChunk("unnamed");
    plantChunkTable(directory, { "assets/other.js": MODULE_FREE_RECORD });

    expect(() => readInitialGraphCensus(directory)).toThrow(/does not name it/u);
  });

  it("refuses a table that is not a record of chunks", () => {
    const directory = outputDirectoryWithInitialChunk("table-not-record");
    plantChunkTable(directory, [MODULE_FREE_RECORD]);

    expect(() => readInitialGraphCensus(directory)).toThrow(/is not a record of chunks/u);
  });

  it("refuses a table carrying a malformed record", () => {
    // A count that is not an integer, or a virtual count past the total, is a table
    // that stopped describing the build — read as module-free it would admit anything.
    const directory = outputDirectoryWithInitialChunk("table-malformed");
    plantChunkTable(directory, { "assets/index.js": { moduleCount: 1, virtualModuleCount: 2 } });

    expect(() => readInitialGraphCensus(directory)).toThrow(
      /malformed record for assets\/index\.js/u,
    );
  });

  it("negative control: a map naming members outvotes a table declaring the chunk module-free", () => {
    // The table is the tie-breaker and never the membership source. A map that names a
    // member is read, the member is attributed, and the chunk is NOT on the module-free
    // list — whatever the table says about it.
    const directory = outputDirectoryWithInitialChunk("map-wins");
    plantChunkMap(directory, ["src/renderer/src/console/core/clock.ts"]);
    plantChunkTable(directory, { "assets/index.js": MODULE_FREE_RECORD });

    const census = readInitialGraphCensus(directory);

    expect(census.modulesByOwner.get("console/core")).toStrictEqual(["clock.ts"]);
    expect(census.moduleFreeChunks).toStrictEqual([]);
  });
});

describe("committed-pin refusals", () => {
  /** A pin file holding exactly the text given, in a tree planted for this case alone. */
  function pinFileHolding(name: string, contents: string): string {
    const pinPath = path.join(
      plantedFixtures.create(`console-census-pin-${name}-`),
      "initial-graph-census.pinned.json",
    );
    writeFileSync(pinPath, contents, "utf8");
    return pinPath;
  }

  it("refuses a pin that is not on disk", () => {
    const absent = path.join(plantedFixtures.create("console-census-pin-absent-"), "nothing.json");
    expect(() => readInitialGraphPin(absent)).toThrow(InitialGraphPinUnreadableError);
    expect(() => readInitialGraphPin(absent)).toThrow(/regenerated with/u);
  });

  it("refuses a pin that is not an array of owner-qualified modules", () => {
    // An owner-to-modules object parses as JSON and reads as a census to a person, so a
    // pin hand-written in that shape would be compared entry by entry against a flat
    // list — everything missing on both sides, which reads as a graph that changed
    // entirely rather than as a pin in the wrong shape.
    const asObject = pinFileHolding("object", JSON.stringify({ "console/core": ["a.ts"] }));
    expect(() => readInitialGraphPin(asObject)).toThrow(/not an array of owner-qualified/u);
  });

  it("refuses a pin holding a non-string entry", () => {
    const malformed = pinFileHolding("malformed", JSON.stringify(["console/core/a.ts", 7]));
    expect(() => readInitialGraphPin(malformed)).toThrow(/at index 1 \(`number`\)/u);
  });

  it("refuses a pin that is out of code-unit order", () => {
    const unordered = pinFileHolding("unordered", JSON.stringify(["b/second.ts", "a/first.ts"]));
    expect(() => readInitialGraphPin(unordered)).toThrow(/not in code-unit order/u);
  });

  it("refuses a pin that names one module twice", () => {
    const duplicated = pinFileHolding("duplicated", JSON.stringify(["a/one.ts", "a/one.ts"]));
    expect(() => readInitialGraphPin(duplicated)).toThrow(/names a module twice/u);
  });
});

describe("census fixture cleanup", () => {
  // The floor under the `afterEach` above: the removal that hook performs is
  // `TemporaryDirectoryTrail.removeAll()`, so the control drives THAT — planting a tree
  // on the very trail the refusal cases plant on, draining it, and reading the disk
  // afterwards, all inside one case.

  it("removes every tree the refusal suite's own trail is holding", () => {
    const planted = outputDirectoryWithManifest("cleanup-control", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    expect(existsSync(planted)).toBe(true);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([planted]);

    plantedFixtures.removeAll();

    expect(
      existsSync(planted),
      "a census fixture outlived the removal that was asked to take it, so every local " +
        "and CI run leaves another tree behind under the system temporary directory",
    ).toBe(false);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([]);
  });

  it("negative control: a trail nobody drains leaves its tree on disk", () => {
    // What makes the case above a check rather than a tautology. A removal that never
    // ran and a removal that ran and did nothing leave the same disk, so this plants on
    // a trail the suite's hook does not hold, does NOT drain it, and shows the tree is
    // still there — the state the assertion above would report.
    const undrained = new TemporaryDirectoryTrail();
    onTestFinished(() => {
      undrained.removeAll();
    });

    const planted = undrained.create("console-census-undrained-");

    expect(existsSync(planted)).toBe(true);
    expect(undrained.plantedDirectories).toStrictEqual([planted]);
  });
});
