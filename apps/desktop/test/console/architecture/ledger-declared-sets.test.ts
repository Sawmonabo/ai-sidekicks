// The ledger family's closed sets are declared once, and no module writes a second copy.
//
// WHY A WALK AND NOT A REVIEW HABIT. Every other closed set that family speaks is an
// `[…] as const` with a derived type — the replay states, speeds and granularities, the
// rail tones, the reveal states, the reading modes, the chapter lifecycles, the error
// kinds, the card layouts, the ANSI decorations, the machine-body kinds, the geometry
// causes. The find walk's directions were the exception: the same two literals were
// written inline in six modules across two directories, so adding a third direction
// meant editing ten declarations with nothing to report a missed one, while every
// declared set in the list above would have failed to compile at the consumer instead.
//
// WHY THE PARSER AND NOT A TEXT SCAN. The question is which UNION TYPES that family
// declares, and a needle over the text answers a different one: it reads the same two
// words inside a comment, inside a string, and inside a doc block that quotes the rule.
//
// WHY IT LIVES IN THIS TIER. It was co-located under `ledger/`, where it restated the
// four arguments of `createSourceFile` because the renderer program's `rootDir` is
// `apps/desktop/src` and a co-located suite importing `test/console/typescript-source.js`
// is TS6059. That module recorded the move as owed; `source-parse-home.test.ts` beside
// this file now refuses the co-located shape outright, so the walk is here and reads
// through the tier's own parse and its one module census rather than through a second
// `import.meta.glob` and a second set of parse options.
//
// WHY THE SET COMES FROM THE DECLARATION. The claim is "nobody restates THIS set", so
// the members are read off `FIND_STEP_DIRECTIONS` itself. A hand-written pair here
// would be the eleventh copy, and it would stop covering the set the day the set grew.

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { FIND_STEP_DIRECTIONS } from "../../../src/renderer/src/console/ledger/structure/narrowing/find-model.js";

/** The family this claim is about, as a display-path prefix. */
const LEDGER_FAMILY_PREFIX = "console/ledger/";

/** Tests included: a restatement in a suite is a restatement a reader has to keep true. */
const LEDGER_FAMILY_SCAN = { roots: [CONSOLE_DIRECTORY], tests: true } as const;

/** The members of a union type, where every one of them is a string literal. */
function stringLiteralUnionMembers(node: ts.Node): readonly string[] | undefined {
  if (!ts.isUnionTypeNode(node)) {
    return undefined;
  }
  const members: string[] = [];
  for (const member of node.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      return undefined;
    }
    members.push(member.literal.text);
  }
  return members;
}

/**
 * Whether a union restates the declared direction set, in any order.
 *
 * ORDER-BLIND ON PURPOSE: `"previous" | "next"` is the same restatement written the
 * other way round, and a claim that only caught one spelling would be a claim a
 * formatter could defeat.
 */
function restatesFindDirections(members: readonly string[]): boolean {
  const declared = new Set<string>(FIND_STEP_DIRECTIONS);
  return members.length === declared.size && members.every((member) => declared.has(member));
}

/** Every position in one module's source where the direction set is written out. */
function directionUnionPositions(fileName: string, sourceText: string): readonly string[] {
  const parsed = parseSourceText(fileName, sourceText);
  const positions: string[] = [];
  forEachDescendant(parsed, (node) => {
    const members = stringLiteralUnionMembers(node);
    if (members !== undefined && restatesFindDirections(members)) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      positions.push(`${fileName}:${line + 1}`);
    }
  });
  return positions;
}

/**
 * The family's modules, read once for the file.
 *
 * Hoisted rather than walked per case, on this tier's standing rule: three cases ask
 * the same question and a per-case walk would open every file three times.
 */
class LedgerFamilyCensus {
  #modules: readonly ConsoleSourceModule[] = [];

  public read(): void {
    this.#modules = consoleSourceModules(LEDGER_FAMILY_SCAN).filter((module) =>
      module.displayPath.startsWith(LEDGER_FAMILY_PREFIX),
    );
  }

  public get modules(): readonly ConsoleSourceModule[] {
    return this.#modules;
  }

  /** Every position across the family where the set is restated. */
  public restatements(): readonly string[] {
    return this.#modules.flatMap((module) =>
      directionUnionPositions(module.displayPath, readConsoleSourceModule(module)),
    );
  }
}

describe("the ledger's declared sets — the find walk's directions", () => {
  const census = new LedgerFamilyCensus();

  beforeAll(() => {
    census.read();
  });

  it("reads the family's own modules", () => {
    // Without a floor, a prefix that stopped matching would leave every claim below
    // passing over an empty set.
    expect(census.modules.length).toBeGreaterThan(100);
  });

  it("is written once, and no module under this family restates it", () => {
    expect(census.restatements()).toStrictEqual([]);
  });

  it("negative control: a planted restatement is found, in either order", () => {
    // Without this the claim above would pass over a walk that found nothing because
    // it looked for nothing. Both orderings are planted, because the order-blind
    // comparison is the part a narrower reading would get wrong.
    const planted = [
      'export type Step = "next" | "previous";',
      'declare function walk(direction: "previous" | "next"): void;',
      '// A comment saying next | previous, and a string "next" | "previous" beside it.',
      'const label: string = ["next", "previous"].join(" ");',
    ].join("\n");
    expect(directionUnionPositions("planted.ts", planted)).toStrictEqual([
      "planted.ts:1",
      "planted.ts:2",
    ]);
  });
});
