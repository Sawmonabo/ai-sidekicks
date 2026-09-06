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
//
// THE TWO TEXT PREDICATES ARE HERE TOO, and they are not the parser's. Whether a
// module writes the position pair, and which of its row-role tags omit it, are
// questions about characters rather than about a declaration boundary — but they are
// questions about the SAME subject, and both gates next door ask them: one to assert
// the pair has a single writer, the other to show that the hand-rolled list its own
// claim catches passes both. A predicate split across two modules by instrument rather
// than by subject is one a caller has to know two homes for.
//
// IT ALSO ANSWERS THE TAB-ORDER QUESTION, for the same reason. A windowed list has one
// tab stop and the roving index controls it (the APG's roving-tabindex rule), and the
// primitive can only write the stop on the element it renders itself — the wrapper, or
// the one control a delegating row hands the roving props to. An interactive element a
// caller wrote into a row as ordinary markup keeps its NATIVE stop, which puts the
// window's moving row count back in the page's tab order, and no runtime assertion
// inside the primitive can see it. That question is about JSX inside a JSX element,
// which is a declaration boundary, so it is the parser's.

import ts from "typescript";

import { readConsoleSourceModule, type ConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The one module allowed to write a windowed row's position members.
 *
 * A path rather than a convention: moving the primitive is an edit a reviewer sees.
 * Here rather than in either gate because both of them name it — one to assert it is
 * the sole writer, the other to resolve the row's own module out of the real tree.
 */
export const WINDOWED_ROW_MODULE = "console/primitives/WindowedListRow.tsx";

/** The pair, as one claim. A row carrying one and not the other is half a statement. */
export const POSITION_MEMBERS: readonly string[] = ["aria-setsize", "aria-posinset"];

/**
 * An opening tag that declares a row or option role.
 *
 * COARSE, AND DELIBERATELY SO: an opening tag up to its first `>`. A tag containing a
 * `>` inside an expression (`onSelect={() => choose(row)}`) is therefore cut short, and
 * a cut-short tag whose members sat past the cut is reported as an offence. That error
 * direction is the choice — a false alarm is a reviewer reading one tag, and a false
 * pass is a reader being told the wrong length of a list with nothing to notice.
 */
const WINDOWED_ROW_ROLE_TAG = /<[A-Za-z][^>]*\brole="(?:row|option|article)"[^>]*>/g;

/** Whether `source` writes either position member anywhere. Text, not structure. */
export function writesPositionMembers(source: string): boolean {
  return POSITION_MEMBERS.some((member) => source.includes(member));
}

/** Every row-role opening tag in `source`, as written, whether or not it is an offence. */
export function roleTagsIn(source: string): readonly string[] {
  return [...source.matchAll(WINDOWED_ROW_ROLE_TAG)].map((match) => match[0]);
}

/**
 * Every row-role tag in `source` that does not carry both position members.
 *
 * Pure over text so the controls can drive it with tags whose verdict is known.
 */
export function roleTagsMissingPosition(source: string): readonly string[] {
  return roleTagsIn(source).filter(
    (tag) => !POSITION_MEMBERS.every((member) => tag.includes(member)),
  );
}

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
  // The shared parse home reads the script kind off the name, so a `.tsx` module parses
  // as JSX: parsed as `TS`, a JSX opening tag reads as a comparison and every row here
  // disappears. Which is why `fileName` is a parameter rather than a label — the
  // controls below hand it the name the corpus they drive would have had.
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
 * Whether `source` RENDERS the row primitive, rather than merely naming it.
 *
 * The same instrument, and the same reason, as `handRolledWindowedRows` next door: a
 * module that mentions `WindowedListRow` in a comment — "deliberately not
 * WindowedListRow" is the sentence that was measured doing it — satisfies a substring
 * test and places its rows itself. A JSX element is a declaration boundary, so the
 * question is the parser's; an import of the name is not a rendering of it either, and
 * this asks only about the element.
 *
 * Pure over text so a control can drive it with a module whose verdict is known,
 * on this file's own model-beside-its-gate pattern.
 */
export function rendersTheRowPrimitive(source: string, fileName: string): boolean {
  const parsed = parseSourceText(fileName, source);
  return jsxTagNamesIn(parsed, parsed).includes(WINDOWED_ROW_PRIMITIVE);
}

/**
 * Whether a row rendered as a component reaches the primitive in the module it names.
 *
 * The `DiffFileList` / `DiffFileRow` shape: the windowing module names no primitive and
 * its rows do go through one. Resolved by matching the component's name to the module
 * that declares it, which is this tree's own convention — one component per `.tsx` file,
 * named for it, and then by reading whether that module RENDERS the primitive.
 */
export function rowComponentDelegates(
  rowComponents: readonly string[],
  modules: readonly ConsoleSourceModule[],
): boolean {
  return rowComponents.some((component) =>
    modules.some(
      (module) =>
        module.displayPath.endsWith(`/${component}.tsx`) &&
        rendersTheRowPrimitive(readConsoleSourceModule(module), module.displayPath),
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

/**
 * The host elements a browser puts in the sequential tab order without being asked.
 *
 * `a` is here with its `href`: an anchor without one is not focusable, and reporting
 * it would be a false alarm on the ordinary spelling of a non-navigating link.
 */
const NATIVELY_TABBABLE_TAGS: readonly string[] = ["button", "input", "select", "textarea"];

/** Whether the tag `element` opens is one a browser makes a tab stop by itself. */
function isNativelyTabbable(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  parsed: ts.SourceFile,
): boolean {
  const tag = element.tagName.getText(parsed);
  if (NATIVELY_TABBABLE_TAGS.includes(tag)) {
    return true;
  }
  return tag === "a" && hasAttributeNamed(element, "href");
}

function hasAttributeNamed(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): boolean {
  return element.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
  );
}

/**
 * The name a delegating row binds the roving props it hands out to.
 *
 * `<WindowedListRow …>{(targetProps) => <button {...targetProps} />}</WindowedListRow>`:
 * the row's children are a function, and its parameter is the only spread this scan
 * admits. Reading the NAME rather than admitting any spread is what keeps the claim
 * exact — `{...props}` from the enclosing component says nothing about the tab order.
 */
function targetPropsParameterName(row: ts.JsxElement): string | undefined {
  for (const child of row.children) {
    if (!ts.isJsxExpression(child) || child.expression === undefined) {
      continue;
    }
    const rendered = child.expression;
    if (!ts.isArrowFunction(rendered) && !ts.isFunctionExpression(rendered)) {
      continue;
    }
    const parameter = rendered.parameters[0];
    if (parameter !== undefined && ts.isIdentifier(parameter.name)) {
      return parameter.name.text;
    }
  }
  return undefined;
}

/** Whether `element` says where it sits in the tab order rather than taking the default. */
function declaresItsTabOrder(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  targetPropsName: string | undefined,
  parsed: ts.SourceFile,
): boolean {
  if (hasAttributeNamed(element, "tabIndex")) {
    return true;
  }
  if (targetPropsName === undefined) {
    return false;
  }
  return element.attributes.properties.some(
    (property) =>
      ts.isJsxSpreadAttribute(property) && property.expression.getText(parsed) === targetPropsName,
  );
}

/**
 * Every interactive element written into a windowed row that keeps its native tab stop.
 *
 * Reported as the tag's own text, so a failure names what a reviewer has to look at.
 */
export function undeclaredRowTabStops(source: string, fileName: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found: string[] = [];
  forEachDescendant(parsed, (node) => {
    if (
      !ts.isJsxElement(node) ||
      node.openingElement.tagName.getText(parsed) !== WINDOWED_ROW_PRIMITIVE
    ) {
      return;
    }
    const targetPropsName = targetPropsParameterName(node);
    forEachDescendant(node, (descendant) => {
      if (!ts.isJsxOpeningElement(descendant) && !ts.isJsxSelfClosingElement(descendant)) {
        return;
      }
      if (!isNativelyTabbable(descendant, parsed)) {
        return;
      }
      if (declaresItsTabOrder(descendant, targetPropsName, parsed)) {
        return;
      }
      found.push(descendant.getText(parsed).replace(/\s+/gu, " "));
    });
  });
  return found;
}
