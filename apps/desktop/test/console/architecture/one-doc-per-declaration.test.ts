// One documentation block per declaration, and it has to be attached to one — asked of
// every hand-written module in the package.
//
// THE READING IS NEXT DOOR. `stranded-documentation.ts` owns the three shapes, the
// positions each is asked at, and why every one of them is a question for the parser
// rather than for a pattern. What lives HERE is the scan: which roots it covers, what
// one pass of it costs, and the controls that show the reading discriminates.
//
// SCANNED PACKAGE-WIDE, because no arm of the defect is a console phenomenon. An
// insertion under a block and a copied block both land wherever someone is editing:
// `src/main/`, a co-located test, and above all a `.test-support.*` module, which is
// the one place a block is routinely copied along WITH the declaration it describes.
// This gate read the console's non-test modules for its first life and reported clean
// while the two largest homes of its own defect went unread — and the tests it did not
// read outnumber the modules it did. `DESKTOP_PROSE_ROOTS` with `{ tests: true }` is
// what reaches all of it, and the case below asserts each class the narrower scan
// missed rather than trusting a single count.
//
// THE CONTROLS DRIVE THE REAL READING over corpora written by hand, which is what the
// split buys: the predicates take source text, so a case can hold a fixture whose
// verdict is known, and the walk that produces the real module set stays here where
// `source-walk-chokepoint.test.ts` can see it.

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  DESKTOP_PROSE_ROOTS,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import {
  describeStranded,
  statementPositionsOnly,
  strandedDocumentationIn,
} from "./stranded-documentation.js";

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

  it("negative control: a stack on a MEMBER is reported, and the statement walk missed it", () => {
    // The shape the statements-only walk could not see at all. Every member position
    // a family writes is here — an interface member, a member of a type literal
    // nested inside another member's own type, a class member, and an enum member —
    // because the container kinds differ and a reader keyed on one of them would
    // miss the rest. The second assertion is the foil: the reading this gate
    // performed before it walked members answers NOTHING over the same text, which
    // is what makes the widening the claim rather than the fixture.
    const members = [
      "/** The module header. */",
      "export interface Shape {",
      "  /** The first block, stranded by an edit. */",
      "  /** The block that belongs to the member. */",
      "  readonly first: string;",
      "  readonly nested: {",
      "    /** Stranded inside a type literal nested in a member's own type. */",
      "    /** The block that belongs to it. */",
      "    readonly deep: number;",
      "  };",
      "}",
      "export class Holder {",
      "  /** Stranded on a class member. */",
      "  /** The block that belongs to it. */",
      "  public readonly held: number = 1;",
      "}",
      "export enum Kind {",
      "  /** Stranded on an enum member. */",
      "  /** The block that belongs to it. */",
      "  One = 1,",
      "}",
    ].join("\n");

    expect(strandedDocumentationIn("members.ts", members)).toStrictEqual([
      { displayPath: "members.ts", line: 5, cause: "stacked", blockCount: 2 },
      { displayPath: "members.ts", line: 9, cause: "stacked", blockCount: 2 },
      { displayPath: "members.ts", line: 15, cause: "stacked", blockCount: 2 },
      { displayPath: "members.ts", line: 20, cause: "stacked", blockCount: 2 },
    ]);
    expect(statementPositionsOnly("members.ts", members)).toStrictEqual([]);
  });

  it("negative control: the ordinary member shapes are not offences", () => {
    // Without this the case above would also be satisfied by a walk that reported
    // every member with any documentation at all. The first member of a container is
    // included deliberately: it gets no header exemption, and one block on it is
    // still one block. A member's detached shape is here too, since `readonly` is a
    // modifier and a block after it documents nothing.
    const attachedMembers = [
      "/** The module header. */",
      "export interface Shape {",
      "  /** One block on the first member. */",
      "  readonly first: string;",
      "  /** One block, and a line comment is not documentation. */",
      "  // An aside.",
      "  readonly second: string;",
      "  readonly third: { readonly deep: number };",
      "}",
    ].join("\n");
    expect(strandedDocumentationIn("attached-members.ts", attachedMembers)).toStrictEqual([]);

    const detachedMember = [
      "/** The module header. */",
      "export interface Shape {",
      "  readonly /** Documents nothing. */ first: string;",
      "}",
    ].join("\n");
    expect(strandedDocumentationIn("detached-member.ts", detachedMember)).toStrictEqual([
      { displayPath: "detached-member.ts", line: 3, cause: "detached", blockCount: 1 },
    ]);
  });
});
