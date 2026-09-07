// The browser pane's refusal vocabulary, held to the set that declares it.
//
// `Spec-023 §Console Design (Meridian)` rule 9 offers controls and renders refusals,
// and a refusal a person can act on is one whose code means the same thing every time
// it appears. That is a claim about a SET, so it is checked the way the corpus checks
// its other closed vocabularies — `repos/artifact-pane/artifact-pane-refusals.test.ts`
// drives every constructor and compares the codes to the tuple; this family's
// producers are hooks and components spread over a dozen modules, so the instrument
// is the parser rather than a call, on `tab-reorder-single-site.test.ts`'s reasoning.
//
// TWO CLAIMS, AND THE SECOND IS THE ONE THAT WAS MISSING. Every member of the tuple is
// produced somewhere in the family — a member nothing mints is a code no surface will
// ever render — and every code the family produces is a member. Before the tuple
// existed the second claim could not be made at all: `refuseLocally` took `code:
// string` and the fallbacks were bare object literals, so a fourteenth code minted at
// any call site was invisible to every suite in the tree.
//
// THE SCAN IS NARROW BY DESIGN, AND ITS LIMIT IS STATED. It reads the two shapes a
// code is actually written in — the `code` property of an object literal, and the code
// argument of a `refuse` / `refuseLocally` call — and nothing else. A rule that
// reported every string literal in the family would report every sentence and be
// turned off. Its limit is the same narrowness: a code reaching a raise site through a
// variable is invisible to it, which is why the `keyboard-handback.ts` set — raised
// through a private helper taking an already-typed code — is checked by CONTAINMENT
// below rather than by this scan, and why `bound-reached` is subtracted from the
// comparison and held to its own constant instead.

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_PANE_REFUSAL_CODES,
  type BrowserPaneRefusalCode,
} from "../../../src/renderer/src/console/browser/pane/pane-refusals.js";
import { BROWSER_BOUND_REFUSAL_CODE } from "../../../src/renderer/src/console/browser/bounds/bound-enforcement.js";
import { KEYBOARD_HANDBACK_REFUSAL_CODES } from "../../../src/renderer/src/console/browser/pane/handback/keyboard-handback.js";
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

/** Where the family's producers live. The tuple's own module is not a producer. */
const PANE_FAMILY_PREFIX = "browser/pane/";

/** The module that declares the set. Its members are a declaration, not a mint. */
const DECLARING_MODULE = "browser/pane/pane-refusals.ts";

/** The two call shapes that raise a refusal with a code as their second/first argument. */
const REFUSAL_CALLS: ReadonlyMap<string, number> = new Map([
  // `refuse(origin, code, detail)` — the console's one refusal constructor.
  ["refuse", 1],
  // `refuseLocally(code, detail)` — the act sequence's own local arm.
  ["refuseLocally", 0],
]);

/**
 * Every refusal code a module MINTS, as tree shapes rather than as substrings.
 *
 * Two shapes and no third: this file's own header names several codes in prose, and a
 * substring scan cannot tell a sentence about a code from a site that raises one.
 */
function refusalCodesMintedIn(fileName: string, source: string): readonly string[] {
  const minted: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "code" &&
      ts.isStringLiteral(node.initializer)
    ) {
      minted.push(node.initializer.text);
      return;
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const codePosition = REFUSAL_CALLS.get(node.expression.text);
    if (codePosition === undefined) {
      return;
    }
    const argument = node.arguments[codePosition];
    if (argument !== undefined && ts.isStringLiteral(argument)) {
      minted.push(argument.text);
    }
  });
  return minted;
}

const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

function readConsoleSource(module: string): string {
  return readModuleNamed(CONSOLE_MODULES, `console/${module}`);
}

/** Every code the pane family's production modules raise, deduplicated. */
function mintedAcrossPaneFamily(): ReadonlySet<string> {
  const minted = new Set<string>();
  for (const module of consoleRelativePaths(CONSOLE_MODULES)) {
    if (!module.startsWith(PANE_FAMILY_PREFIX) || module === DECLARING_MODULE) {
      continue;
    }
    for (const code of refusalCodesMintedIn(module, readConsoleSource(module))) {
      minted.add(code);
    }
  }
  return minted;
}

describe("the browser pane's refusal vocabulary", () => {
  it("finds the family's production modules at all", () => {
    // Without this the two claims below hold vacuously over an empty walk: a family
    // that moved would report no codes and every case would pass.
    const paneModules = consoleRelativePaths(CONSOLE_MODULES).filter((module) =>
      module.startsWith(PANE_FAMILY_PREFIX),
    );
    expect(paneModules.length).toBeGreaterThan(5);
    expect(paneModules).toContain(DECLARING_MODULE);
  });

  it("is exactly the set the family produces, each member named once", () => {
    // The two halves of the claim in one comparison: a code minted at a call site and
    // never enumerated fails on the left, and a member nothing mints fails on the
    // right. `bound-reached` is subtracted because it is authored in `bounds/` and
    // only RENDERED here — the case below holds it to that module's own constant,
    // which is a stronger check than finding a literal that is deliberately absent.
    const authoredHere = BROWSER_PANE_REFUSAL_CODES.filter(
      (code) => code !== BROWSER_BOUND_REFUSAL_CODE,
    );
    expect([...mintedAcrossPaneFamily()].toSorted()).toStrictEqual([...authoredHere].toSorted());
    expect(new Set(BROWSER_PANE_REFUSAL_CODES).size).toBe(BROWSER_PANE_REFUSAL_CODES.length);
  });

  it("names the bounds module's own constant rather than a second spelling of it", () => {
    // The member this family renders and does not author. Two homes for one string is
    // exactly the drift the set exists to end, so the tuple is held to the constant.
    const boundCode: BrowserPaneRefusalCode = BROWSER_BOUND_REFUSAL_CODE;
    expect([...BROWSER_PANE_REFUSAL_CODES]).toContain(boundCode);
  });

  it("negative control: another author's codes are not members of this set", () => {
    // The port's vocabulary reaches this pane on every refused act and renders
    // unchanged, and the handback keeps its own closed set under its own origin. A
    // set that admitted either would be claiming authorship of a refusal this family
    // never mints — and, for the handback, would put one origin's name on two authors.
    expect([...BROWSER_PANE_REFUSAL_CODES]).not.toContain("wire-unregistered");
    expect([...BROWSER_PANE_REFUSAL_CODES]).not.toContain("reply-unscripted");
    for (const handbackCode of KEYBOARD_HANDBACK_REFUSAL_CODES) {
      expect([...BROWSER_PANE_REFUSAL_CODES]).not.toContain(handbackCode);
    }
  });

  it("negative control: the scanner bites on a planted mint and ignores prose", () => {
    // Without this the comparison above would hold over a scanner that found nothing.
    expect(
      refusalCodesMintedIn("planted.ts", 'const fallback = { code: "invented-code", detail: "" };'),
    ).toStrictEqual(["invented-code"]);
    expect(
      refusalCodesMintedIn("planted.ts", 'refuseLocally("invented-code", "why");'),
    ).toStrictEqual(["invented-code"]);
    expect(
      refusalCodesMintedIn("planted.ts", 'refuse(ORIGIN, "invented-code", "why");'),
    ).toStrictEqual(["invented-code"]);
    expect(
      refusalCodesMintedIn("explainer.ts", '// The code is "invented-code".\nconst x = 1;'),
    ).toStrictEqual([]);
    expect(
      refusalCodesMintedIn("explainer.ts", "refuseLocally(overCap.code, overCap.detail);"),
    ).toStrictEqual([]);
  });
});
