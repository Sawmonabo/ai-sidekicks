// The refusal paths of the renderer initial-graph census, and the cleanup that follows them.
//
// WHY THIS IS ITS OWN FILE. `initial-graph-census.test.ts` beside it reads the REAL build and
// plants nothing; every case here plants a tree and reads no build. The two halves share no
// fixture, no subject state, and no import beyond the modules under test — so the seam was
// already in the file, and the ~400-line ceiling in `apps/desktop/AGENTS.md` is only what made
// someone look at it. Nothing is duplicated across the split: the census half kept its pin and
// its reading, this half kept the planting.
//
// WHAT A REFUSAL BUYS THE PIN NEXT DOOR. Each case here is a reading that would otherwise be
// GREEN while describing less than it claims — a tree with no manifest, a chunk with no source
// map beside it, a map whose `sources` array drops a member. The owner pin catches none of
// them, because it pins the directories that REMAIN: a census short by a module is a census
// with a smaller set, and a smaller set reads as a diet that worked. The pin is therefore only
// as good as this census's refusal to report a subject it could not read in full, and these
// are the cases that hold it to that.
//
// AND THE FIXTURES ARE REMOVED. Every tree planted here goes on one trail an `afterEach`
// empties, with a negative control below reading the removal from AFTER the hook has run,
// which is the only place a removal is observable.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RENDERER_MANIFEST_RELATIVE_PATH,
  RendererBundleOutputMissingError,
} from "../../../scripts/budget/measure-bundle.mjs";
import { readInitialGraphCensus } from "./initial-graph-census.js";
import { TemporaryDirectoryTrail } from "./temporary-directory.js";

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

describe("census refusals", () => {
  it("refuses a tree with no chunk manifest", () => {
    const directory = plantedFixtures.create("console-census-empty-");
    expect(() => readInitialGraphCensus(directory)).toThrow(RendererBundleOutputMissingError);
  });

  it("refuses an initial chunk with no source map beside it", () => {
    // The reading that would otherwise pass while describing nothing: the manifest
    // resolves, the chunk file is there, and the census reads no modules out of it.
    const directory = outputDirectoryWithManifest("no-map", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    plantInitialChunk(directory);
    expect(() => readInitialGraphCensus(directory)).toThrow(/source map/u);
  });

  it("refuses a source map whose `sources` array holds a non-string member", () => {
    // The reading that would otherwise be short by one module, and green: the owner set
    // pins the directories that REMAIN and the non-empty checks are met by the other
    // chunks, so a dropped member takes a family off the graph in silence. A good member
    // either side of the bad one makes the drop the only difference.
    const directory = outputDirectoryWithManifest("malformed-sources", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    const mapPath = `${plantInitialChunk(directory)}.map`;
    writeFileSync(mapPath, JSON.stringify({ version: 3, sources: ["a.ts", 7, "b.ts"] }), "utf8");
    expect(() => readInitialGraphCensus(directory)).toThrow(/at index 1 \(`number`\)/u);
  });
});

describe("census fixture cleanup", () => {
  // The floor under the `afterEach` above, and the only place a removal is observable:
  // AFTER the hook has run. The first case plants a tree and records where, the second
  // reads that path once the hook has had its turn — and without the hook it is still
  // there, which is the finding: every run of the refusal suite left one behind.
  let plantedForTheControl = "";

  it("plants a fixture tree the refusal cases above drive", () => {
    plantedForTheControl = outputDirectoryWithManifest("cleanup-control", {
      "index.html": { file: "assets/index.js", isEntry: true },
    });
    expect(existsSync(plantedForTheControl)).toBe(true);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([plantedForTheControl]);
  });

  it("negative control: that tree is gone once the suite's hook has run", () => {
    expect(plantedForTheControl, "the case above did not run").not.toBe("");
    expect(
      existsSync(plantedForTheControl),
      "a census fixture outlived the test that planted it, so every local and CI run " +
        "leaves another tree behind under the system temporary directory",
    ).toBe(false);
    expect(plantedFixtures.plantedDirectories).toStrictEqual([]);
  });
});
