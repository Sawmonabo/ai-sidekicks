// The built output under `out/`, read two ways: the tier's one reader of build output.
//
// `release-absence.test.ts` asks which strings the shipped files carry (answered by the
// renderer's shipped text) and which modules rendered code into them (answered by the hidden
// source maps every build target writes). Both come from here, so the tier has one walk over
// what the bundler emitted and no reader of renderer source.
//
// Neither read skips when its subject is missing: an absence claim that passes because it read
// nothing is worse than none, so a missing or empty directory, or a target with no source maps,
// throws with the command that produces a build.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { DEFAULT_RENDERER_OUTPUT_DIRECTORY } from "../../scripts/budget/measure-bundle.mts";

/** One built file: where it sits in the renderer output, and what it holds. */
export interface BuiltFile {
  readonly relativePath: string;
  readonly text: string;
}

/**
 * One hidden source map: where it sits under `out/`, and the modules it lists. `sources` are
 * absolute paths because the fixture predicate names some folders by absolute path.
 */
export interface BuiltSourceMap {
  readonly relativePath: string;
  readonly sources: readonly string[];
}

/** The three build targets, each written to `out/<target>/` from `src/<target>/`. */
export const BUILD_TARGETS = ["main", "preload", "renderer"] as const;

/** `out/`, the directory every build target writes beneath. */
const BUILD_OUTPUT_DIRECTORY: string = dirname(DEFAULT_RENDERER_OUTPUT_DIRECTORY);

/** The extensions a shipped text file carries. Source maps are excluded: not shipped. */
const SHIPPED_TEXT_EXTENSIONS = /\.(?:js|cjs|mjs|html?|css)$/iu;

/** Every text file the renderer build ships, or a failure naming what to run. */
export function readBuiltTextOrFailLoudly(): readonly BuiltFile[] {
  const files = filesUnderOrFailLoudly(DEFAULT_RENDERER_OUTPUT_DIRECTORY)
    .filter((path) => SHIPPED_TEXT_EXTENSIONS.test(path))
    .map((path) => ({
      relativePath: relative(DEFAULT_RENDERER_OUTPUT_DIRECTORY, path),
      text: readFileSync(path, "utf8"),
    }));
  if (files.length === 0) {
    throw missingBuildError(DEFAULT_RENDERER_OUTPUT_DIRECTORY);
  }
  return files;
}

/**
 * Every source map one build target wrote, or a failure naming the cause. A target that built
 * but wrote no map fails with its own message: the maps come from `sourcemap: "hidden"` in
 * `electron.vite.config.ts`, and without them the module check would read nothing.
 */
export function readSourceMapsOrFailLoudly(
  target: (typeof BUILD_TARGETS)[number],
): readonly BuiltSourceMap[] {
  const directory = join(BUILD_OUTPUT_DIRECTORY, target);
  const maps = filesUnderOrFailLoudly(directory)
    .filter((path) => path.endsWith(".map"))
    .map((path) => {
      const map = JSON.parse(readFileSync(path, "utf8")) as { sources: string[] };
      return {
        relativePath: relative(BUILD_OUTPUT_DIRECTORY, path),
        sources: map.sources.map((source) => resolve(dirname(path), source)),
      };
    });
  if (maps.length === 0) {
    throw new Error(
      `The ${target} build at ${directory} wrote no source map.\n` +
        'The release fixture gate reads the maps `sourcemap: "hidden"` in ' +
        "`electron.vite.config.ts` asks for; without them it would check nothing.",
    );
  }
  return maps;
}

/** Every file under a build directory, or the missing-build failure if there is none. */
function filesUnderOrFailLoudly(directory: string): readonly string[] {
  if (!existsSync(directory)) {
    throw missingBuildError(directory);
  }
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function missingBuildError(directory: string): Error {
  return new Error(
    `No build to read at ${directory}.\n` +
      "Run `pnpm --filter @ai-sidekicks/desktop build` first. This gate does not " +
      "skip when its subject is missing: a release-absence check that passes " +
      "because it read nothing is worse than no check at all.",
  );
}
