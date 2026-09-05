// One home for every glyph size the console publishes.
//
// `tokens/glyphs.ts` is that home. It publishes `GLYPH_DEFAULT_SIZE` for a mark that
// IS the thing (a kind glyph beside a heading, a rail destination) and
// `GLYPH_SIZE_CHROME` for a mark inside a frame (a refusal's alert, a pane control, a
// breadcrumb separator), beside the viewBox every path is drawn in.
//
// WHAT THIS GATE REFUSES is not a wrong number; it is a SECOND copy of a published
// one. The defect it was written from had three private copies of `14` in three
// families, two of which named each other as their authority in a COMMENT — a
// citation rather than a dependency, so the compiler saw nothing when one moved and
// the chrome drifted family by family. A ratio held by agreement is not held.
//
// THE RULE IS KEYED ON THE VALUE, not on a list of blessed modules. A size the home
// does not publish is outside it — a family may still be the first to need one, and
// an exemption list naming today's would rot at the next family merge. The coupling
// this buys is the point: the day a size becomes a token, every private copy of it
// becomes a violation here, so publishing a size and retiring its copies is one
// change rather than two that drift apart.
//
// A family may still NAME its own size — `PANE_KIND_GLYPH_SIZE` does, and the name is
// what makes the call site legible. The rule is about the INITIALIZER: a numeric
// literal is a second answer, an identifier is a dependency.
//
// Read by parse rather than by regex, on this tier's standing rule: a declaration is
// a syntactic thing, and a regex over source text cannot tell one inside a comment or
// a string from one the module actually declares.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The one module that may answer with a number. Every other module reads from it. */
const GLYPH_SIZE_HOME = "console/tokens/glyphs.ts";

/**
 * Whether an identifier names a glyph size.
 *
 * Deliberately broad on the NAME — both words, in any order, under any prefix —
 * because the subject is a size a family invented, and a family inventing one will
 * not have asked this file what to call it.
 */
function namesAGlyphSize(identifier: string): boolean {
  const upper = identifier.toUpperCase();
  return upper.includes("GLYPH") && upper.includes("SIZE");
}

/** One glyph-size constant declared with a literal number, as a failure names it. */
interface LiteralGlyphSize {
  readonly displayPath: string;
  readonly name: string;
  readonly value: number;
}

/**
 * Every glyph-size constant `source` initializes from a numeric literal.
 *
 * A declaration with no initializer, or one initialized from anything that is not a
 * plain number — an identifier, a member access, an expression over a token — is a
 * dependency rather than a second answer, and is not reported.
 */
function literalGlyphSizesIn(displayPath: string, source: string): readonly LiteralGlyphSize[] {
  const found: LiteralGlyphSize[] = [];
  forEachDescendant(parseSourceText(displayPath, source), (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      return;
    }
    const initializer = node.initializer;
    if (initializer === undefined || !ts.isNumericLiteral(initializer)) {
      return;
    }
    if (!namesAGlyphSize(node.name.text)) {
      return;
    }
    found.push({ displayPath, name: node.name.text, value: Number(initializer.text) });
  });
  return found;
}

/** Every glyph-size name `source` imports, from wherever it imports it. */
function importedGlyphSizesIn(displayPath: string, source: string): readonly string[] {
  const found: string[] = [];
  forEachDescendant(parseSourceText(displayPath, source), (node) => {
    if (!ts.isImportDeclaration(node)) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      return;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (namesAGlyphSize(imported)) {
        found.push(imported);
      }
    }
  });
  return found;
}

/** How a failure names one restated size: the module, the name, and the value. */
function describeRestatement(entry: LiteralGlyphSize): string {
  return `${entry.displayPath} declares ${entry.name} = ${String(entry.value)}, a size tokens/glyphs.ts already publishes`;
}

describe("glyph sizes — a published size is declared once", () => {
  const modules = consoleSourceModules();
  const home: ConsoleSourceModule = moduleNamed(modules, GLYPH_SIZE_HOME, "the glyph token home");
  const publishedSizes = new Set(
    literalGlyphSizesIn(home.displayPath, readConsoleSourceModule(home)).map(
      (entry) => entry.value,
    ),
  );
  const elsewhere = modules.filter((module) => module.displayPath !== GLYPH_SIZE_HOME);

  it("finds a tree to scan and a home that publishes more than one size", () => {
    // Without this a wrong root would scan nothing, and an empty published set would
    // make the claim below quantify over no values at all.
    expect(modules.length).toBeGreaterThan(50);
    expect(publishedSizes.size).toBeGreaterThan(1);
  });

  it("no module outside the home restates a size the home publishes", () => {
    const restatements = elsewhere
      .flatMap((module) => literalGlyphSizesIn(module.displayPath, readConsoleSourceModule(module)))
      .filter((entry) => publishedSizes.has(entry.value))
      .map(describeRestatement);
    expect(restatements).toStrictEqual([]);
  });

  it("modules outside the home read the published sizes, so the rule has subjects", () => {
    // The claim above is satisfied both by a console that reads its tokens and by one
    // that draws no glyphs at all. This is what separates them: the sizes are not
    // merely unrestated, they are in use through the door.
    const readers = elsewhere.filter(
      (module) =>
        importedGlyphSizesIn(module.displayPath, readConsoleSourceModule(module)).length > 0,
    );
    expect(readers.length).toBeGreaterThan(1);
  });

  it("negative control: the reader reports a planted literal and passes a read one", () => {
    // Without this, a predicate that matched nothing — a name test that never fired,
    // a walk that never descended into a module body — would make both claims above
    // pass over any tree.
    const planted = [
      "const OUTER_GLYPH_SIZE = 14;",
      "function draw() {",
      "  const innerGlyphSize = 12;",
      "  return innerGlyphSize;",
      "}",
    ].join("\n");
    expect(literalGlyphSizesIn("planted.ts", planted)).toStrictEqual([
      { displayPath: "planted.ts", name: "OUTER_GLYPH_SIZE", value: 14 },
      { displayPath: "planted.ts", name: "innerGlyphSize", value: 12 },
    ]);

    const compliant = [
      'import { GLYPH_SIZE_CHROME } from "../tokens/index.js";',
      "const PANE_GLYPH_SIZE = GLYPH_SIZE_CHROME;",
      "// const COMMENTED_GLYPH_SIZE = 14;",
      'const MENTION_GLYPH_SIZE_TEXT = "GLYPH_SIZE = 14";',
    ].join("\n");
    expect(literalGlyphSizesIn("compliant.ts", compliant)).toStrictEqual([]);
    expect(importedGlyphSizesIn("compliant.ts", compliant)).toStrictEqual(["GLYPH_SIZE_CHROME"]);
  });
});
