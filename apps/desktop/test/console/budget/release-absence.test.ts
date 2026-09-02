// Tier: bundle — what a RELEASE renderer build must not contain.
//
// `Spec-023 §Console Design (Meridian)` puts the fixture bridge, every scenario,
// and the scenario switcher behind `__SIDEKICKS_CONSOLE_FIXTURES__` so that Rollup
// collapses `if (false) { … }` and the bodies are PHYSICALLY ABSENT from a shipped
// bundle — not merely unreachable. The distinction is the whole point: unreachable
// code still ships a handle to the console's internals and a set of fabricated
// sessions to anyone who reads the file.
//
// The architecture tier already asserts the mechanism — that the assignment sits
// inside the guard, checked against source text in milliseconds. This asserts the
// OUTCOME, against the artifact a person would actually install, because a define
// that was misspelled, dropped from one build mode, or defeated by a bundler
// setting would leave the mechanism intact and the outcome wrong.
//
// LIKE ITS NEIGHBOURS, THIS NEVER SKIPS. An absent build fails with the command
// that produces one. A grep that finds nothing because it was pointed at nothing
// is the exact false pass this file exists to prevent, which is also why the
// positive control below is not optional decoration.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { TRIPWIRE_FIXTURE_GLOBAL } from "../../../src/renderer/src/console/core/index.js";
import { DEFAULT_RENDERER_OUTPUT_DIRECTORY } from "../../../scripts/budget/measure-bundle.mjs";

/**
 * A string every console build contains, fixture or release.
 *
 * The positive control. Without it a misdirected read — an empty directory, a
 * renamed output path, a tree holding only source maps — would report the fixture
 * global absent because it was reading nothing at all.
 */
const CONSOLE_PRESENCE_MARKER = "meridian-frame";

/** Text files in the built tree, excluding source maps, which are not shipped. */
function readBuiltText(): { readonly relativePath: string; readonly text: string }[] {
  const found: { relativePath: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolutePath = join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!/\.(?:js|cjs|mjs|html?|css)$/i.test(entry)) {
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

function readBuiltTextOrFailLoudly(): readonly {
  readonly relativePath: string;
  readonly text: string;
}[] {
  try {
    const files = readBuiltText();
    if (files.length > 0) {
      return files;
    }
  } catch {
    // Fall through to the same message: a missing directory and an empty one are
    // one situation from this tier's point of view — there is no build to read.
  }
  throw new Error(
    `No renderer build to read at ${DEFAULT_RENDERER_OUTPUT_DIRECTORY}.\n` +
      "Run `pnpm --filter @ai-sidekicks/desktop build` first. This gate does not " +
      "skip when its subject is missing: a release-absence check that passes " +
      "because it read nothing is worse than no check at all.",
  );
}

describe("release bundle — the fixture surface is absent, not merely unreachable", () => {
  const builtFiles = readBuiltTextOrFailLoudly();

  it("positive control: the sweep is reading a real console build", () => {
    // An absence claim is only as good as the evidence that the search happened.
    // This is the control for the test below rather than a fact worth asserting
    // on its own, and it runs first so a misdirected read is reported as "read
    // nothing" rather than as "shipped nothing".
    const carriers = builtFiles.filter((file) => file.text.includes(CONSOLE_PRESENCE_MARKER));
    expect(
      carriers.length,
      `no built file mentions "${CONSOLE_PRESENCE_MARKER}", so the absence claim below would be vacuous`,
    ).toBeGreaterThan(0);
  });

  it("does not ship the tripwire registry handle", () => {
    const carriers = builtFiles
      .filter((file) => file.text.includes(TRIPWIRE_FIXTURE_GLOBAL))
      .map((file) => file.relativePath);
    expect(
      carriers,
      `"${TRIPWIRE_FIXTURE_GLOBAL}" reached the built tree. Either the assignment left its ` +
        "`__SIDEKICKS_CONSOLE_FIXTURES__` guard, or `out/renderer` currently holds a " +
        "fixtures build — `pnpm build:fixtures` and `pnpm build` write the same directory. " +
        "Re-run `pnpm --filter @ai-sidekicks/desktop build` and try again.",
    ).toStrictEqual([]);
  });
});
