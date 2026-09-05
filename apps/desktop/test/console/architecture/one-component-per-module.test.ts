// A `.tsx` module declares one component.
//
// `apps/desktop/AGENTS.md` states the rule — "`.tsx` files are PascalCase, one
// component each" — and until this file nothing checked it, which is how
// `primitives/PartialRead.tsx` came to declare `PartialRead` and a second component,
// `ReadingNotice`, that no reader looking for a notice would have found and no test
// could reach except through the first. A convention with no instrument is a
// convention that holds for as long as everyone remembers it.
//
// THE INSTRUMENT IS THE PARSER, and here that is not a preference. The question is
// which components a module DECLARES, which is a question about declaration
// boundaries: a text scan for `function [A-Z]` reads the same words inside a comment,
// inside a string, and inside a nested closure, and a scan for `export function [A-Z]`
// misses exactly the case above, where the second component was private.
//
// WHAT COUNTS AS A COMPONENT, decided once and stated in the positive: a top-level
// function or `const` declaration whose name is PascalCase and which renders markup —
// either JSX somewhere in its own body, or a declared return type that is a React
// element. The second half is load-bearing rather than belt-and-braces:
// `primitives/Nothing.tsx` composes its whole body out of two camelCase helpers and
// carries no JSX of its own, so a JSX-only predicate resolved it to ZERO components
// and would have scored every module beside it against a rule it was not applying.
// Claim 1 is what keeps that honest — every `.tsx` module resolves at least one
// component, so a predicate that had gone blind fails there rather than passing here.
//
// AND THERE IS NO INVENTORY. Eight console modules in three families declared more
// than one component when this gate landed. They were listed by path and asserted
// exactly — a ratchet that could only shrink, and the reason the gate could land at
// all rather than waiting on eight splits nobody had asked for. All eight are split,
// so the list is gone and the offender set is asserted against the empty set
// directly. That is not a tidy-up: a list of known violations is a catalog, and
// `apps/desktop/AGENTS.md` admits none — a rule with a standing list of the places it
// does not hold is a rule that has already been negotiated with once.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * How a component that renders through helpers still says it is one.
 *
 * `Nothing.tsx` is the measured case: its body is two camelCase helper calls and
 * carries no JSX at all, so its declared return type is the only signal it renders.
 */
const ELEMENT_RETURN_TYPE_SPELLINGS: readonly string[] = [
  "JSX.Element",
  "ReactNode",
  "ReactElement",
];

/** A component's name, as this tree spells one. */
function isComponentName(name: string): boolean {
  return /^[A-Z]/u.test(name);
}

/** Whether `declaration` renders markup — JSX in its body, or an element return type. */
function rendersMarkup(declaration: ts.Node, parsed: ts.SourceFile): boolean {
  let renders = false;
  const consider = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      renders = true;
      return;
    }
    if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node)) {
      return;
    }
    const returnType = node.type;
    if (returnType === undefined) {
      return;
    }
    const returnTypeText = returnType.getText(parsed);
    if (ELEMENT_RETURN_TYPE_SPELLINGS.some((spelling) => returnTypeText.includes(spelling))) {
      renders = true;
    }
  };
  consider(declaration);
  forEachDescendant(declaration, consider);
  return renders;
}

/**
 * Every component `source` declares, in source order.
 *
 * Pure over text so the controls below can drive it with corpora whose verdict is
 * known; the walk that produces the real module set stays in the gate, where
 * `source-walk-chokepoint.test.ts` can see it.
 */
function componentNamesIn(source: string, fileName: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      isComponentName(statement.name.text) &&
      rendersMarkup(statement, parsed)
    ) {
      names.push(statement.name.text);
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        isComponentName(declaration.name.text) &&
        declaration.initializer !== undefined &&
        rendersMarkup(declaration, parsed)
      ) {
        names.push(declaration.name.text);
      }
    }
  }
  return names;
}

/** The shape the rule was written for: one exported component, one private beside it. */
const TWO_COMPONENTS_IN_ONE_MODULE = [
  'import { Nothing } from "./Nothing.js";',
  "export function PartialRead(props: PartialReadProps): React.JSX.Element | null {",
  "  return <>{notices.map((notice) => <ReadingNotice notice={notice} />)}</>;",
  "}",
  "function ReadingNotice(props: { readonly notice: PartialReadNotice }): React.JSX.Element {",
  '  return <Nothing kind="not-loaded" placement="inline" title={props.notice.title} />;',
  "}",
].join("\n");

describe("one component per module — the console's .tsx modules", () => {
  // The rule (`apps/desktop/AGENTS.md` §Module layout) binds every `.tsx` module the
  // console ships or shares: production components and the `.test-support.tsx`
  // scaffolding suites import, which is a module like any other. A co-located
  // `.test.tsx` is the one exemption the rule itself states — its probe components are
  // private to its cases — so the walk includes tests and the filter removes exactly
  // that suffix, never the support modules.
  const componentModules: readonly ConsoleSourceModule[] = consoleSourceModules({
    tests: true,
  }).filter(
    (module) => module.displayPath.endsWith(".tsx") && !module.displayPath.endsWith(".test.tsx"),
  );
  const productionComponentModules: readonly ConsoleSourceModule[] = componentModules.filter(
    (module) => !module.displayPath.endsWith(".test-support.tsx"),
  );

  it("finds the .tsx modules to scan at all", () => {
    expect(componentModules.length).toBeGreaterThan(20);
  });

  it("resolves at least one component in every one of them", () => {
    // Non-vacuity, and the reason the predicate reads return types as well as JSX: a
    // module resolving to zero components would score clean against a rule that was
    // never applied to it, and `Nothing.tsx` really is such a module.
    const silent = productionComponentModules
      .filter(
        (module) =>
          componentNamesIn(readConsoleSourceModule(module), module.displayPath).length === 0,
      )
      .map((module) => module.displayPath);
    expect(silent).toStrictEqual([]);
  });

  it("declares one component each, with no inventory of exceptions", () => {
    const offenders = componentModules
      .filter(
        (module) =>
          componentNamesIn(readConsoleSourceModule(module), module.displayPath).length > 1,
      )
      .map((module) => module.displayPath);
    expect(offenders).toStrictEqual([]);
  });
});

describe("one component per module — the predicate bites", () => {
  it("negative control: a module declaring a second, private component is an offence", () => {
    // The exact shape the finding named, before the split: `PartialRead` exported and
    // `ReadingNotice` beside it, private. A gate that counted only EXPORTED components
    // would report this module clean, which is the whole reason the walk counts both.
    expect(componentNamesIn(TWO_COMPONENTS_IN_ONE_MODULE, "PartialRead.tsx")).toStrictEqual([
      "PartialRead",
      "ReadingNotice",
    ]);
  });

  it("negative control: the split module is not", () => {
    const split = [
      'import { ReadingNotice } from "./ReadingNotice.js";',
      "export function PartialRead(props: PartialReadProps): React.JSX.Element | null {",
      "  return <>{notices.map((notice) => <ReadingNotice notice={notice} />)}</>;",
      "}",
    ].join("\n");
    expect(componentNamesIn(split, "PartialRead.tsx")).toStrictEqual(["PartialRead"]);
  });

  it("negative control: a PascalCase declaration that renders nothing is not a component", () => {
    // Closed sets, tokens, and classes are the ordinary uppercase residents of this
    // tree. Counting them would make almost every module an offence and the gate
    // useless within a week.
    const notComponents = [
      'export const NOTHING_KINDS = ["not-loaded", "empty"] as const;',
      "export class LiveAnnouncer {",
      "  public dispose(): void {}",
      "}",
      "export interface PartialReadProps {",
      "  readonly subject: string;",
      "}",
    ].join("\n");
    expect(componentNamesIn(notComponents, "Sample.tsx")).toStrictEqual([]);
  });

  it("negative control: a camelCase render helper beside a component is not a second one", () => {
    // `Nothing.tsx`'s own shape: the component delegates its whole body to two
    // helpers, and helpers are not what the rule counts.
    const withHelpers = [
      "export function Nothing(props: NothingProps): React.JSX.Element {",
      "  return renderBlock(props);",
      "}",
      "function renderBlock(props: NothingProps): React.JSX.Element {",
      '  return <div className="meridian-nothing" />;',
      "}",
    ].join("\n");
    expect(componentNamesIn(withHelpers, "Nothing.tsx")).toStrictEqual(["Nothing"]);
  });

  it("negative control: a component name inside a comment or a string is not a declaration", () => {
    // The class a text scan cannot separate, and the reason this gate parses.
    const mentions = [
      "// Deliberately not a second component: ReadingNotice lives next door.",
      'const label = "function ReadingNotice(): React.JSX.Element";',
      "export function PartialRead(): React.JSX.Element {",
      "  return <p>{label}</p>;",
      "}",
    ].join("\n");
    expect(componentNamesIn(mentions, "PartialRead.tsx")).toStrictEqual(["PartialRead"]);
  });
});
