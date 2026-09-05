// One documentation block per declaration, and it has to be attached to one.
//
// A JSDoc block belongs to the declaration under it, and TypeScript attaches EVERY
// leading block to that declaration. So two stacked blocks are not two comments — the
// upper one has silently changed what it documents, and its subject is whatever the
// editor moved in underneath it. Nothing reports that: the compiler is content, the
// linter is content, and the block still reads correctly on its own, which is exactly
// why it survives review.
//
// The shape arrives two ways, and both are edits rather than authorship. A new
// declaration is inserted between a block and the declaration it described, which
// strands the block and leaves the old declaration undocumented. Or a block is copied
// with the declaration it describes and the copy lands above one that already had
// one. This gate has caught both in this tree.
//
// AND A SECOND SHAPE THE FIRST INSTRUMENT CANNOT SEE. A block written between
// `export` and the declaration keyword documents NOTHING: the parser attaches no
// JSDoc node to the declaration and resolves zero leading ranges for the statement,
// so a gate reading only the statement's own start reported both "this declaration is
// undocumented" and "there is no block here" — wrongly, and silently. Every editor
// still renders the sentence, which is why the shape survives review; one family
// branch carries seventeen of them. It is read from the last modifier's end, and from
// BOTH of the compiler's comment readers, because it splits this one position between
// them — see `documentationBlocksInModifiers`.
//
// THE FIRST STATEMENT IS EXEMPT FROM THE FIRST SHAPE, and the exemption is structural rather than a
// grandfather clause: a module whose header is written as a block comment is a
// leading block on whatever statement comes first, and a header describing the module
// is not a second description of that statement. Every later statement has no such
// excuse.
//
// SCANNED PACKAGE-WIDE, because neither arm of the defect is a console phenomenon. An
// insertion under a block and a copied block both land wherever someone is editing:
// `src/main/`, a co-located test, and above all a `.test-support.*` module, which is
// the one place a block is routinely copied along WITH the declaration it describes.
// This gate read the console's non-test modules for its first life and reported clean
// while the two largest homes of its own defect went unread — and the tests it did not
// read outnumber the modules it did. `DESKTOP_PROSE_ROOTS` with `{ tests: true }` is
// what reaches all of it, and the case below asserts each class the narrower scan
// missed rather than trusting a single count.
//
// Read by parse rather than by regex. Whether two blocks are stacked is a question
// about what the parser ATTACHES — a blank line, an intervening statement, or a line
// comment between them all change the answer, and none of those is visible to a
// pattern that matches `*/` followed by `/**`. The detached shape is the same question
// asked at a different position, and a pattern cannot ask it at all.

import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  DESKTOP_PROSE_ROOTS,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";

/** One declaration whose documentation is wrong, and which of the two ways it is. */
interface StrandedDocumentation {
  readonly displayPath: string;
  readonly line: number;
  /** `stacked`: more than one leading block. `detached`: a block inside the modifiers. */
  readonly cause: "stacked" | "detached";
  readonly blockCount: number;
}

/** Every JSDoc block among the comment ranges leading the position given. */
function documentationBlocksAt(source: string, position: number): number {
  return countDocumentation(source, ts.getLeadingCommentRanges(source, position));
}

/**
 * Every JSDoc block sitting between the modifiers and the declaration keyword.
 *
 * BOTH readers, because the compiler splits this one position between them and
 * neither half alone sees the shape. `getLeadingCommentRanges` collects nothing until
 * it has passed a line break — which is the whole of why `export /** … *\/ interface`
 * is invisible to a leading-range reader — while `getTrailingCommentRanges` collects
 * exactly the same-line case and stops at the first newline. A block written on the
 * line after `export` is the leading one. Measured against the compiler rather than
 * assumed: the two readers answered `undefined` and a range respectively for the
 * same-line form, and swapped for the next-line form.
 */
function documentationBlocksInModifiers(source: string, position: number): number {
  return (
    countDocumentation(source, ts.getTrailingCommentRanges(source, position)) +
    countDocumentation(source, ts.getLeadingCommentRanges(source, position))
  );
}

/** How many of `ranges` open a JSDoc rather than a line or a plain block comment. */
function countDocumentation(
  source: string,
  ranges: readonly ts.CommentRange[] | undefined,
): number {
  return (ranges ?? []).filter((range) => source.startsWith("/**", range.pos)).length;
}

/**
 * Every statement in `source` whose documentation does not describe it.
 *
 * TWO SHAPES, and the second is invisible to the first's instrument. STACKED is more
 * than one leading block: the count comes from the comment ranges the parser resolves
 * for the statement's own full start, filtered to blocks that open a JSDoc — a line
 * comment and a plain block comment are not documentation and do not participate.
 *
 * DETACHED is a block written INSIDE the modifiers, between `export` and the
 * declaration keyword, and it documents nothing at all: the parser attaches no JSDoc
 * node to the declaration and resolves zero leading ranges for the statement, so a
 * gate reading only the statement's own start reports the declaration as undocumented
 * and the block as absent — both wrongly, and both silently. Every editor and every
 * reader still shows the sentence, which is why the shape survives review. It is read
 * from the last modifier's end, which is the one position that trivia leads.
 *
 * The first statement is exempt from STACKED only. A module header written as a block
 * is a leading block on whatever comes first, and that is not a second description of
 * it; nothing makes a comment between `export` and `interface` a header.
 */
function strandedDocumentationIn(
  displayPath: string,
  source: string,
): readonly StrandedDocumentation[] {
  const sourceFile = parseSourceText(displayPath, source);
  const found: StrandedDocumentation[] = [];
  const lineOf = (statement: ts.Statement): number =>
    sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
  sourceFile.statements.forEach((statement, index) => {
    const stacked = index === 0 ? 0 : documentationBlocksAt(source, statement.getFullStart());
    if (stacked > 1) {
      found.push({ displayPath, line: lineOf(statement), cause: "stacked", blockCount: stacked });
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const lastModifier = modifiers?.at(-1);
    if (lastModifier === undefined) {
      return;
    }
    const detached = documentationBlocksInModifiers(source, lastModifier.end);
    if (detached > 0) {
      found.push({
        displayPath,
        line: lineOf(statement),
        cause: "detached",
        blockCount: detached,
      });
    }
  });
  return found;
}

/** How a failure names one: where it is, which shape, and how many blocks. */
function describeStranded(entry: StrandedDocumentation): string {
  const blocks = `${String(entry.blockCount)} documentation block${entry.blockCount === 1 ? "" : "s"}`;
  return entry.cause === "stacked"
    ? `${entry.displayPath}:${String(entry.line)} carries ${blocks} on one declaration`
    : `${entry.displayPath}:${String(entry.line)} carries ${blocks} inside its own modifiers, where the parser attaches it to nothing`;
}

/**
 * The budgets this file states rather than inherits, and why they differ.
 *
 * One reading and parse of the whole package costs 250-340 ms alone on the authoring
 * machine — measured 2026-09-05 over its 541 modules, against 145 ms over the 218 this
 * gate read while its subject was the console alone — and it multiplies under the
 * gate's five-project concurrency. The load, not the tree, is what a budget here has to
 * survive, the same finding that put explicit budgets on `barrel-census.test.ts`. The
 * hook pays for the whole reading and stays well above the loaded cost, because what a
 * budget guards is a reading that never settles rather than a slow one; widening the
 * subject three-fold did not move it, which is the point of the headroom. The cases
 * compare over a reading already in hand at 0-1 ms each, so their budget is
 * deliberately smaller: a case that somehow became the first to touch the reading
 * should fail fast and say so rather than inherit the hook's patience.
 */
const CONSOLE_READING_ALLOWANCE_MS = 30_000;
const COMPARISON_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: COMPARISON_ALLOWANCE_MS, hookTimeout: CONSOLE_READING_ALLOWANCE_MS });

/** What one reading of the tree answers. Every case below is a comparison over this. */
interface DocumentationReading {
  readonly displayPaths: readonly string[];
  readonly stranded: readonly string[];
}

/**
 * The one reading this file pays for, and the cases' only source.
 *
 * Behind a private field with a throwing accessor rather than a mutable binding a case
 * could read as `undefined`: a hook that failed would otherwise surface as a type
 * error in whichever case ran first, which names the wrong thing.
 */
class DocumentationCensus {
  #reading: DocumentationReading | undefined = undefined;

  public get reading(): DocumentationReading {
    if (this.#reading === undefined) {
      throw new Error("the console reading was asked for before the hook filled it in");
    }
    return this.#reading;
  }

  public read(): void {
    const modules = consoleSourceModules({ roots: DESKTOP_PROSE_ROOTS, tests: true });
    this.#reading = {
      displayPaths: modules.map((module) => module.displayPath),
      stranded: modules
        .flatMap((module) =>
          strandedDocumentationIn(module.displayPath, readConsoleSourceModule(module)),
        )
        .map(describeStranded),
    };
  }
}

describe("documentation — one block per declaration", () => {
  const census = new DocumentationCensus();

  beforeAll(() => {
    census.read();
  });

  it("reaches every home the defect has, not the console alone", () => {
    // Without this a wrong root would scan nothing and the claim below would pass
    // over the empty set — and, since this gate was narrowed to the console once
    // already, each named class is a separate way for it to narrow back with
    // nothing reporting the difference. `.test-support.*` is called out because it
    // is where a block is most often copied along with the helper it describes, and
    // it is subtracted by the walk's own default rather than by the roots.
    const { displayPaths } = census.reading;
    expect(displayPaths.length).toBeGreaterThan(400);
    expect(displayPaths).toContain("src/main/window-reveal.ts");
    expect(displayPaths.filter((path) => path.startsWith("test/console/"))).not.toStrictEqual([]);
    expect(displayPaths.filter((path) => path.includes(".test-support."))).not.toStrictEqual([]);
    expect(displayPaths.filter((path) => path.endsWith(".test.ts"))).not.toStrictEqual([]);
    // Named the long way here, and deliberately: reached through the package-wide
    // roots a console module is `src/renderer/src/console/…` rather than the
    // `console/…` every console-scoped gate spells, which is the one cost of leaving
    // those gates' own lookups alone.
    expect(
      displayPaths.filter((path) => path.startsWith("src/renderer/src/console/")),
    ).not.toStrictEqual([]);
  });

  it("no declaration carries a stray documentation block, in either shape", () => {
    expect(census.reading.stranded).toStrictEqual([]);
  });

  it("negative control: the reader reports a stack and passes every way of not being one", () => {
    // Without this, a reader that resolved no comment ranges at all — a wrong
    // position, a filter that never matched — would make the claim above pass over
    // any tree, which is the failure this class of gate is most prone to.
    const stacked = [
      'import { a } from "./a.js";',
      "/** The first block, stranded by an edit. */",
      "/** The block that belongs to the declaration. */",
      "export const value = 1;",
    ].join("\n");
    expect(strandedDocumentationIn("stacked.ts", stacked)).toStrictEqual([
      { displayPath: "stacked.ts", line: 4, cause: "stacked", blockCount: 2 },
    ]);

    const notStacked = [
      "/** A module header written as a block, on the first statement. */",
      "/** The first declaration's own block. */",
      'import { a } from "./a.js";',
      "/** One block, and a line comment is not documentation. */",
      "// An aside.",
      "export const one = a;",
      "/** One block above, and a plain block comment is not documentation. */",
      "/* An aside. */",
      "export const two = 2;",
      "/** One block, and the next declaration has its own. */",
      "export const three = 3;",
      "/** Its own. */",
      "export const four = 4;",
    ].join("\n");
    expect(strandedDocumentationIn("not-stacked.ts", notStacked)).toStrictEqual([]);
  });

  it("negative control: a block inside the modifiers is reported, on every declaration form", () => {
    // The shape the leading-range reader cannot see at all: the parser resolves ZERO
    // leading ranges for these statements and attaches no JSDoc node, so before this
    // both halves of the gate agreed the declaration was undocumented and no block
    // existed. Every form a family writes is here, because the modifier list differs
    // per form and a reader keyed on one of them would miss the rest.
    const detached = [
      "/** The module header. */",
      'import { a } from "./a.js";',
      "export /** Documents nothing. */ interface Shape {",
      "  readonly a: typeof a;",
      "}",
      "export /** Documents nothing. */ const value = 1;",
      "export /** Documents nothing. */ function build(): number {",
      "  return value;",
      "}",
      "export /** Documents nothing. */ class Holder {}",
      "export /** Documents nothing. */ type Alias = Shape;",
      "export default /** Documents nothing. */ class Other {}",
    ].join("\n");

    expect(
      strandedDocumentationIn("detached.ts", detached).map((entry) => entry.line),
    ).toStrictEqual([3, 6, 7, 10, 11, 12]);
    expect(
      new Set(strandedDocumentationIn("detached.ts", detached).map((entry) => entry.cause)),
    ).toStrictEqual(new Set(["detached"]));

    // And the shapes that are NOT it: the ordinary place a block goes, and a comment
    // in the modifiers that is not documentation.
    const attached = [
      "/** The module header. */",
      'import { a } from "./a.js";',
      "/** Documents the declaration under it. */",
      "export interface Shape {",
      "  readonly a: typeof a;",
      "}",
      "export /* an aside, not documentation */ const value = 1;",
      "export // an aside, not documentation",
      "function build(): number {",
      "  return value;",
      "}",
    ].join("\n");
    expect(strandedDocumentationIn("attached.ts", attached)).toStrictEqual([]);
  });
});
