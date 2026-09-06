// The size-observer chokepoint, asserted.
//
// `apps/desktop/AGENTS.md` states hoist-on-second-use and "one implementation per
// job", and a `ResizeObserver` is the shape that rule is hardest on: it is four
// lines — a feature detection, a construction, an `observe`, and a `disconnect` —
// so the second one is never introduced deliberately. It arrives inside a component
// that needed to know when its own box changed, and it is only wrong later, when the
// two copies stop agreeing about what an absent constructor means or about who
// disconnects.
//
// The console had exactly that: the browser family's seam and a second construction
// inside the terminal emulator. Both are `primitives/element-resize.ts` now, and this
// is what keeps that true — a claim no type and no layering rule can make, because
// constructing a global is not an import.
//
// WHAT COUNTS AS A CONSTRUCTION SITE. Reading the constructor off the platform, in
// either of the two forms this tree can write it. A module that merely names the type
// in a comment or holds a `ResizeObserver`-typed field is not scanned for: the
// observable act is taking the constructor, and the chokepoint is the only module
// allowed to take it.
//
// THE INSTRUMENT IS THE PARSER, and that distinction is why. `source.includes(...)`
// cannot tell a construction from a sentence about one, so this file's own header —
// which names both forms in order to explain them — would trip its own rule if it
// were a module under scan, and the paragraph above saying a comment does not count
// was a claim the checker did not implement. A `new` expression and a property access
// are both declaration boundaries, which `apps/desktop/AGENTS.md` says to answer with
// the compiler rather than with a pattern.
//
// Test files are excluded: a fake has to construct the shape it stands in for, and
// forbidding that would forbid testing the chokepoint's own degrade.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The one module allowed to construct a size observer.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a naming
 * convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = "primitives/element-resize.ts";

/** The platform name this chokepoint owns. */
const OBSERVER_TYPE_NAME = "ResizeObserver";

/**
 * The ways this tree can take the constructor, as the labels a failure reports.
 *
 * `new ResizeObserver(` is the direct form; the chokepoint itself reads the global
 * into a local first, so the indirect form is listed beside it rather than left as a
 * hole a second site could be written through. Both are now recognised as tree shapes
 * — a `new` expression and a `globalThis.` property access — and these strings name
 * what was found rather than being the needle that found it.
 */
const CONSTRUCTION_FORMS = {
  direct: `new ${OBSERVER_TYPE_NAME}(`,
  offGlobalThis: `globalThis.${OBSERVER_TYPE_NAME}`,
} as const;

/**
 * Every way `source` shows it took the size-observer constructor, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with strings whose verdict is known and the checker is
 * proved to bite without perturbing a real module. Sorted, so a module that writes
 * both forms reports them in one order.
 */
function resizeObserverConstructionSignatures(fileName: string, source: string): readonly string[] {
  const found = new Set<string>();
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === OBSERVER_TYPE_NAME
    ) {
      found.add(CONSTRUCTION_FORMS.direct);
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      node.name.text === OBSERVER_TYPE_NAME
    ) {
      found.add(CONSTRUCTION_FORMS.offGlobalThis);
    }
  });
  return [...found].sort();
}

/**
 * Every console source module, through the tier's one walk.
 *
 * Console-relative because that is the name every message below reports, and the
 * walk's own `displayPath` carries the `console/` root in front of it. The walk
 * itself is not this file's to write: `source-walk-chokepoint.test.ts` fails a gate
 * that reaches renderer source through a `readdirSync` of its own, because five
 * private walks is five slightly different ideas of what counts as source and the
 * difference between them is invisible until one of them scans a file the others do
 * not.
 */
const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

function readConsoleSource(module: string): string {
  return readModuleNamed(CONSOLE_MODULES, `console/${module}`);
}

/** What the checker is asked, for one console-relative module. */
function constructionSignaturesOf(module: string): readonly string[] {
  return resizeObserverConstructionSignatures(module, readConsoleSource(module));
}

describe("element-resize — the size observer is constructed in exactly one module", () => {
  const modules = consoleRelativePaths(CONSOLE_MODULES);

  it("finds a console tree to scan at all", () => {
    // Without this, a walk that reached nothing would leave the assertion below
    // passing over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module takes the constructor", () => {
    const offenders = modules
      .filter((module) => module !== CHOKEPOINT_MODULE)
      .map((module) => ({ module, signatures: constructionSignaturesOf(module) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips the checker", () => {
    // The checker reads real files and the shapes match real code. Without this, a
    // wrong node predicate would make the clean result above meaningless — which is
    // exactly the state the emulator's own observer was found in.
    expect(constructionSignaturesOf(CHOKEPOINT_MODULE)).toContain(CONSTRUCTION_FORMS.offGlobalThis);
  });

  it("negative control: the emulator's old construction site is what this catches", () => {
    // The literal shape the terminal adapter carried, driven through the predicate
    // rather than through a planted edit, so the claim survives the module it was
    // removed from being renamed.
    expect(
      resizeObserverConstructionSignatures(
        "adapter.ts",
        "const resizeObserver = new ResizeObserver(() => {\n  this.fitToHost();\n});",
      ),
    ).toStrictEqual([CONSTRUCTION_FORMS.direct]);
    expect(
      resizeObserverConstructionSignatures(
        "adapter.ts",
        "#resizeObserver: ResizeObserver | undefined;",
      ),
    ).toStrictEqual([]);
  });

  it("negative control: a sentence about the constructor is not a construction", () => {
    // The claim the header made and the substring checker did not implement. Both
    // comment forms, and a string literal, because this file's own header names both
    // construction forms in prose in order to explain them.
    expect(
      resizeObserverConstructionSignatures(
        "explainer.ts",
        "// A second `new ResizeObserver(` would be the defect.\nconst x = 1;",
      ),
    ).toStrictEqual([]);
    expect(
      resizeObserverConstructionSignatures(
        "explainer.ts",
        "/* Reads globalThis.ResizeObserver once. */\nconst x = 1;",
      ),
    ).toStrictEqual([]);
    expect(
      resizeObserverConstructionSignatures("explainer.ts", 'const form = "new ResizeObserver(";'),
    ).toStrictEqual([]);
  });

  it("negative control: the parse still finds a construction the substring form missed", () => {
    // The other direction. A construction whose argument list starts on the next line
    // carries no `new ResizeObserver(` anywhere, so the substring checker read it as
    // clean; the tree does not care where the parenthesis is.
    expect(
      resizeObserverConstructionSignatures(
        "wrapped.ts",
        "const observer = new ResizeObserver\n  (onResize);",
      ),
    ).toStrictEqual([CONSTRUCTION_FORMS.direct]);
  });
});
