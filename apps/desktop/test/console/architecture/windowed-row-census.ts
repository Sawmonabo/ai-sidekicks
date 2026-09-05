// The row census the windowed-row gate next door runs: whether a windowing module places
// its rows itself, and whether a row rendered as a component reaches the primitive.
//
// A MODEL BESIDE ITS GATE, on the `barrel-census.ts` pattern. The gate reads the real
// console while its controls drive corpora written by hand to fail, so the predicates
// take source text as a parameter; the walk that produces the real module set stays in
// the gate, where `source-walk-chokepoint.test.ts` can see it.
//
// THE INSTRUMENT IS THE TYPESCRIPT PARSER, and that is the whole of this claim's
// strength. The substring test it replaces asked whether a file MENTIONED the primitive,
// which failed in both directions: a comment reading "deliberately not WindowedListRow"
// switched the claim off for a whole module, and a module whose rows are a sibling
// component was reported as an offence for naming a primitive its rows do go through.

import ts from "typescript";

import { readConsoleSourceModule, type ConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * How a module shows it windows a list.
 *
 * The adopted virtualizer names itself; a caller that reaches it through this family's
 * own row or roving-index primitives names those. A module that windows by hand and
 * imports none of them is outside this scan and inside claim 1, which is where
 * hand-rolling is caught.
 */
export const WINDOWING_SIGNALS: readonly string[] = [
  "@tanstack/react-virtual",
  "getVirtualItems(",
  "WindowedListRow",
  "useWindowedRovingIndex",
];

/**
 * The primitive every windowed row goes through, as source text.
 *
 * It is also one of `WINDOWING_SIGNALS`, and that overlap is what lets one predicate
 * answer both questions: a module that windows and does not route its rows through this
 * reached the virtualizer or the roving index directly and then built its own rows.
 */
export const WINDOWED_ROW_PRIMITIVE = "WindowedListRow";

export function windowsAList(source: string): boolean {
  return WINDOWING_SIGNALS.some((signal) => source.includes(signal));
}

/** The host elements a row is spelled as when a module places its rows itself. */
const HAND_ROLLED_ROW_TAGS: readonly string[] = ["li", "div", "tr"];

/** How a windowed row array is obtained, which is what a `.map(` has to be over. */
const WINDOW_READ = "getVirtualItems";

/**
 * Every JSX opening tag name inside `node`, in source order.
 *
 * `getText(parsed)` takes the file it was parsed from rather than climbing to it, which
 * is what lets the shared parse home leave `setParentNodes` off.
 */
function jsxTagNamesIn(node: ts.Node, parsed: ts.SourceFile): readonly string[] {
  const tags: string[] = [];
  forEachDescendant(node, (child) => {
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
      tags.push(child.tagName.getText(parsed));
    }
  });
  return tags;
}

/**
 * The names that hold a windowed row array in `parsed`.
 *
 * `entryWindow.getVirtualItems()` reaches a `.map(` two ways — inline, and through a
 * `const rows = …` on the line above — and the second is the ordinary spelling once the
 * array is read once and used twice. Both have to resolve to the same claim or the rule
 * is decided by where a variable was introduced.
 */
function windowedRowBindings(parsed: ts.SourceFile): readonly string[] {
  const bindings: string[] = [];
  forEachDescendant(parsed, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      node.initializer.getText(parsed).includes(WINDOW_READ)
    ) {
      bindings.push(node.name.text);
    }
  });
  return bindings;
}

/**
 * Every row a windowing module places itself instead of routing through the primitive.
 *
 * THE INSTRUMENT IS THE PARSER, and claim 3's whole strength rests on that. The
 * substring test this replaces asked whether the file MENTIONED the primitive's name,
 * which failed in both directions and was measured doing so: a comment reading
 * "deliberately not WindowedListRow" switched the claim off for a whole module, and a
 * module whose rows are a sibling component — the ordinary answer once a row grows —
 * was reported as an offence for naming a primitive its rows do go through.
 *
 * So the question asked here is the one the claim always meant: inside a `.map(` over
 * the windowed rows, does a host element get placed without the primitive? A capitalised
 * tag is a delegation and is answered by `rowComponentDelegates`, which reads the module
 * that tag resolves to.
 */
export function handRolledWindowedRows(
  source: string,
  fileName: string,
): readonly { readonly tag: string; readonly rowComponents: readonly string[] }[] {
  // `TSX`, and it is the one option any caller of the shared parse home varies: parsed
  // as `TS`, a JSX opening tag reads as a comparison and every row here disappears.
  const parsed = parseSourceText(fileName, source);
  const bindings = windowedRowBindings(parsed);
  const found: { tag: string; rowComponents: readonly string[] }[] = [];
  forEachDescendant(parsed, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "map"
    ) {
      return;
    }
    const receiver = node.expression.expression.getText(parsed);
    const overTheWindow =
      receiver.includes(WINDOW_READ) || bindings.some((binding) => receiver === binding);
    if (!overTheWindow) {
      return;
    }
    const tags = jsxTagNamesIn(node, parsed);
    if (tags.includes(WINDOWED_ROW_PRIMITIVE)) {
      return;
    }
    const rowComponents = tags.filter((tag) => /^[A-Z]/u.test(tag));
    for (const tag of tags.filter((tag) => HAND_ROLLED_ROW_TAGS.includes(tag))) {
      found.push({ tag, rowComponents });
    }
  });
  return found;
}

/**
 * Whether a row rendered as a component reaches the primitive in the module it names.
 *
 * The `DiffFileList` / `DiffFileRow` shape: the windowing module names no primitive and
 * its rows do go through one. Resolved by matching the component's name to the module
 * that declares it, which is this tree's own convention — one component per `.tsx` file,
 * named for it.
 */
export function rowComponentDelegates(
  rowComponents: readonly string[],
  modules: readonly ConsoleSourceModule[],
): boolean {
  return rowComponents.some((component) =>
    modules.some(
      (module) =>
        module.displayPath.endsWith(`/${component}.tsx`) &&
        readConsoleSourceModule(module).includes(WINDOWED_ROW_PRIMITIVE),
    ),
  );
}

/** Whether `source` windows a list and places rows the primitive should have placed. */
export function windowsWithoutTheRowPrimitive(
  source: string,
  fileName: string,
  modules: readonly ConsoleSourceModule[],
): boolean {
  if (!windowsAList(source)) {
    return false;
  }
  return handRolledWindowedRows(source, fileName).some(
    (row) => !rowComponentDelegates(row.rowComponents, modules),
  );
}
