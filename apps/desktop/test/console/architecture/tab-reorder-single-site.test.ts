// The drop-slot translation, held to one call site.
//
// `Spec-023 §Console Design (Meridian)` 12.2: "The translation is stated once, at the
// one call site, never rediscovered per handler." That is a claim about the SHAPE of
// the tree rather than about a value, so it is checked here rather than left to
// review — a second handler that recomputed `slot - 1` inline would pass every unit
// suite in the family, because each handler would be right in isolation and the two
// would disagree the first time one of them was corrected.
//
// TWO CLAIMS. The function has exactly one caller, and no module outside it does the
// arithmetic by hand. The second is the one that matters: the failure this rule was
// written against is not a second call, it is a second SUBTRACTION written where the
// author did not know the first existed.
//
// THE INSTRUMENT IS THE PARSER, on `airspace-registration.test.ts`'s reasoning: this
// file's own header contains both the identifier and a subtraction, and a substring
// scan cannot tell a call from a sentence about one.

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The budget this file states rather than inherits; `source-walk-chokepoint.ts`'s figure. */
const CONSOLE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: CONSOLE_PARSE_ALLOWANCE_MS });

/** The one function that spends the drop-slot-to-move-index difference. */
const TRANSLATION_FUNCTION = "pageMoveIndex";

/** Where it is declared. Its own module is not a caller of it. */
const TRANSLATION_MODULE = "browser/pane/chrome/tab-reorder.ts";

/** Whether a module CALLS the named function, as a tree shape rather than a substring. */
function callsFunctionNamed(fileName: string, source: string, functionName: string): boolean {
  let called = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName
    ) {
      called = true;
    }
  });
  return called;
}

/**
 * Whether a module subtracts one from something whose name reads as a drop slot.
 *
 * Narrow on purpose: the claim is about THIS arithmetic, and a rule that reported
 * every `- 1` in the console would report a hundred loop bounds and be turned off.
 * A binary minus whose right side is the literal `1` and whose left side is an
 * identifier naming a slot or a drop index is the shape the translation takes, and
 * it is the shape a second handler would take too.
 */
function subtractsFromADropSlot(fileName: string, source: string): boolean {
  let found = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
      !ts.isNumericLiteral(node.right) ||
      node.right.text !== "1" ||
      !ts.isIdentifier(node.left)
    ) {
      return;
    }
    const leftName = node.left.text.toLowerCase();
    if (leftName.includes("slot") || leftName.includes("dropindex")) {
      found = true;
    }
  });
  return found;
}

const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

function readConsoleSource(module: string): string {
  return readModuleNamed(CONSOLE_MODULES, `console/${module}`);
}

describe("tab reorder — the slot translation is stated once", () => {
  const modules = consoleRelativePaths(CONSOLE_MODULES);

  it("finds the module that owns the translation", () => {
    expect(modules).toContain(TRANSLATION_MODULE);
  });

  it("has exactly one caller, and it is the strip", () => {
    // No `.test.ts` filter: `consoleSourceModules` defaults `tests: false`, so a
    // filter for them here would be a condition nothing can meet — and one a reader
    // would take as evidence that co-located tests are being scanned and excused.
    const callers = modules
      .filter((module) => module !== TRANSLATION_MODULE)
      .filter((module) =>
        callsFunctionNamed(module, readConsoleSource(module), TRANSLATION_FUNCTION),
      );
    expect(callers).toStrictEqual(["browser/pane/chrome/TabStrip.tsx"]);
  });

  it("no module rediscovers the subtraction by hand", () => {
    const offenders = modules
      .filter((module) => module !== TRANSLATION_MODULE)
      .filter((module) => subtractsFromADropSlot(module, readConsoleSource(module)));
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checkers bite on a planted second site", () => {
    expect(
      callsFunctionNamed(
        "planted.tsx",
        "const to = pageMoveIndex(from, slot);",
        TRANSLATION_FUNCTION,
      ),
    ).toBe(true);
    expect(subtractsFromADropSlot("planted.tsx", "const toIndex = dropSlot - 1;")).toBe(true);
    expect(subtractsFromADropSlot("planted.tsx", "const toIndex = hoveredSlot - 1;")).toBe(true);
  });

  it("negative control: prose and unrelated arithmetic are not a second site", () => {
    expect(
      callsFunctionNamed(
        "explainer.ts",
        "// The strip translates through pageMoveIndex(...).\nconst x = 1;",
        TRANSLATION_FUNCTION,
      ),
    ).toBe(false);
    expect(subtractsFromADropSlot("explainer.ts", "const last = pages.length - 1;")).toBe(false);
    expect(
      subtractsFromADropSlot("explainer.ts", "// a tab dragged rightward targets slot - 1"),
    ).toBe(false);
  });
});
