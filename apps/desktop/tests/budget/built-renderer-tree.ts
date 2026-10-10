// The built output under `out/`, read four ways: the one reader of build output for this tier, for
// the bundle budgets and for the smoke launch.
//
// `release-absence.test.ts` asks which strings the shipped files carry (answered by the
// renderer's shipped text) and which modules rendered code into them (answered by the hidden
// source maps every build target writes). `.size-limit.ts` asks which files the renderer loads
// before any lazy chunk (answered by the bundler's chunk manifest), and the smoke launch which
// built file is the alignment worker's script (answered by the source maps again). All of them
// come from here, so there is one walk over what the bundler emitted and no reader of renderer
// source.
//
// No read skips when its subject is missing: a check that passes because it read nothing is worse
// than none, so a missing or empty directory, a target with no source maps, or a chunk manifest
// that names nothing to measure throws with what to run or fix.

import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { PACKAGE_ROOT } from "../helpers/fixture/bundle.ts";

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

/**
 * The files the renderer's entry document loads before any lazy chunk, as absolute paths, split by
 * budget kind: scripts and stylesheets are budgeted compressed, fonts as they are.
 */
export interface InitialGraph {
  readonly code: string[];
  readonly fonts: string[];
}

/** The folder of the main-process probes, which only a smoke build may ship. */
export const SMOKE_PROBE_FOLDER = "/src/main/probes/";

/** The three build targets, each written to `out/<target>/` from `src/<target>/`. */
export const BUILD_TARGETS = ["main", "preload", "renderer"] as const;

/** `out/`, the directory every build target writes beneath. */
const BUILD_OUTPUT_DIRECTORY: string = join(PACKAGE_ROOT, "out");

/** `out/renderer/`, the `renderer.build.outDir` of `electron.vite.config.ts`. */
const RENDERER_OUTPUT_DIRECTORY: string = join(BUILD_OUTPUT_DIRECTORY, "renderer");

/** The extensions a shipped text file carries. Source maps are excluded: not shipped. */
const SHIPPED_TEXT_EXTENSIONS = /\.(?:js|cjs|mjs|html?|css)$/iu;

/** The extensions of the initial graph's code: scripts and stylesheets. */
const CODE_EXTENSIONS = /\.(?:js|mjs|css)$/iu;

/** The alignment worker's own module, which only the worker's built script holds. */
const ALIGNMENT_WORKER_MODULE = "/src/features/repos/diff/intraline/worker/script.ts";

/** A font file by its extension: a face the renderer's sheets reference, and its built copy. */
export const FONT_EXTENSIONS: RegExp = /\.(?:woff2?|ttf|otf)$/iu;

/** Every text file the renderer build ships, or a failure naming what to run. */
export function readBuiltTextOrFailLoudly(): readonly BuiltFile[] {
  const files = filesUnderOrFailLoudly(RENDERER_OUTPUT_DIRECTORY)
    .filter((path) => SHIPPED_TEXT_EXTENSIONS.test(path))
    .map((path) => ({
      relativePath: relative(RENDERER_OUTPUT_DIRECTORY, path),
      text: readFileSync(path, "utf8"),
    }));
  if (files.length === 0) {
    throw missingBuildError(RENDERER_OUTPUT_DIRECTORY);
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

/**
 * The initial graph of the renderer build in `rendererOutputDirectory` (`out/renderer` unless
 * another is handed in), read off the chunk manifest its `manifest: true` config writes: every
 * entry chunk and what it reaches by static import, with its stylesheets and assets, so lazy
 * chunks stay out. Throws when the manifest is missing, marks no entry, names a chunk it does not
 * hold, or names a file of no budget kind or one that does not glob to itself, which size-limit
 * would drop.
 */
export function readInitialGraphOrFailLoudly(
  rendererOutputDirectory: string = RENDERER_OUTPUT_DIRECTORY,
): InitialGraph {
  const manifestPath = join(rendererOutputDirectory, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw missingBuildError(manifestPath);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;
  const pendingKeys = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true);
  if (pendingKeys.length === 0) {
    throw new Error(`${manifestPath} marks no chunk as an entry, so there is no graph.`);
  }

  const visitedKeys = new Set<string>();
  const emittedFiles = new Set<string>();
  for (const key of pendingKeys) {
    if (visitedKeys.has(key)) {
      continue;
    }
    const chunk = manifest[key];
    if (chunk === undefined) {
      throw new Error(`${manifestPath} imports a chunk \`${key}\` it does not hold.`);
    }
    visitedKeys.add(key);
    for (const emitted of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      emittedFiles.add(emitted);
    }
    pendingKeys.push(...(chunk.imports ?? []));
  }

  const initialGraph: InitialGraph = { code: [], fonts: [] };
  for (const emitted of [...emittedFiles].sort()) {
    const path = join(rendererOutputDirectory, emitted);
    const budgetKind = budgetKindOf(emitted);
    if (budgetKind === undefined) {
      throw new Error(
        `${emitted} is on the renderer's initial graph but its extension is in neither ` +
          "`CODE_EXTENSIONS` nor `FONT_EXTENSIONS` in `tests/budget/built-renderer-tree.ts`, " +
          "so no bundle budget would count it. Add it to the one whose budget should hold it.",
      );
    }
    const globbed = globSync(path);
    if (globbed.length !== 1 || globbed[0] !== path) {
      throw new Error(
        `${manifestPath} names ${emitted}, which does not glob to itself ` +
          `(found ${globbed.length === 0 ? "nothing" : globbed.join(", ")}), so size-limit ` +
          "would leave it out of the sum.",
      );
    }
    initialGraph[budgetKind].push(path);
  }
  return initialGraph;
}

/**
 * The built script of the window's alignment worker, as a path under `out/renderer/`: the one
 * renderer file whose hidden source map lists the worker's own module. Throws when no file or more
 * than one does.
 */
export function readAlignmentWorkerScriptOrFailLoudly(): string {
  const scripts = readSourceMapsOrFailLoudly("renderer")
    .filter((map) => map.sources.some((source) => source.endsWith(ALIGNMENT_WORKER_MODULE)))
    // A path in the served bundle's address, so its separators are slashes on every platform.
    .map((map) =>
      relative("renderer", map.relativePath)
        .replace(/\.map$/u, "")
        .split(sep)
        .join("/"),
    );
  const [script, ...others] = scripts;
  if (script === undefined || others.length > 0) {
    throw new Error(
      `${String(scripts.length)} renderer files list ${ALIGNMENT_WORKER_MODULE} in their source ` +
        "maps; the smoke probe starts the worker from the one built for it.",
    );
  }
  return script;
}

/** As much of one record of Vite's chunk manifest as the initial graph needs. */
interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  /** Manifest keys of the chunks this one imports statically. */
  readonly imports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

function budgetKindOf(emitted: string): keyof InitialGraph | undefined {
  if (CODE_EXTENSIONS.test(emitted)) {
    return "code";
  }
  return FONT_EXTENSIONS.test(emitted) ? "fonts" : undefined;
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

function missingBuildError(path: string): Error {
  return new Error(
    `No build to read at ${path}.\n` +
      "Run `pnpm --filter @ai-sidekicks/desktop build` first. This check does not skip when " +
      "its subject is missing: one that passes because it read nothing is worse than none.",
  );
}
