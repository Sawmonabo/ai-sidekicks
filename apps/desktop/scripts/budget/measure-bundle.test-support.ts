// A planted renderer out-dir, for cases that drive the bundle measurer over a tree that is wrong in
// one way.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RENDERER_MANIFEST_RELATIVE_PATH } from "./measure-bundle.mts";
import type { TemporaryDirectoryTrail } from "#test/helpers/temporary-directory.ts";

/**
 * A renderer out-dir holding `manifest` and a copy of each emitted file, keyed by its path
 * inside the out-dir. The directory is registered on `trail`, which removes it.
 */
export function plantRendererOutput(
  trail: TemporaryDirectoryTrail,
  name: string,
  manifest: unknown,
  emittedFiles: ReadonlyMap<string, string> = new Map(),
): string {
  const directory = trail.create(`renderer-output-${name}-`);
  const manifestPath = path.join(directory, ...RENDERER_MANIFEST_RELATIVE_PATH.split("/"));
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  for (const [relativePath, sourcePath] of emittedFiles) {
    const emittedPath = path.join(directory, ...relativePath.split("/"));
    mkdirSync(path.dirname(emittedPath), { recursive: true });
    copyFileSync(sourcePath, emittedPath);
  }
  return directory;
}
