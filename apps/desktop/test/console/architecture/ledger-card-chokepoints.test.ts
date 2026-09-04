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
// the stylesheet are the two halves, and this is where they are held together.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODE_TOKEN_FAMILIES,
  codeTokenVariableName,
} from "../../../src/renderer/src/console/ledger/cards/markdown/meridian-code-theme.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIRECTORY = resolve(HERE, "..", "..", "..", "src", "renderer", "src", "console");

/**
 * The one module allowed to hand React a markup string.
 *
 * A path rather than a naming convention, for `wire-figure-chokepoint.test.ts`' reason:
 * moving the chokepoint should be an edit a reviewer sees in the diff.
 */
const MARKUP_CHOKEPOINT_MODULE = join("ledger", "cards", "markdown", "MathBlock.tsx");

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

/** Every console source module, test files and declarations excluded. */
function consoleSourceModules(): readonly string[] {
  return readdirSync(CONSOLE_DIRECTORY, { recursive: true, encoding: "utf8" }).filter(
    (entry) =>
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".d.ts"),
  );
}

describe("the markup escape hatch", () => {
  it("is reached by exactly one console module", () => {
    const modules = consoleSourceModules();
    // A tripwire that matched nothing would pass silently, so the sweep asserts it read
    // a tree rather than an empty directory.
    expect(modules.length).toBeGreaterThan(20);

    const reachingModules = modules.filter((entry) =>
      usesMarkupEscapeHatch(readFileSync(join(CONSOLE_DIRECTORY, entry), "utf8")),
    );
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
    const mapper = readFileSync(
      join(CONSOLE_DIRECTORY, "ledger", "cards", "markdown", "MarkdownNodes.tsx"),
      "utf8",
    );
    expect(usesMarkupEscapeHatch(mapper)).toBe(false);
  });
});

describe("the code token palette", () => {
  const stylesheet = readFileSync(join(CONSOLE_DIRECTORY, "ledger", "ledger.css"), "utf8");

  it("declares a colour for every family the theme emits", () => {
    const undeclared = CODE_TOKEN_FAMILIES.filter(
      (family) => !stylesheet.includes(`${codeTokenVariableName(family)}:`),
    );
    expect(undeclared).toStrictEqual([]);
  });

  it("negative control: a family the stylesheet does not declare is caught", () => {
    // The checker is only worth running if a missing declaration fails it, so drive the
    // same predicate with a family name the stylesheet cannot contain.
    expect(stylesheet.includes("--meridian-code-unclassified:")).toBe(false);
  });

  it("declares each family under both schemes rather than only the default one", () => {
    // A family declared once, on `:root`, renders identically in both schemes — which
    // for a foreground on a dark ground is the failure this rule exists to prevent. The
    // four neutral families defer to the console's own text tokens, which already swap,
    // so only the five coloured ones need a second declaration.
    const darkBlock = stylesheet.slice(stylesheet.indexOf('[data-console-scheme="dark"]'));
    const colouredFamilies = ["keyword", "name", "string", "number", "type"] as const;
    const missingFromDark = colouredFamilies.filter(
      (family) => !darkBlock.includes(`${codeTokenVariableName(family)}:`),
    );
    expect(missingFromDark).toStrictEqual([]);
  });
});
