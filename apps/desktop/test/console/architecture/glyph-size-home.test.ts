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
import { beforeAll, describe, expect, it, vi } from "vitest";

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

/**
 * The budgets this file states rather than inherits, and why they differ.
 *
 * Reading and parsing the console once costs ~150 ms alone on the authoring machine
 * and multiplies under the gate's five-project concurrency — the load, not the tree,
 * is what a budget here has to survive, which is the same finding that put explicit
 * budgets on `barrel-census.test.ts`. The hook pays for that whole reading and is set
 * well above the loaded cost, because what a budget guards is a reading that never
 * settles rather than a slow one. The cases pay only for comparisons over a reading
 * already in hand, measured at 0-2 ms each, so their budget is deliberately smaller: a
 * case that somehow became the first to touch the reading should fail fast and say so
 * rather than inherit the hook's patience.
 */
const CONSOLE_READING_ALLOWANCE_MS = 30_000;
const COMPARISON_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: COMPARISON_ALLOWANCE_MS, hookTimeout: CONSOLE_READING_ALLOWANCE_MS });

/** What one reading of the tree answers. Every case below is a comparison over this. */
interface GlyphSizeReading {
  readonly moduleCount: number;
  readonly publishedSizes: ReadonlySet<number>;
  readonly restatements: readonly string[];
  readonly readerCount: number;
}

/**
 * The one reading this file pays for, and the cases' only source.
 *
 * Behind a private field with a throwing accessor rather than a mutable binding a case
 * could read as `undefined`: a hook that failed would otherwise surface as a type
 * error in whichever case ran first, which names the wrong thing.
 */
class GlyphSizeCensus {
  #reading: GlyphSizeReading | undefined = undefined;

  public get reading(): GlyphSizeReading {
    if (this.#reading === undefined) {
      throw new Error("the console reading was asked for before the hook filled it in");
    }
    return this.#reading;
  }

  public read(): void {
    const modules = consoleSourceModules();
    const home: ConsoleSourceModule = moduleNamed(modules, GLYPH_SIZE_HOME, "the glyph token home");
    const publishedSizes = new Set(
      literalGlyphSizesIn(home.displayPath, readConsoleSourceModule(home)).map(
        (entry) => entry.value,
      ),
    );
    const restatements: string[] = [];
    let readerCount = 0;
    for (const module of modules) {
      if (module.displayPath === GLYPH_SIZE_HOME) {
        continue;
      }
      const source = readConsoleSourceModule(module);
      for (const entry of literalGlyphSizesIn(module.displayPath, source)) {
        if (publishedSizes.has(entry.value)) {
          restatements.push(describeRestatement(entry));
        }
      }
      if (importedGlyphSizesIn(module.displayPath, source).length > 0) {
        readerCount += 1;
      }
    }
    this.#reading = { moduleCount: modules.length, publishedSizes, restatements, readerCount };
  }
}

describe("glyph sizes — a published size is declared once", () => {
  const census = new GlyphSizeCensus();

  beforeAll(() => {
    census.read();
  });

  it("finds a tree to scan and a home that publishes more than one size", () => {
    // Without this a wrong root would scan nothing, and an empty published set would
    // make the claim below quantify over no values at all.
    expect(census.reading.moduleCount).toBeGreaterThan(50);
    expect(census.reading.publishedSizes.size).toBeGreaterThan(1);
  });

  it("no module outside the home restates a size the home publishes", () => {
    expect(census.reading.restatements).toStrictEqual([]);
  });

  it("modules outside the home read the published sizes, so the rule has subjects", () => {
    // The claim above is satisfied both by a console that reads its tokens and by one
    // that draws no glyphs at all. This is what separates them: the sizes are not
    // merely unrestated, they are in use through the door.
    expect(census.reading.readerCount).toBeGreaterThan(1);
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
