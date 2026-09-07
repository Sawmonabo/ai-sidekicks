// One way to take a screenshot, and the gate that keeps it the only one.
//
// WHY THE REFUSAL NEEDS A CHOKEPOINT AND NOT JUST A HELPER. `captureSettled` refuses to
// photograph a tree that still holds an unloaded pane body, which is the whole defence
// against minting a reference from a fallback frame. A defence written as a helper is
// only as good as the next author's knowledge that it exists: `toMatchScreenshot` is a
// global matcher, it is what every Vitest example calls, and a spec that calls it
// directly is green, stable, and outside the check. So the claim is not "the helper
// exists" but "no capture reaches the matcher any other way".
//
// THE ADMITTED SHAPE IS A CLASS, NOT A CALL SITE. One direct use is legitimate and will
// stay legitimate: the tier's fail-closed probe asserts that the matcher REJECTS on a
// reference it has never been given. That is not a capture — nothing is photographed and
// nothing is written — so the exemption is stated as what it is, an assertion that the
// call rejects, and any future probe of the same kind is admitted by the same rule
// rather than by being added to a list of file names.
//
// THE INSTRUMENT IS THE PARSER. A text scan for `toMatchScreenshot` counts the four
// mentions of it in the prose above this line, and would miss nothing a parse catches.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const SCREENSHOT_TIER_DIRECTORY = resolve(HERE, "..", "screenshot");

/** The matcher every capture ends at, whoever calls it. */
const CAPTURE_MATCHER = "toMatchScreenshot";

/** The one module allowed to call it, named by the path suffix a walk reports. */
const CAPTURE_CHOKEPOINT = "screenshot/settled-capture.ts";

/** The helper every spec is expected to reach the chokepoint through. */
const CAPTURE_HELPER = "captureSettled";

/**
 * The floor the populated-tier claim is measured against.
 *
 * Six spec files call `captureSettled` today. A gate asserting only "nobody calls the
 * matcher directly" would also pass over a tier that had stopped capturing anything,
 * which is what a suite quietly switched off looks like from the outside.
 */
const CAPTURING_SPEC_FLOOR = 4;

/**
 * The source ranges in which a `toMatchScreenshot` call is a rejection probe.
 *
 * A `PropertyAccessExpression` named `rejects` spans the whole assertion including the
 * promise it was handed — `expect(expect(element).toMatchScreenshot(name)).rejects` — so
 * a call inside that span is being asserted to fail rather than being taken.
 *
 * Ranges rather than a parent walk because the shared parse runs with `setParentNodes`
 * off, which its own module states and which nothing else here needs turned on.
 */
function rejectionRanges(parsed: ts.SourceFile): readonly (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  forEachDescendant(parsed, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "rejects") {
      ranges.push([node.pos, node.end]);
    }
  });
  return ranges;
}

/**
 * Every `toMatchScreenshot` call in one module that is an actual capture.
 *
 * Returns the calls' line numbers, so a failure names where to look rather than only
 * how many there were.
 */
export function directCaptureLines(source: string, fileName: string): readonly number[] {
  const parsed = parseSourceText(fileName, source);
  const admitted = rejectionRanges(parsed);
  const lines: number[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== CAPTURE_MATCHER) {
      return;
    }
    if (admitted.some(([start, end]) => node.pos >= start && node.end <= end)) {
      return;
    }
    lines.push(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
  });
  return lines;
}

/** Whether a module calls the shared helper at all. */
function callsCaptureHelper(source: string, fileName: string): boolean {
  const parsed = parseSourceText(fileName, source);
  let found = false;
  forEachDescendant(parsed, (node) => {
    if (ts.isIdentifier(node) && node.text === CAPTURE_HELPER) {
      found = true;
    }
  });
  return found;
}

function screenshotTierModules(): readonly ConsoleSourceModule[] {
  return consoleSourceModules({ roots: [SCREENSHOT_TIER_DIRECTORY], tests: true });
}

describe("the screenshot tier's capture chokepoint", () => {
  it("takes every capture through the settled-capture helper", () => {
    const offenders = screenshotTierModules()
      .filter((module) => !module.displayPath.endsWith(CAPTURE_CHOKEPOINT))
      .flatMap((module) => {
        const source = readConsoleSourceModule(module);
        return directCaptureLines(source, module.relativePath).map(
          (line) => `${module.displayPath}:${String(line)}`,
        );
      });
    expect(offenders).toStrictEqual([]);
  });

  // The populated half. Without it the claim above is satisfied by an empty tier.
  it("still captures, through that helper, in more than one spec", () => {
    const capturing = screenshotTierModules().filter(
      (module) =>
        !module.displayPath.endsWith(CAPTURE_CHOKEPOINT) &&
        module.displayPath.endsWith(".test.tsx") &&
        callsCaptureHelper(readConsoleSourceModule(module), module.relativePath),
    );
    expect(capturing.length).toBeGreaterThanOrEqual(CAPTURING_SPEC_FLOOR);
  });

  it("reaches the matcher exactly once, in the chokepoint itself", () => {
    const chokepoint = screenshotTierModules().find((module) =>
      module.displayPath.endsWith(CAPTURE_CHOKEPOINT),
    );
    expect(chokepoint, `${CAPTURE_CHOKEPOINT} is missing from the screenshot tier`).toBeDefined();
    const source = readConsoleSourceModule(chokepoint as ConsoleSourceModule);
    expect(directCaptureLines(source, "settled-capture.ts")).toHaveLength(1);
  });
});

describe("the capture reader, against planted text", () => {
  // The planted failure: the shape a spec written from a Vitest example has.
  it("reports a bare capture", () => {
    expect(
      directCaptureLines(
        'await expect(element).toMatchScreenshot("workflows-run-pane-light");',
        "planted.ts",
      ),
    ).toStrictEqual([1]);
  });

  // The admitted class, stated as a class: a call asserted to reject takes nothing.
  it("admits a capture that is asserted to reject", () => {
    expect(
      directCaptureLines(
        'await expect(expect(element).toMatchScreenshot("never-minted")).rejects.toThrowError();',
        "planted.ts",
      ),
    ).toStrictEqual([]);
  });

  // A mention is not a call, which is why the gate parses rather than greps — this
  // file's own header names the matcher four times.
  it("mints no offence from a mention in a comment or a string", () => {
    expect(
      directCaptureLines(
        '// call toMatchScreenshot here\nconst name = "toMatchScreenshot";\n',
        "planted.ts",
      ),
    ).toStrictEqual([]);
  });

  it("names every capture line rather than the first", () => {
    expect(
      directCaptureLines(
        'await expect(a).toMatchScreenshot("one");\nawait expect(b).toMatchScreenshot("two");\n',
        "planted.ts",
      ),
    ).toStrictEqual([1, 2]);
  });
});
