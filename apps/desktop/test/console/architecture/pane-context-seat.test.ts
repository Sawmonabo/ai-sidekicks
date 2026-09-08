// The pane-mount context has one builder, and every fixture reaches it.
//
// `seats/pane-context.test-support.ts` was written to end a class of duplication its
// own header names: a suite that mounts a pane needs an address and eight bindings,
// reads two or three of them, and produces the rest as scaffolding — so every family
// that mounted a pane had written that scaffolding again. The copies were not merely
// redundant. They DIVERGED, and on the member nobody was looking at: some built the
// UI-state store over an adapter that answers and some over one that never settles,
// so a pane that grew a UI-state read would have hung in one family and passed in
// another, with neither result reporting the disagreement.
//
// That is a claim about the SHAPE of the tree, which is why it is checked here and
// not left to review: each copy is correct read on its own, and what is wrong is
// that there are several. Nothing a family's own suite can assert would report it.
//
// THE INSTRUMENT IS THE PARSER. This file's own header names both `uiStateStore` and
// `draftStore` in prose, and a substring scan cannot tell a sentence about a binding
// from a binding — so the census asks the tree which object literals carry the pane
// binding stack, and reads a cast out of the syntax rather than out of the text.

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

/** The one home for the pane-mount context. Its own literal is the thing being shared. */
const SEAT_MODULE = "seats/pane-context.test-support.ts";

/** How a module names the seat, as the console's own specifier form spells it. */
const SEAT_SPECIFIER_SUFFIX = "seats/pane-context.test-support.js";

/**
 * What makes an object literal a PANE binding stack rather than any other context.
 *
 * `paneId` is the discriminator and is load-bearing. The surface seat one rung over
 * carries `uiStateStore` and `draftStore` too — `sessions/session-surface.test-support.tsx`
 * builds one — and it is a different role with a different home, keyed by `route`
 * rather than by a pane. Asking for all three together is what keeps this census
 * about the builder it is named for.
 */
const PANE_BINDING_MEMBERS: readonly string[] = ["paneId", "uiStateStore", "draftStore"];

/** The property names an object literal states, shorthand included. */
function literalMemberNames(literal: ts.ObjectLiteralExpression): readonly string[] {
  return literal.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return [property.name.text];
    }
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      return [];
    }
    return [property.name.text];
  });
}

/** Whether a module writes out the pane binding stack itself. */
function buildsPaneBindingStack(fileName: string, source: string): boolean {
  let found = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (!ts.isObjectLiteralExpression(node)) {
      return;
    }
    const named = new Set(literalMemberNames(node));
    if (PANE_BINDING_MEMBERS.every((member) => named.has(member))) {
      found = true;
    }
  });
  return found;
}

/** Whether a module imports the seat, read off the import declarations. */
function importsTheSeat(fileName: string, source: string): boolean {
  return parseSourceText(fileName, source).statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith(SEAT_SPECIFIER_SUFFIX),
  );
}

/**
 * Whether a module launders a value through `unknown`.
 *
 * The double assertion is the shape, and it is the one the ledger's copies closed
 * with: `x as unknown as T` parses as an outer `as` over an inner `as unknown`, so
 * the check is that nesting rather than the phrase. A single `as T` is left alone —
 * it is checked and this is not.
 */
function laundersThroughUnknown(fileName: string, source: string): boolean {
  let found = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isAsExpression(node) &&
      ts.isAsExpression(node.expression) &&
      node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      found = true;
    }
  });
  return found;
}

const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY], tests: true });

function readConsoleSource(module: string): string {
  return readModuleNamed(CONSOLE_MODULES, `console/${module}`);
}

describe("pane mount contexts — one builder, in the seat", () => {
  /**
   * Fixture modules only. A production composition site DOES build the real context —
   * the deck's own board is where a pane is actually bound — and holding it to a
   * fixture's builder would be the tail wagging the dog. What this census is about is
   * the scaffolding a suite produces to mount one.
   */
  const testSupportModules = consoleRelativePaths(CONSOLE_MODULES).filter((module) =>
    module.includes(".test-support."),
  );

  it("finds the seat and the fixtures it is measured over", () => {
    expect(testSupportModules).toContain(SEAT_MODULE);
    expect(testSupportModules.length).toBeGreaterThan(1);
  });

  it("no fixture outside the seat writes the pane binding stack itself", () => {
    const offenders = testSupportModules
      .filter((module) => module !== SEAT_MODULE)
      .filter((module) => buildsPaneBindingStack(module, readConsoleSource(module)));
    expect(offenders).toStrictEqual([]);
  });

  it("the two families the copies had drifted between now read the seat", () => {
    // Named rather than counted: these are the two whose hand-written contexts
    // disagreed with the seat about the UI-state store, so a census that stopped
    // being able to see them would have stopped checking the thing it is for. A
    // family converted later joins this set without this case changing.
    const seatReaders = testSupportModules.filter((module) =>
      importsTheSeat(module, readConsoleSource(module)),
    );
    expect(seatReaders).toContain("browser/pane/BrowserPane.test-support.tsx");
    expect(seatReaders).toContain("terminal/pane/TerminalPane.test-support.tsx");
  });

  it("no fixture that reads the seat launders its result through unknown", () => {
    const offenders = testSupportModules
      .filter((module) => importsTheSeat(module, readConsoleSource(module)))
      .filter((module) => laundersThroughUnknown(module, readConsoleSource(module)));
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checkers bite on a planted copy", () => {
    expect(
      buildsPaneBindingStack(
        "planted.tsx",
        [
          "const context = {",
          '  kind: "browser",',
          "  paneId,",
          "  bridge,",
          "  uiStateStore: UiStateStore.opening(),",
          "  draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),",
          "};",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(
      importsTheSeat(
        "planted.tsx",
        'import { paneContext } from "../../seats/pane-context.test-support.js";',
      ),
    ).toBe(true);
    expect(
      laundersThroughUnknown(
        "planted.tsx",
        "const context = built as unknown as PaneContextOf<'runs'>;",
      ),
    ).toBe(true);
  });

  it("negative control: prose, a surface context, and a checked cast are not a copy", () => {
    expect(
      buildsPaneBindingStack(
        "explainer.ts",
        "// The seat binds paneId, uiStateStore and draftStore for every mounting suite.",
      ),
    ).toBe(false);
    // The surface seat's own literal: both persistence stores, no pane.
    expect(
      buildsPaneBindingStack(
        "surface.tsx",
        "const context = { route, uiStateStore: openStore(), draftStore: undefined };",
      ),
    ).toBe(false);
    expect(
      importsTheSeat(
        "explainer.ts",
        "// Every mount goes through seats/pane-context.test-support.js.",
      ),
    ).toBe(false);
    expect(laundersThroughUnknown("checked.ts", "const region = node as HTMLElement;")).toBe(false);
  });
});
