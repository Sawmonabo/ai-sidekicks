// The scroll chokepoint, asserted by reading the tree.
//
// `Spec-023 §Console Test Tiers` puts two of this tier's tripwires here — "no
// `scrollTop` write outside the chokepoint, no `scrollIntoView`" — over the rule
// `ledger/frame/scroll-chokepoint.ts` states: one scroll controller per timeline pane
// owns `scrollTop` writes, every caller is a member of a closed caller union and is
// named in the write, and glides replace `scrollIntoView` everywhere. The
// controller's own behaviour is driven in its co-located unit test; the claim only a
// tree-wide scan can hold is that no OTHER module writes a scroll offset — and, like
// every chokepoint, the second implementation is never introduced deliberately. It
// arrives as one line in a component that needed to bring a row into view.
//
// TWO CLAIMS, DRAWN AT DIFFERENT PLACES.
//
//   • **Writing `scrollTop` is allowed in exactly one module.** Reading it is not
//     policed: a read is what the chokepoint's own geometry sample does, and a rule
//     that forbade the token outright would forbid the module that owns it from
//     naming its own subject.
//   • **`scrollIntoView`, `scrollTo`, and `scrollBy` are allowed NOWHERE**, the
//     chokepoint included. Each of them moves a scroll offset without saying which
//     one or by how much, so none of them can be arbitrated between callers — which
//     is what the closed caller union exists to make possible.
//
// Test files are excluded, for `wire-figure-chokepoint.test.ts`' reason: a test that
// drives the chokepoint has to write the very token the rule is about, and a scan
// that forbade it would forbid testing the chokepoint at all.
//
// THE INSTRUMENT IS THE TYPESCRIPT PARSER, and that is the whole of these claims'
// strength. The substring needles this replaces — `"scrollTop ="`, `".scrollTo("` —
// were defeated by a code formatter and by ordinary JavaScript: `element.scrollTop=0`
// has no space, a line the formatter wrapped puts the operator on the next line,
// `element["scrollTop"] = offset` indexes rather than accesses, `??=` and `*=` are
// operators no list enumerated, `Object.assign(element, { scrollTop })` names no
// operator at all, and `element?.scrollTo(` carries a token between the dot and the
// name. Every one of those writes a scroll offset and every one passed. A question
// about which property an assignment targets is a question about a declaration
// boundary, which is the parser's, and `typescript-source.ts` is where this tier
// already keeps it.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The one module allowed to write a scroll offset.
 *
 * A path rather than a naming convention, so moving the chokepoint is an edit a
 * reviewer sees rather than a rename that quietly re-points the rule.
 */
const CHOKEPOINT_MODULE = "console/ledger/frame/scroll-chokepoint.ts";

/** The two properties a scroll offset is written to. Closed. */
const SCROLL_OFFSET_PROPERTIES: readonly string[] = ["scrollTop", "scrollLeft"];

/**
 * Platform methods that move a scroll offset without naming one.
 *
 * Banned everywhere, chokepoint included: a glide states its caller and its target,
 * and these state neither.
 */
const UNNAMED_SCROLL_METHODS: readonly string[] = ["scrollIntoView", "scrollTo", "scrollBy"];

/**
 * Every operator that WRITES its left-hand side.
 *
 * Enumerated rather than approximated, because the defect this claim is for arrives
 * as whichever operator the author reached for: `=` is the common one, `+=` and `-=`
 * are how a delta is applied, and `??=` is how a caller seeds an offset once. A list
 * of four spellings left the other twelve unpoliced.
 */
const ASSIGNMENT_OPERATORS: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
];

/**
 * The member `expression` names, however it was spelled, or `undefined`.
 *
 * `element.scrollTop` and `element["scrollTop"]` name the same member and the rule
 * is about the member, so both spellings resolve here. A computed index that is not
 * a string literal names nothing this scan can decide, and answering `undefined` is
 * the honest reading of that rather than a guess.
 */
function memberNameOf(expression: ts.Expression, parsed: ts.SourceFile): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.getText(parsed);
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

/** Every property an `Object.assign` call would write onto its target. */
function objectAssignedPropertyNames(
  call: ts.CallExpression,
  parsed: ts.SourceFile,
): readonly string[] {
  if (call.expression.getText(parsed) !== "Object.assign") {
    return [];
  }
  return call.arguments
    .filter((argument) => ts.isObjectLiteralExpression(argument))
    .flatMap((literal) => literal.properties)
    .map((property) =>
      property.name !== undefined && !ts.isComputedPropertyName(property.name)
        ? property.name.getText(parsed)
        : undefined,
    )
    .filter((name): name is string => name !== undefined);
}

/**
 * Every way `source` shows it wrote a scroll offset, or `[]`.
 *
 * A pure function over source TEXT so the negative controls below can drive it with
 * bodies whose verdict is known, proving the checker bites without perturbing a real
 * module. `fileName` is the label the parse reads its script kind off, which is why
 * a control hands it the name the body it wrote would have had.
 */
function scrollWriteSignatures(source: string, fileName = "probe.ts"): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found = new Set<string>();
  forEachDescendant(parsed, (node) => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.includes(node.operatorToken.kind)) {
      const member = memberNameOf(node.left, parsed);
      if (member !== undefined && SCROLL_OFFSET_PROPERTIES.includes(member)) {
        found.add(`${member} ${ts.tokenToString(node.operatorToken.kind) ?? "="}`);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      for (const written of objectAssignedPropertyNames(node, parsed)) {
        if (SCROLL_OFFSET_PROPERTIES.includes(written)) {
          found.add(`Object.assign ${written}`);
        }
      }
    }
  });
  return [...found].sort();
}

/** Every unnamed scroll call `source` makes, or `[]`. */
function unnamedScrollApiSignatures(source: string, fileName = "probe.ts"): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found = new Set<string>();
  forEachDescendant(parsed, (node) => {
    if (ts.isCallExpression(node)) {
      // Optional-chained calls (`element?.scrollTo(…)`) are property accesses
      // carrying a question-dot token, so this arm answers them unchanged.
      const called = memberNameOf(node.expression, parsed);
      if (called !== undefined && UNNAMED_SCROLL_METHODS.includes(called)) {
        found.add(`.${called}(`);
      }
      return;
    }
    // `const { scrollTo } = element` takes the method off its receiver, so every
    // later call is on a bare identifier and no call site names the method at all.
    // The binding IS the reach, so it is reported where it happens.
    if (ts.isBindingElement(node)) {
      const bound = (node.propertyName ?? node.name).getText(parsed);
      if (UNNAMED_SCROLL_METHODS.includes(bound)) {
        found.add(`{ ${bound} }`);
      }
    }
  });
  return [...found].sort();
}

describe("the scroll chokepoint — one writer, tree-wide", () => {
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

  it("finds a console tree to scan, and the chokepoint inside it", () => {
    // Without this, a wrong CONSOLE_DIRECTORY would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module assigns a scroll offset", () => {
    const offenders = modules
      .filter((module) => module.displayPath !== CHOKEPOINT_MODULE)
      .map((module) => ({
        module: module.displayPath,
        signatures: scrollWriteSignatures(readConsoleSourceModule(module), module.displayPath),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("no module anywhere reaches for an unnamed scroll call", () => {
    const offenders = modules
      .map((module) => ({
        module: module.displayPath,
        signatures: unnamedScrollApiSignatures(readConsoleSourceModule(module), module.displayPath),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips the write signature", () => {
    // The checker reads real files and the needles match real code. Without this, a
    // typo in a needle would make both clean results above meaningless.
    expect(
      scrollWriteSignatures(
        readConsoleSourceModule(moduleNamed(modules, CHOKEPOINT_MODULE, "the scroll chokepoint")),
        CHOKEPOINT_MODULE,
      ),
    ).toContain("scrollTop =");
  });

  it("negative control: a virtualizer callback that wrote the offset would be caught", () => {
    // The adopted virtualizer's `scrollToFn` is the one seam through which a library
    // could reach the scroll offset, and the shipped implementation hands it to the
    // chokepoint. This is the proof that the scan would catch the other choice: the
    // body below is what the default implementation does, and it trips the rule.
    expect(
      scrollWriteSignatures(
        "scrollToFn: (offset) => { instance.scrollElement.scrollTop = offset; },",
      ),
    ).toStrictEqual(["scrollTop ="]);
    expect(
      unnamedScrollApiSignatures("scrollToFn: (offset) => element.scrollTo({ top: offset })"),
    ).toStrictEqual([".scrollTo("]);
    // And the shipped seam trips neither, because it names a caller and delegates.
    expect(
      scrollWriteSignatures('this.scroll.glideTo("measurement-compensation", offset);'),
    ).toStrictEqual([]);
  });

  it("negative control: the predicates bite, and read like a read", () => {
    expect(scrollWriteSignatures("element.scrollTop = 120;")).toStrictEqual(["scrollTop ="]);
    expect(scrollWriteSignatures("surface.scrollTop += delta;")).toStrictEqual(["scrollTop +="]);
    // A READ is not a write, and the chokepoint's own sample is one.
    expect(scrollWriteSignatures("const offset = element.scrollTop;")).toStrictEqual([]);
    expect(unnamedScrollApiSignatures("row.scrollIntoView({ block: 'center' })")).toStrictEqual([
      ".scrollIntoView(",
    ]);
    expect(
      unnamedScrollApiSignatures("const glide = controller.glideTo('deep-link', 40);"),
    ).toStrictEqual([]);
  });

  it("negative control: every spelling the substring needles missed is caught", () => {
    // One case per form, because each is a different way to defeat a text scan and
    // each was measured passing the needles this claim replaced. A parser answers
    // all of them with the same rule: which member does this assignment target.
    expect(scrollWriteSignatures("element.scrollTop=0;")).toStrictEqual(["scrollTop ="]);
    expect(scrollWriteSignatures("element.scrollTop\n  = offset;")).toStrictEqual(["scrollTop ="]);
    expect(scrollWriteSignatures('element["scrollTop"] = offset;')).toStrictEqual(["scrollTop ="]);
    expect(scrollWriteSignatures("element.scrollTop ??= 0;")).toStrictEqual(["scrollTop ??="]);
    expect(scrollWriteSignatures("element.scrollTop *= 2;")).toStrictEqual(["scrollTop *="]);
    expect(scrollWriteSignatures("element.scrollLeft -= delta;")).toStrictEqual(["scrollLeft -="]);
    expect(scrollWriteSignatures("Object.assign(element, { scrollTop: offset });")).toStrictEqual([
      "Object.assign scrollTop",
    ]);
    expect(unnamedScrollApiSignatures("element?.scrollTo({ top: offset });")).toStrictEqual([
      ".scrollTo(",
    ]);
    expect(unnamedScrollApiSignatures("const { scrollTo } = element;")).toStrictEqual([
      "{ scrollTo }",
    ]);
  });

  it("negative control: a mention is not a write, and a JSX module still parses", () => {
    // The other direction, and the one a coarser instrument gets wrong: the rule has
    // to be statable in prose by the modules it governs, and a `.tsx` module's rows
    // are JSX — parsed as plain TypeScript an opening tag reads as a comparison and
    // the whole body disappears, which would make every clean result over the
    // console's components vacuous.
    expect(scrollWriteSignatures("// never write scrollTop = here; glide instead")).toStrictEqual(
      [],
    );
    expect(scrollWriteSignatures('const rule = "scrollTop = is the chokepoint\'s";')).toStrictEqual(
      [],
    );
    expect(unnamedScrollApiSignatures("// scrollIntoView( is banned everywhere")).toStrictEqual([]);
    expect(
      scrollWriteSignatures(
        "export const row = <div ref={(element) => { element.scrollTop = 0; }} />;",
        "Probe.tsx",
      ),
    ).toStrictEqual(["scrollTop ="]);
  });
});
