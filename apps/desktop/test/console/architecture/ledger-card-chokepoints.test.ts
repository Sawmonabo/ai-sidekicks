// The two claims the ledger's card family makes about itself, asserted over source text.
//
// Both live here rather than beside the modules they check because both read the tree
// with `node:fs`, and a co-located console test compiles under the renderer's own
// program — whose `lib` set has no Node types and whose eslint config bans `node:*`
// outright. The architecture tier is where a test that reads files belongs.
//
// CLAIM 1 — ONE `dangerouslySetInnerHTML` SITE. `Spec-023 §Console Test Tiers` puts it
// in this tier by name: "no `dangerouslySetInnerHTML` outside the math-owned node" — the
// node KaTeX renders into, and no other. Every other body on the
// markdown path is React elements built from a parsed tree, which is what lets that path
// carry no sanitizer at all — nothing on it is ever parsed as markup. A second site
// would silently retire that property, and it would arrive the way the byte formatter
// would: as three lines in a component that needed to render something it already had as
// a string.
//
// CLAIM 2 — EVERY CODE TOKEN FAMILY HAS A COLOUR. The highlighter's theme emits
// `var(--meridian-code-<family>)` as each token's foreground rather than a literal
// colour, which is what makes one token cache serve both schemes. The cost of that
// design is a seam: a family with no custom property renders as the browser's inherited
// text colour and looks like a token the grammar failed to classify. The enumeration and
// the sheet that declares those properties are the two halves, and this is where they
// are held together. That sheet is the GENERATED token sheet: the colours live in
// `tokens/palette.ts` so one resolver fits them into sRGB and one test measures them,
// and this claim reads the generator's output rather than a stylesheet so it checks
// what the document will actually carry.

import { describe, expect, it } from "vitest";

import {
  CODE_TOKEN_FAMILIES,
  COLOURED_CODE_TOKEN_FAMILIES,
  codeTokenVariableName,
  type CodeTokenFamily,
} from "../../../src/renderer/src/console/ledger/cards/markdown/meridian-code-theme.js";
import { generateMeridianCss } from "../../../src/renderer/src/console/tokens/generate-css.js";
import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The one module allowed to hand React a markup string.
 *
 * A path rather than a naming convention, for `wire-figure-chokepoint.test.ts`' reason:
 * moving the chokepoint should be an edit a reviewer sees in the diff.
 */
const MARKUP_CHOKEPOINT_MODULE = "console/ledger/cards/markdown/MathBlock.tsx";

/** The module a second markup site would most plausibly appear in. */
const MARKDOWN_MAPPER_MODULE = "console/ledger/cards/markdown/MarkdownNodes.tsx";

/**
 * The React prop that hands a string to the parser, in the only position that reaches
 * it.
 *
 * The trailing `={` is the whole discriminator, and it is what makes this a check on
 * USE rather than on MENTION. Three console modules name this prop in prose — the
 * tripwire registry's header, the code block's header explaining why it has no such
 * path, and the markdown barrel's line naming this file's subject — and a checker that
 * flagged those would be unrunnable within a week: the first author to explain the rule
 * in a comment would break the gate that enforces it. A JSX attribute is always
 * `name={…}`, and prose never is.
 */
const MARKUP_ESCAPE_HATCH = "dangerouslySetInnerHTML={";

/**
 * Whether `source` reaches the escape hatch.
 *
 * A pure function over text so the negative controls below can drive it with strings
 * whose verdict is known, rather than proving the checker bites by perturbing a real
 * module.
 */
function usesMarkupEscapeHatch(source: string): boolean {
  return source.includes(MARKUP_ESCAPE_HATCH);
}

describe("the markup escape hatch", () => {
  it("is reached by exactly one console module", () => {
    const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    // A tripwire that matched nothing would pass silently, so the sweep asserts it read
    // a tree rather than an empty directory.
    expect(modules.length).toBeGreaterThan(20);

    const reachingModules = modules
      .filter((module) => usesMarkupEscapeHatch(readConsoleSourceModule(module)))
      .map((module) => module.displayPath);
    expect(reachingModules).toStrictEqual([MARKUP_CHOKEPOINT_MODULE]);
  });

  it("negative control: the checker bites on a module that reaches it", () => {
    // Without this, a checker whose match string had drifted would report a clean tree
    // and prove nothing at all.
    expect(usesMarkupEscapeHatch("<div dangerouslySetInnerHTML={{ __html: markup }} />")).toBe(
      true,
    );
    expect(usesMarkupEscapeHatch("<div>{renderedNodes}</div>")).toBe(false);
    // And the mention arm, which is the reason the discriminator is what it is.
    expect(usesMarkupEscapeHatch("// never dangerouslySetInnerHTML on this path")).toBe(false);
  });

  it("is the only markup-string prop the markdown mapper could have used", () => {
    // The mapper is the module a second site would most plausibly appear in, because it
    // is the one holding an `html` node's own text. It renders that text as text.
    const mapper = moduleNamed(
      consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }),
      MARKDOWN_MAPPER_MODULE,
      "the markdown node mapper",
    );
    expect(usesMarkupEscapeHatch(readConsoleSourceModule(mapper))).toBe(false);
  });
});

/**
 * A family the enumeration does not carry, for the controls to drive the real
 * predicates with.
 *
 * Cast once, here: the predicates below take `CodeTokenFamily` because that is what
 * the production code hands them, and a control has to be able to ask them about a
 * family the stylesheet cannot possibly declare. Naming it once keeps the cast out
 * of the cases.
 */
const UNDECLARED_FAMILY = "unclassified" as CodeTokenFamily;

describe("the code token palette", () => {
  // The generated sheet, built rather than read: there is no committed copy of it,
  // and building it is what makes this a claim about the text the document receives.
  const tokenSheet = generateMeridianCss();

  /** Which of `families` the sheet given declares nothing for. The one predicate. */
  function familiesWithoutADeclaration(
    sheet: string,
    families: readonly CodeTokenFamily[],
  ): readonly CodeTokenFamily[] {
    return families.filter((family) => !sheet.includes(`${codeTokenVariableName(family)}:`));
  }

  /** The scheme-scoped half of the sheet, so a light-only declaration is not counted. */
  function darkSchemeBlockOf(sheet: string): string {
    return sheet.slice(sheet.indexOf('[data-console-scheme="dark"]'));
  }

  it("declares a colour for every family the theme emits", () => {
    expect(familiesWithoutADeclaration(tokenSheet, CODE_TOKEN_FAMILIES)).toStrictEqual([]);
  });

  it("negative control: an undeclared family is reported by the real predicate", () => {
    // Driving the predicate rather than asserting a string is absent: a control that
    // only checked absence would pass on an empty sheet, on a generator that had
    // stopped emitting these, and on a `codeTokenVariableName` returning "".
    expect(
      familiesWithoutADeclaration(tokenSheet, [...CODE_TOKEN_FAMILIES, UNDECLARED_FAMILY]),
    ).toStrictEqual([UNDECLARED_FAMILY]);
    // And the same predicate over a sheet that declares nothing reports every family,
    // which is what fails if the variable name ever stops discriminating.
    expect(familiesWithoutADeclaration("", CODE_TOKEN_FAMILIES)).toStrictEqual([
      ...CODE_TOKEN_FAMILIES,
    ]);
  });

  it("declares each coloured family under both schemes rather than only the default one", () => {
    // A family declared once, in the unconditional root block, renders identically in
    // both schemes — which for a foreground on a dark ground is the failure this rule
    // exists to prevent. The neutral families defer to the console's own text tokens,
    // which already swap, so the claim quantifies over the complement the theme
    // derives rather than over a list written out here — a hand-written subset stops
    // covering a sixth coloured family on the day one is added, silently.
    expect(
      familiesWithoutADeclaration(darkSchemeBlockOf(tokenSheet), COLOURED_CODE_TOKEN_FAMILIES),
    ).toStrictEqual([]);
  });

  it("negative control: the coloured set is a partition of the declared enumeration, and the dark claim bites", () => {
    // Without the first half, a `COLOURED_CODE_TOKEN_FAMILIES` that had drifted to
    // empty would make the claim above pass over nothing at all.
    expect(COLOURED_CODE_TOKEN_FAMILIES.length).toBeGreaterThan(0);
    expect(
      COLOURED_CODE_TOKEN_FAMILIES.every((family) => CODE_TOKEN_FAMILIES.includes(family)),
    ).toBe(true);
    // And the dark-scheme claim reports a coloured family the block does not carry.
    expect(
      familiesWithoutADeclaration(darkSchemeBlockOf(tokenSheet), [
        ...COLOURED_CODE_TOKEN_FAMILIES,
        UNDECLARED_FAMILY,
      ]),
    ).toStrictEqual([UNDECLARED_FAMILY]);
  });
});
