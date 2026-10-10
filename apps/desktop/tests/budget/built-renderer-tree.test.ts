// Which files the size check is handed. size-limit does the measuring, so the claim here is the
// selection: an entry's static imports are in, a lazy chunk and a worker's script are out, and a
// missing manifest or a missing listed file fails rather than shrinking the sum.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { TemporaryDirectoryTrail } from "../helpers/temporary-directory.js";
import { readInitialGraphOrFailLoudly } from "./built-renderer-tree.js";

const trail = new TemporaryDirectoryTrail();

afterEach(() => {
  trail.removeAll();
});

/**
 * A chunk manifest with an entry, a chunk it imports statically, a worker it starts by address and
 * a page it loads lazily.
 */
const MANIFEST = {
  "index.html": {
    file: "assets/index.js",
    isEntry: true,
    imports: ["_vendor.js"],
    dynamicImports: ["src/page.tsx"],
    css: ["assets/index.css"],
    assets: ["assets/face.woff2", "assets/worker.js"],
  },
  "_vendor.js": { file: "assets/vendor.js" },
  "src/page.tsx": {
    file: "assets/page.js",
    isDynamicEntry: true,
    imports: ["_vendor.js"],
    css: ["assets/page.css"],
  },
};

it("hands over the entry and its static imports, never a worker, and fails on a missing manifest or file", () => {
  const buildDirectory = trail.create("built-renderer-tree-");
  mkdirSync(join(buildDirectory, ".vite"));
  writeFileSync(join(buildDirectory, ".vite", "manifest.json"), JSON.stringify(MANIFEST));
  mkdirSync(join(buildDirectory, "assets"));
  for (const file of [
    "index.js",
    "index.css",
    "vendor.js",
    "face.woff2",
    "worker.js",
    "page.js",
    "page.css",
  ]) {
    writeFileSync(join(buildDirectory, "assets", file), "");
  }

  expect(readInitialGraphOrFailLoudly(buildDirectory)).toEqual({
    code: ["index.css", "index.js", "vendor.js"].map((file) =>
      join(buildDirectory, "assets", file),
    ),
    fonts: [join(buildDirectory, "assets", "face.woff2")],
  });

  rmSync(join(buildDirectory, "assets", "vendor.js"));
  expect(() => readInitialGraphOrFailLoudly(buildDirectory)).toThrow(
    /names assets\/vendor\.js, which does not glob to itself/u,
  );

  const emptyDirectory = trail.create("built-renderer-tree-empty-");
  expect(() => readInitialGraphOrFailLoudly(emptyDirectory)).toThrow(
    /No build to read at .*manifest\.json/u,
  );
});
