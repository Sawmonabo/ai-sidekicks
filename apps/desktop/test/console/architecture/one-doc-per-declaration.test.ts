// One documentation block per declaration.
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
// THE FIRST STATEMENT IS EXEMPT, and the exemption is structural rather than a
// grandfather clause: a module whose header is written as a block comment is a
// leading block on whatever statement comes first, and a header describing the module
// is not a second description of that statement. Every later statement has no such
// excuse.
//
// Read by parse rather than by regex. Whether two blocks are stacked is a question
// about what the parser ATTACHES — a blank line, an intervening statement, or a line
// comment between them all change the answer, and none of those is visible to a
// pattern that matches `*/` followed by `/**`.

import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";

/** One declaration carrying more than one documentation block, as a failure names it. */
interface StackedDocumentation {
  readonly displayPath: string;
  readonly line: number;
  readonly blockCount: number;
}

/**
 * Every statement in `source` after the first that carries more than one JSDoc block.
 *
 * The count comes from the leading comment ranges the parser resolves for the
 * statement's own full start, filtered to blocks that open `/**` — a `//` line comment
 * and a plain `/* *\/` block are not documentation and do not participate.
 */
function stackedDocumentationIn(
  displayPath: string,
  source: string,
): readonly StackedDocumentation[] {
  const sourceFile = parseSourceText(displayPath, source);
  const found: StackedDocumentation[] = [];
  sourceFile.statements.forEach((statement, index) => {
    if (index === 0) {
      return;
    }
    const ranges = ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? [];
    const blockCount = ranges.filter((range) => source.startsWith("/**", range.pos)).length;
    if (blockCount > 1) {
      found.push({
        displayPath,
        line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
        blockCount,
      });
    }
  });
  return found;
}

/** How a failure names one stacked pair: where it is and how many blocks are on it. */
function describeStack(entry: StackedDocumentation): string {
  return `${entry.displayPath}:${String(entry.line)} carries ${String(entry.blockCount)} documentation blocks on one declaration`;
}

/**
 * The budgets this file states rather than inherits, and why they differ.
 *
 * One reading and parse of the console costs ~150 ms alone on the authoring machine
 * and multiplies under the gate's five-project concurrency — the load, not the tree,
 * is what a budget here has to survive, the same finding that put explicit budgets on
 * `barrel-census.test.ts`. The hook pays for the whole reading and is set well above
 * the loaded cost, because what a budget guards is a reading that never settles rather
 * than a slow one. The cases compare over a reading already in hand at 0-1 ms each, so
 * their budget is deliberately smaller: a case that somehow became the first to touch
 * the reading should fail fast and say so rather than inherit the hook's patience.
 */
const CONSOLE_READING_ALLOWANCE_MS = 30_000;
const COMPARISON_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: COMPARISON_ALLOWANCE_MS, hookTimeout: CONSOLE_READING_ALLOWANCE_MS });

/** What one reading of the tree answers. Every case below is a comparison over this. */
interface DocumentationReading {
  readonly moduleCount: number;
  readonly stacked: readonly string[];
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
    const modules = consoleSourceModules();
    this.#reading = {
      moduleCount: modules.length,
      stacked: modules
        .flatMap((module) =>
          stackedDocumentationIn(module.displayPath, readConsoleSourceModule(module)),
        )
        .map(describeStack),
    };
  }
}

describe("documentation — one block per declaration", () => {
  const census = new DocumentationCensus();

  beforeAll(() => {
    census.read();
  });

  it("finds a tree to scan at all", () => {
    // Without this a wrong root would scan nothing and the claim below would pass
    // over the empty set.
    expect(census.reading.moduleCount).toBeGreaterThan(50);
  });

  it("no declaration carries a second documentation block", () => {
    expect(census.reading.stacked).toStrictEqual([]);
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
    expect(stackedDocumentationIn("stacked.ts", stacked)).toStrictEqual([
      { displayPath: "stacked.ts", line: 4, blockCount: 2 },
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
    expect(stackedDocumentationIn("not-stacked.ts", notStacked)).toStrictEqual([]);
  });
});
