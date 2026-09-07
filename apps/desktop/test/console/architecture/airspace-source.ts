// What the airspace gate asks of a console module's source, asked with the compiler.
//
// Not a test file — no `include` glob reaches it; the architecture tier imports it,
// the way that tier already imports `barrel-census.ts` and `stylesheet-selectors.ts`.
// It exists because the airspace rule grew from three questions to five and the file
// asking them went past the size this package splits at: the CLAIMS are one job and
// the SOURCE SHAPES they are made of are another, and reading them out of one module
// made the rule's subject hard to find.
//
// THE INSTRUMENT IS THE PARSER, on `resize-observer-chokepoint.test.ts`'s reasoning: a
// substring scan cannot tell a call from a sentence about one, and the gate's own
// header names every symbol it forbids in prose. A call expression, an import
// specifier, and a JSX tag name are declaration boundaries, which `apps/desktop/
// AGENTS.md` says to answer with the compiler rather than with a pattern.
//
// EVERY PREDICATE TAKES A PARSED FILE rather than text, which is what lets the gate
// walk the console once and ask five questions of one reading — and what lets a
// negative control drive the real predicate over a snippet it parsed the same way.

import ts from "typescript";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The widget package whose overlay anatomy this rule is about. */
export const BASE_UI_SPECIFIER_PREFIX = "@base-ui/react";

/**
 * Base UI's popup anatomy: the parts that lift an element out of the layout.
 *
 * A module rendering any one of these is drawing above the pane, whichever family it
 * took them from. Keying on the PART rather than on a roster of families is what makes
 * the rule cover the family the console adopts next — measured against the installed
 * `@base-ui/react` 1.7.0, where these four appear under every floating family
 * (`dialog`, `alert-dialog`, `menu`, `context-menu`, `popover`, `tooltip`, `select`,
 * `combobox`, `drawer`, `toast`, `navigation-menu`, `preview-card`) and under the
 * in-place ones (`checkbox`, `switch`, `radio`, `collapsible`, `accordion`, `tabs`)
 * not at all. A roster of families is a claim that goes stale the first time one is
 * added, and nothing reports it.
 */
export const OVERLAY_POPUP_PARTS: readonly string[] = ["Portal", "Positioner", "Popup", "Backdrop"];

/** Whether a module CONSTRUCTS the named class, as a tree shape rather than a substring. */
export function constructsClassNamed(parsed: ts.SourceFile, className: string): boolean {
  let constructed = false;
  forEachDescendant(parsed, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === className
    ) {
      constructed = true;
    }
  });
  return constructed;
}

/** Whether a module CALLS the named function, as a tree shape rather than a substring. */
export function callsFunctionNamed(parsed: ts.SourceFile, functionName: string): boolean {
  let called = false;
  forEachDescendant(parsed, (node) => {
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
 * The local names this module binds from the widget package.
 *
 * Read off the import rather than assumed to be the family's own name, because the
 * binding is what a JSX tag names: `import { Dialog } from "@base-ui/react/dialog"`
 * and a renamed `{ Menu as Sheet }` both mount a popup, and only the local name
 * appears at the tag.
 */
function baseUiLocalNames(parsed: ts.SourceFile): ReadonlySet<string> {
  const localNames = new Set<string>();
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(BASE_UI_SPECIFIER_PREFIX)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) {
      continue;
    }
    if (clause.name !== undefined) {
      localNames.add(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      localNames.add(bindings.name.text);
      continue;
    }
    for (const specifier of bindings.elements) {
      localNames.add(specifier.name.text);
    }
  }
  return localNames;
}

/**
 * Every Base UI popup part this module MOUNTS, spelled as a reader meets it.
 *
 * A tag name and not a member read: `<Dialog.Popup>` mounts one and
 * `const part = Dialog.Popup` does not, and the two are indistinguishable to a
 * pattern. Sorted and de-duplicated, so a failure names the parts once each.
 */
export function overlayPopupPartsMounted(parsed: ts.SourceFile): readonly string[] {
  const localNames = baseUiLocalNames(parsed);
  if (localNames.size === 0) {
    return [];
  }
  const mounted = new Set<string>();
  forEachDescendant(parsed, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    const tagName = node.tagName;
    if (
      !ts.isPropertyAccessExpression(tagName) ||
      !ts.isIdentifier(tagName.expression) ||
      !localNames.has(tagName.expression.text) ||
      !OVERLAY_POPUP_PARTS.includes(tagName.name.text)
    ) {
      return;
    }
    mounted.add(`${tagName.expression.text}.${tagName.name.text}`);
  });
  return [...mounted].sort();
}

/** One console module, parsed once for every claim a gate makes about it. */
export interface ParsedConsoleModule {
  /** The path inside `console/`, as a failure names it. */
  readonly relativePath: string;
  readonly parsed: ts.SourceFile;
}

/**
 * The console, walked and parsed ONCE, behind a throwing accessor.
 *
 * `ConsoleSourceTree`'s role applied to a gate whose questions are all tree shapes:
 * five claims over roughly 360 modules, and a per-claim parse would pay the walk five
 * times for one reading. Behind a private field rather than a mutable binding a case
 * could read as `undefined`, for that module's reason — a `beforeAll` that failed
 * would otherwise surface as a type error in whichever case ran first.
 */
export class ParsedConsoleTree {
  #modules: readonly ParsedConsoleModule[] | undefined = undefined;

  /** Walk the console and parse every module. Called once, from a `beforeAll`. */
  public read(): void {
    const scanned = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    this.#modules = consoleRelativePaths(scanned).map((relativePath) => ({
      relativePath,
      parsed: parseSourceText(
        relativePath,
        readModuleNamed(scanned, `console/${relativePath}`, "a console module"),
      ),
    }));
  }

  /** The one reading this file paid for. Throws if a case asks before the hook ran. */
  public get modules(): readonly ParsedConsoleModule[] {
    if (this.#modules === undefined) {
      throw new Error("the console reading was asked for before the hook filled it in");
    }
    return this.#modules;
  }

  /** Every module's path inside `console/`, in scan order. */
  public get relativePaths(): readonly string[] {
    return this.modules.map((module) => module.relativePath);
  }
}
