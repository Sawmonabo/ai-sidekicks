// The clipping-ancestor chokepoint, asserted.
//
// Deciding whether an ancestor clips is four lines — a computed-style read, a membership
// test, and the two axis names — so a second one is never introduced deliberately. It
// arrives inside a family that needed to know what was hiding its own element. The
// console had exactly that: `workspace/deck/rect-geometry.ts` intersected the boxes and
// `browser/geometry/geometry-publisher.ts` collected them, and by the time both were read
// side by side they disagreed about the data structure, about whether the `overflow`
// shorthand counts, and about whether the answer was tested at all. Both are
// `primitives/clipping-ancestors.ts` now, and this is what keeps that true — a claim no
// type and no layering rule can make, because reading a property off a computed style is
// not an import.
//
// WHAT COUNTS AS DECIDING. Reading an overflow value off a style, in any of the forms this
// tree can write: either axis by property name, by element access, or through
// `getPropertyValue`; and the shorthand when it is taken off a `getComputedStyle` call.
// The shorthand is qualified and the axes are not, because `overflow` is also an ordinary
// field name in this tree — the run controls carry an `overflow` set of their own — while
// `overflowX` and `overflowY` name nothing else anywhere in it.
//
// THE INSTRUMENT IS THE PARSER. `source.includes("overflowX")` cannot tell a read from a
// sentence about one, so this file's own header would trip its own rule if it were a
// module under scan, and `offered.overflow` in `runs/pane/controls/` would be reported as
// a clipping decision. A property access and a call argument are declaration boundaries,
// which `apps/desktop/AGENTS.md` says to answer with the compiler rather than a pattern.
//
// Test files are excluded: a fake has to report the shape it stands in for, and forbidding
// that would forbid testing the chokepoint at all.

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The budget this file states rather than inherits, and it is the figure its neighbours
 * already state for the same reason: its claim is a parse pass over every console module,
 * so what it costs is a property of the TREE and grows with it, and what a budget guards
 * is a pass that never settles rather than a slow one.
 */
const CONSOLE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: CONSOLE_PARSE_ALLOWANCE_MS });

/**
 * The one module allowed to decide whether an ancestor clips.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a naming
 * convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = "primitives/clipping-ancestors.ts";

/** The axis names, which name nothing else in this tree, in both spellings. */
const AXIS_PROPERTY_NAMES = ["overflowX", "overflowY"] as const;
const AXIS_CSS_NAMES = ["overflow-x", "overflow-y"] as const;

/** The shorthand, which is an ordinary field name elsewhere and so is always qualified. */
const SHORTHAND_PROPERTY_NAME = "overflow";

/** The labels a failure reports — what was found, never the needle that found it. */
const READ_FORMS = {
  axisProperty: "an overflow axis by property name",
  axisElementAccess: "an overflow axis by element access",
  axisPropertyValue: "an overflow axis through getPropertyValue",
  shorthandOffComputedStyle: "the overflow shorthand off getComputedStyle",
  shorthandPropertyValue: "the overflow shorthand through getPropertyValue",
} as const;

/** Whether `node` is a call of `getComputedStyle`, bare or off a receiver. */
function isComputedStyleCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === "getComputedStyle";
  }
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "getComputedStyle";
}

/** The literal text of a call's first argument, or `undefined` when it is not one. */
function firstStringArgument(node: ts.CallExpression): string | undefined {
  const [first] = node.arguments;
  return first !== undefined && ts.isStringLiteral(first) ? first.text : undefined;
}

/** Whether `name` is one of the two axis property names. */
function isAxisPropertyName(name: string): boolean {
  return AXIS_PROPERTY_NAMES.some((axisName) => axisName === name);
}

/** Whether `name` is one of the two axis CSS property names. */
function isAxisCssName(name: string): boolean {
  return AXIS_CSS_NAMES.some((axisName) => axisName === name);
}

/**
 * Every way `source` shows it read an overflow value off a style, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative controls
 * below can drive it with strings whose verdict is known and the checker is proved to bite
 * without perturbing a real module. Sorted, so a module that writes two forms reports them
 * in one order.
 */
function overflowReadSignatures(fileName: string, source: string): readonly string[] {
  const found = new Set<string>();
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (isAxisPropertyName(node.name.text)) {
        found.add(READ_FORMS.axisProperty);
        return;
      }
      if (node.name.text === SHORTHAND_PROPERTY_NAME && isComputedStyleCall(node.expression)) {
        found.add(READ_FORMS.shorthandOffComputedStyle);
      }
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const accessed = node.argumentExpression;
      if (ts.isStringLiteral(accessed) && isAxisPropertyName(accessed.text)) {
        found.add(READ_FORMS.axisElementAccess);
      }
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text !== "getPropertyValue") {
        return;
      }
      const requested = firstStringArgument(node);
      if (requested === undefined) {
        return;
      }
      if (isAxisCssName(requested)) {
        found.add(READ_FORMS.axisPropertyValue);
        return;
      }
      if (requested === SHORTHAND_PROPERTY_NAME) {
        found.add(READ_FORMS.shorthandPropertyValue);
      }
    }
  });
  return [...found].sort();
}

/**
 * Every console source module, through the tier's one walk — console-relative, because
 * that is the name every message below reports.
 */
const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

function readSignaturesOf(module: string): readonly string[] {
  return overflowReadSignatures(module, readModuleNamed(CONSOLE_MODULES, `console/${module}`));
}

describe("clipping-ancestors — one module decides whether an ancestor clips", () => {
  const modules = consoleRelativePaths(CONSOLE_MODULES);

  it("finds a console tree to scan at all", () => {
    // Without this, a walk that reached nothing would leave the assertion below passing
    // over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module reads an overflow value off a style", () => {
    const offenders = modules
      .filter((module) => module !== CHOKEPOINT_MODULE)
      .map((module) => ({ module, signatures: readSignaturesOf(module) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips the checker", () => {
    // The checker reads real files and the shapes match real code. Without this, a wrong
    // node predicate would make the clean result above meaningless — which is exactly the
    // state the deck's own walk was found in.
    expect(readSignaturesOf(CHOKEPOINT_MODULE)).toContain(READ_FORMS.axisProperty);
  });

  it("negative control: the two walks this replaced are what it catches", () => {
    // The literal shapes both copies carried, driven through the predicate rather than
    // through a planted edit, so the claim survives either module being renamed.
    expect(
      overflowReadSignatures(
        "rect-geometry.ts",
        "return (\n  CLIPPING_OVERFLOW_VALUES.has(style.overflowX) ||\n  CLIPPING_OVERFLOW_VALUES.has(style.overflow)\n);",
      ),
    ).toStrictEqual([READ_FORMS.axisProperty]);
    expect(
      overflowReadSignatures(
        "geometry-publisher.ts",
        'if (clipsItsContents(style["overflowY"])) {\n  rects.push(readElementRect(ancestor));\n}',
      ),
    ).toStrictEqual([READ_FORMS.axisElementAccess]);
    expect(
      overflowReadSignatures("walk.ts", "const clipped = getComputedStyle(ancestor).overflow;"),
    ).toStrictEqual([READ_FORMS.shorthandOffComputedStyle]);
    expect(
      overflowReadSignatures(
        "walk.ts",
        'const clipped = window.getComputedStyle(ancestor).getPropertyValue("overflow-x");',
      ),
    ).toStrictEqual([READ_FORMS.axisPropertyValue]);
    expect(
      overflowReadSignatures("walk.ts", 'const clipped = computed.getPropertyValue("overflow");'),
    ).toStrictEqual([READ_FORMS.shorthandPropertyValue]);
  });

  it("negative control: a field that happens to be called overflow is not a decision", () => {
    // The claim the qualification above makes, and the reason the shorthand arm is
    // qualified at all: the run controls carry a set named `overflow`, and a checker that
    // read the bare name would report that module as a second clipping walk.
    expect(
      overflowReadSignatures(
        "run-control-gating.ts",
        "for (const control of [...offered.primary, ...offered.overflow]) {\n  offer(control);\n}",
      ),
    ).toStrictEqual([]);
    expect(
      overflowReadSignatures("RunControls.tsx", "const offeredOverflow = offered.overflow;"),
    ).toStrictEqual([]);
  });

  it("negative control: a sentence about an overflow read is not a read", () => {
    // The distinction a substring checker cannot make, and this file's own header is the
    // proof it matters: it names both axis properties in prose in order to explain them.
    expect(
      overflowReadSignatures(
        "explainer.ts",
        "// A second `style.overflowX` read would be the defect.\nconst count = 1;",
      ),
    ).toStrictEqual([]);
    expect(overflowReadSignatures("explainer.ts", 'const axis = "overflowY";')).toStrictEqual([]);
  });
});
