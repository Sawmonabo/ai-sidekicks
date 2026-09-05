// The family's closed sets are declared once, and no module writes a second copy.
//
// WHY A WALK AND NOT A REVIEW HABIT. Every other closed set this family speaks is an
// `[…] as const` with a derived type — the replay states, speeds and granularities, the
// rail tones, the reveal states, the reading modes, the chapter lifecycles, the error
// kinds, the card layouts, the ANSI decorations, the machine-body kinds, the geometry
// causes. The find walk's directions were the exception: the same two literals were
// written inline in six modules across two directories, so adding a third direction
// meant editing ten declarations with nothing to report a missed one, while every
// declared set in the list above would have failed to compile at the consumer instead.
//
// WHY THE PARSER AND NOT A TEXT SCAN. The question is which UNION TYPES this family
// declares, and a needle over the text answers a different one: it reads the same two
// words inside a comment, inside a string, and inside a doc block that quotes the rule.
// The tier owns a parse for exactly this reason and it is used here rather than copied.
//
// WHY THE SET COMES FROM THE DECLARATION. The claim is "nobody restates THIS set", so
// the members are read off `FIND_STEP_DIRECTIONS` itself. A hand-written pair here
// would be the eleventh copy, and it would stop covering the set the day the set grew.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { FIND_STEP_DIRECTIONS } from "./structure/narrowing/find-model.js";

/**
 * Every module this family holds, as source text.
 *
 * `node:fs` is banned in renderer programs (`Spec-023 §Trust Stance`), so the text
 * arrives inlined at transform time through Vite's raw glob — the form `panes.test.ts`
 * and `families.test.ts` take for their own source reads. Vite resolves a glob against
 * every module but the importer, so this suite is outside its own reading.
 */
const familyModules = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

/**
 * Parse one of this family's modules, deriving the script kind from its name.
 *
 * WHY NOT THE TIER'S SHARED PARSE. `test/console/typescript-source.ts` is where this
 * corpus keeps its one `createSourceFile`, and this walk would hold it — but the
 * renderer program's `rootDir` is `apps/desktop/src`, so a co-located console suite
 * that imports it fails `tsc` with TS6059 before a single case runs. Moving that module
 * or widening that root is a change to the shared tiers rather than to this family, so
 * the four arguments are restated here and the move is recorded as a substrate request.
 *
 * THE SCRIPT KIND IS DERIVED RATHER THAN ASKED FOR, for that module's reason: parsed as
 * `TS`, a `.tsx` module's opening tag reads as a comparison, and half this family would
 * be walked as something it is not.
 */
function parseFamilyModule(fileName: string, sourceText: string): ts.SourceFile {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, scriptKind);
}

/** Visit every node under `node`, depth first, excluding `node` itself. */
function forEachDescendant(node: ts.Node, visit: (descendant: ts.Node) => void): void {
  node.forEachChild((child) => {
    visit(child);
    forEachDescendant(child, visit);
  });
}

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
  const parsed = parseFamilyModule(fileName, sourceText);
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

describe("the ledger's declared sets — the find walk's directions", () => {
  it("reads the family's own modules", () => {
    // Without a floor, a glob that stopped matching would leave every claim below
    // passing over an empty set.
    expect(Object.keys(familyModules).length).toBeGreaterThan(100);
  });

  it("is written once, and no module under this family restates it", () => {
    const restatements = Object.entries(familyModules).flatMap(([fileName, sourceText]) =>
      directionUnionPositions(fileName, sourceText),
    );
    expect(restatements).toStrictEqual([]);
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
