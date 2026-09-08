// Which directory owns one module, read off the path the bundler wrote into a map.
//
// A MODULE OF ITS OWN BECAUSE OF WHAT ITS SIBLING MUST NOT KNOW, which is the seam
// `built-renderer-tree.ts` already draws next door and this is the second instance of it.
// `architecture/source-walk-chokepoint.test.ts` holds that a test-tier module reading
// files of its own may hold no opinion about what counts as renderer source — source has
// exactly one admission, the shared walk in `console-source-modules.ts`, and a second
// opinion drifts from the first silently. `initial-graph-census.ts` reads the build, so
// it may carry no such opinion; attributing a source-map path to a directory IS one. So
// the reading and the opinion live in two modules, and this is the opinion.
//
// AND IT READS NO FILE AT ALL, which is what makes the split real rather than cosmetic:
// every function here is pure over a string the caller already has, so the attribution
// is exercised against planted paths with no build in the tree — the same property that
// lets the census's own gate assert what a pnpm store path, a workspace path and a
// renderer path each resolve to without producing any of them.
//
// OWNERSHIP IS THE DIRECTORY, CAPPED. A module is attributed to its own directory
// truncated to at most {@link OWNER_PATH_SEGMENT_LIMIT} segments below the renderer
// source root, so `console/repos/mounts/roots/RootDisposalConfirmation.tsx` is
// `console/repos/mounts` and a whole sub-tree arriving eagerly reads as one row. Per
// FILE the census would be seven hundred rows that turn red whenever a family adds a
// module for reasons that have nothing to do with the initial graph; per FAMILY it
// could not have reported the settings page that arrived through a pane family's door.
// Three segments is where a sub-tree becomes visible and a file does not.
//
// AND THE OWNER COMES WITH A MODULE IDENTITY, which is the second half of one
// attribution rather than a second opinion: {@link initialGraphAttributionOf} answers
// both at once, and there is deliberately no owner-only wrapper beside it — a second
// entry point returning half the answer is an export the dead-code gate would report the
// moment its last caller moved. The identity is the path BELOW the owner, so an owner
// name and an identity reconstruct the module and neither repeats the other.
//
// WHY THE IDENTITY IS NOT THE PATH THE BUNDLER WROTE. A source-map source is relative
// to the emitted chunk and, for an installed dependency, runs through the pnpm store —
// `node_modules/.pnpm/@base-ui+react@1.7.0_@types+react@19.2.14_react-dom@19.2.6.../`.
// Pinned raw, a lockfile bump would rewrite hundreds of pin rows while the graph was
// unchanged, and a pin that churns for reasons the reader cannot check is a pin people
// regenerate without reading — which is the state the pin exists to leave. Below the
// owner, a dependency bump moves a row only when the FILES that dependency puts on the
// initial graph move, which is the membership claim being made.

import path from "node:path";

/**
 * How many path segments an owner name carries below the renderer source root.
 *
 * Three: the family tree (`console`), the family (`repos`), and the sub-module
 * (`mounts`). A renderer subtree outside the console spends its first segment on the
 * subtree itself (`shell/composer/router`), which is the same depth counted from the
 * same root rather than a second rule for the second tree.
 */
export const OWNER_PATH_SEGMENT_LIMIT = 3;

/**
 * The directory sequence that marks renderer source inside a source-map path.
 *
 * SEGMENTS AND NOT A PATH, and the difference is the whole point of this module: what
 * is written here is a needle looked for INSIDE a string the bundler emitted, never a
 * path anything opens. Nothing in this file reaches the file system, so there is no
 * path for it to compose.
 */
const RENDERER_SOURCE_SEGMENTS: readonly string[] = ["src", "renderer", "src"];

/** The same needle as one string, since that is how `lastIndexOf` takes it. */
const RENDERER_SOURCE_MARKER = `${RENDERER_SOURCE_SEGMENTS.join(path.posix.sep)}${path.posix.sep}`;

/** The cross-process leaf, which sits beside the renderer rather than inside it. */
const CROSS_PROCESS_SEGMENTS: readonly string[] = ["src", "shared"];

/** That leaf as one needle, for the same reason. */
const CROSS_PROCESS_MARKER = `${CROSS_PROCESS_SEGMENTS.join(path.posix.sep)}${path.posix.sep}`;

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

/** Where one module on the initial graph belongs, and what it is called there. */
export interface InitialGraphAttribution {
  /** The directory, package, or sentinel the module is censused under. */
  readonly owner: string;
  /** The module's own path BELOW that owner, so the two reconstruct it. */
  readonly moduleId: string;
}

/**
 * Which owner holds one source-map source path, and what that module is called there.
 *
 * TOTAL, and the fall-through is a NAMED row rather than a discard: a source shape this
 * function does not recognise becomes `unclassified:<path>`, which shows up in the
 * census as an owner nobody pinned and fails the check that reads it. Dropping it would
 * make the census quietly smaller than the graph it claims to describe.
 */
export function initialGraphAttributionOf(source: string): InitialGraphAttribution {
  const normalized = source.replaceAll(path.win32.sep, path.posix.sep);
  const installed = INSTALLED_PACKAGE.exec(normalized);
  if (installed?.[1] !== undefined && installed[0] !== undefined) {
    return {
      owner: `package:${installed[1]}`,
      moduleId: normalized.slice(installed.index + installed[0].length),
    };
  }
  const workspace = WORKSPACE_PACKAGE.exec(normalized);
  if (workspace?.[1] !== undefined && workspace[0] !== undefined) {
    return {
      owner: `workspace:${workspace[1]}`,
      moduleId: normalized.slice(workspace.index + workspace[0].length),
    };
  }
  const rendererIndex = normalized.lastIndexOf(RENDERER_SOURCE_MARKER);
  if (rendererIndex >= 0) {
    return rendererAttributionOf(normalized.slice(rendererIndex + RENDERER_SOURCE_MARKER.length));
  }
  const crossProcessIndex = normalized.lastIndexOf(CROSS_PROCESS_MARKER);
  if (crossProcessIndex >= 0) {
    return {
      owner: CROSS_PROCESS_SEGMENTS.join(path.posix.sep),
      moduleId: normalized.slice(crossProcessIndex + CROSS_PROCESS_MARKER.length),
    };
  }
  return { owner: `unclassified:${normalized}`, moduleId: normalized };
}

/**
 * The attribution of a path already known to be renderer source, relative to that root.
 *
 * A module directly under the root belongs to no directory, and the sentinel says so in
 * words rather than as an empty string — which sorts first, reads as a missing value,
 * and is a prefix of every other name.
 */
function rendererAttributionOf(relativePath: string): InitialGraphAttribution {
  const segments = relativePath.split(path.posix.sep);
  const directorySegments = segments.slice(0, Math.max(0, segments.length - 1));
  if (directorySegments.length === 0) {
    return { owner: "<renderer root>", moduleId: relativePath };
  }
  const ownerSegments = directorySegments.slice(0, OWNER_PATH_SEGMENT_LIMIT);
  return {
    owner: ownerSegments.join(path.posix.sep),
    moduleId: segments.slice(ownerSegments.length).join(path.posix.sep),
  };
}
