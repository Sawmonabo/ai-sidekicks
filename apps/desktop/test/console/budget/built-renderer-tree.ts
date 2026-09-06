// The built renderer tree, read as text — the one walk over BUILD OUTPUT in this tier.
//
// A MODULE OF ITS OWN BECAUSE OF WHAT IT MUST NOT KNOW.
// `architecture/source-walk-chokepoint.test.ts` holds that a module reaching renderer
// SOURCE may not walk a directory of its own: source has one admission — the shared walk
// in `console-source-modules.ts` — and a second opinion about what counts as a console
// module drifts from the first silently. Build output has no such walk and needs none:
// it is whatever the bundler emitted, there is no admission question to get wrong, and
// the sweep that reads it wants every text file rather than a curated set.
//
// So the two subjects live in two modules. `release-absence.test.ts` reads the scenario
// corpus through the shared walk and reaches renderer source; this file reads the build
// and reaches none — no `CONSOLE_DIRECTORY`, no `renderer/src` path — so the chokepoint
// gate's own derived escape admits it without a name on any list. Folding the two back
// into one file is what put a second directory walk under a module that reasons about
// console source, which is the shape that gate exists to report.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { DEFAULT_RENDERER_OUTPUT_DIRECTORY } from "../../../scripts/budget/measure-bundle.mjs";

/** One built file: where it sits in the output tree, and what it holds. */
export interface BuiltFile {
  readonly relativePath: string;
  readonly text: string;
}

/** The extensions a shipped text file carries. Source maps are excluded: not shipped. */
const SHIPPED_TEXT_EXTENSIONS = /\.(?:js|cjs|mjs|html?|css)$/iu;

/** Text files in the built tree, excluding source maps, which are not shipped. */
function readBuiltText(): BuiltFile[] {
  const found: BuiltFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolutePath = join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!SHIPPED_TEXT_EXTENSIONS.test(entry)) {
        continue;
      }
      found.push({
        relativePath: relative(DEFAULT_RENDERER_OUTPUT_DIRECTORY, absolutePath),
        text: readFileSync(absolutePath, "utf8"),
      });
    }
  };
  walk(DEFAULT_RENDERER_OUTPUT_DIRECTORY);
  return found;
}

/**
 * The built tree, or a failure naming what to run.
 *
 * IT DOES NOT SKIP WHEN ITS SUBJECT IS MISSING. An absence claim that passes because it
 * read nothing is worse than no claim at all, so a missing directory and an empty one
 * are one situation here — there is no build to read — and both throw.
 */
export function readBuiltTextOrFailLoudly(): readonly BuiltFile[] {
  try {
    const files = readBuiltText();
    if (files.length > 0) {
      return files;
    }
  } catch {
    // Fall through to the same message: a missing directory and an empty one are one
    // situation from this tier's point of view — there is no build to read.
  }
  throw new Error(
    `No renderer build to read at ${DEFAULT_RENDERER_OUTPUT_DIRECTORY}.\n` +
      "Run `pnpm --filter @ai-sidekicks/desktop build` first. This gate does not " +
      "skip when its subject is missing: a release-absence check that passes " +
      "because it read nothing is worse than no check at all.",
  );
}
