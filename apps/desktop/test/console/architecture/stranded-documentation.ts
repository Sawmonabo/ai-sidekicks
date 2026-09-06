// The reading the one-block-per-declaration gate next door runs: which declarations
// carry documentation that does not describe them.
//
// A MODEL BESIDE ITS GATE, on the `windowed-row-census.ts` and `barrel-census.ts`
// pattern. The predicates take source text as a parameter, so the gate's controls can
// drive the real reading with corpora written by hand to fail; the walk that produces
// the real module set stays in the gate, where `source-walk-chokepoint.test.ts` can
// see it.
//
// THREE SHAPES, and each is invisible to the instrument the one before it needs.
//
// STACKED is more than one leading block. A JSDoc block belongs to the declaration
// under it and TypeScript attaches EVERY leading block to that declaration, so two
// stacked blocks are not two comments — the upper one has silently changed what it
// documents, and its subject is whatever the editor moved in underneath it. Nothing
// reports that: the compiler is content, the linter is content, and the block still
// reads correctly on its own, which is exactly why it survives review. It arrives two
// ways, both edits rather than authorship — a declaration inserted between a block and
// what it described, or a block copied along with its declaration onto one that
// already had one.
//
// DETACHED is a block written INSIDE the modifiers — between `export` and the
// declaration keyword, or between `readonly` and a member's name — and it documents
// nothing at all: the parser attaches no JSDoc node and resolves zero LEADING ranges
// for the declaration, so a reader taking only the declaration's own start reports it
// as undocumented and the block as absent, both wrongly and both silently. Every
// editor still renders the sentence, which is why the shape survives review; one
// family branch carries seventeen of them.
//
// AND BOTH ARE ASKED AT EVERY NESTED POSITION, not at statements alone.
// `sourceFile.statements` is the top level and nothing under it, so a block stacked on
// an interface member, a type-literal member, a class member or an enum member sat
// outside the claim entirely — and a member is where the copied-with-its-declaration
// shape lands most, because a member and the sentence above it are one thing to copy.
//
// Four more positions carry documentation in this package and are asked here for the
// same reason. An EXPORT or IMPORT SPECIFIER is where the console concentrates its
// JSDoc: `apps/desktop/AGENTS.md` §Module shape makes the `@consumedBy` claim ride the
// barrel's own specifier, because that is the export knip reports, so a door line is a
// documented declaration and a stacked pair there is the shape a merge of two doors
// produces. An object literal's PROPERTY ASSIGNMENT is a documented declaration
// wherever a table of rows is written as one. And a `declare global` or `declare
// module` body holds STATEMENTS a top-level walk never reaches, none of which is a
// module header — nothing makes a block written inside a brace one.
//
// THE FIRST STATEMENT IS EXEMPT FROM THE STACKED SHAPE, and the exemption is
// structural rather than a grandfather clause: a module whose header is written as a
// block comment is a leading block on whatever statement comes first, and a header
// describing the module is not a second description of that statement. Every later
// statement has no such excuse, and neither has any member — nothing makes a block
// written inside a brace a module header.
//
// READ BY PARSE RATHER THAN BY REGEX. Whether two blocks are stacked is a question
// about what the parser ATTACHES — a blank line, an intervening statement, or a line
// comment between them all change the answer, and none of those is visible to a
// pattern matching `*/` followed by `/**`. The detached shape is the same question
// asked at a different position, and a pattern cannot ask it at all.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** One declaration whose documentation is wrong, and which of the two ways it is. */
export interface StrandedDocumentation {
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

/**
 * The width of `/**\/`, the one block that opens a JSDoc and documents nothing.
 *
 * Four characters, and the two stars are the same star: an empty block comment opens
 * with `/*` and closes with `*\/` sharing it, so a prefix test alone reads it as a
 * documentation block. Any real block is wider — `/***\/` already is — so the width
 * separates the two without a second reading of the text.
 */
const EMPTY_BLOCK_COMMENT_WIDTH = 4;

/**
 * How many of `ranges` open a JSDoc rather than a line or a plain block comment.
 *
 * AN EMPTY BLOCK IS NOT DOCUMENTATION, and the prefix test alone says it is: `/**\/`
 * starts with `/**` because its closing star is its second one. Counting it would
 * report a real JSDoc under one as a declaration carrying two blocks — a false
 * positive on a gate whose whole value is that its report is trustworthy.
 */
function countDocumentation(
  source: string,
  ranges: readonly ts.CommentRange[] | undefined,
): number {
  return (ranges ?? []).filter(
    (range) =>
      source.startsWith("/**", range.pos) && range.end - range.pos > EMPTY_BLOCK_COMMENT_WIDTH,
  ).length;
}

/** One position a documentation block can lead, and whether a header excuses one there. */
interface DeclarationSite {
  readonly node: ts.Node;
  /** True for a module's first statement alone — see {@link statementDeclarationSites}. */
  readonly exemptFromStacked: boolean;
}

/** A declaration whose MEMBERS are documented positions in their own right. */
type MemberContainer =
  | ts.ClassDeclaration
  | ts.ClassExpression
  | ts.EnumDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeLiteralNode;

/**
 * Whether `node` holds members of that kind.
 *
 * The five containers this tree writes, and the anonymous one is why the walk below
 * recurses rather than reading a statement's own members: a type literal is a TYPE,
 * so it appears inside another member's annotation, inside a type alias, inside a
 * signature's parameter and return positions — anywhere a type may be written, at any
 * depth. A reader that took the members off the statement would see the outer
 * interface and none of those.
 */
function isMemberContainer(node: ts.Node): node is MemberContainer {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeLiteralNode(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isEnumDeclaration(node)
  );
}

/**
 * The positions `node` holds that a documentation block can lead in its own right.
 *
 * ASKED PER CONTAINER KIND rather than per child, because the child list is what
 * differs: members hang off `members`, a named clause off `elements`, an object
 * literal off `properties`, and an ambient body off `statements`. A walk that took
 * every child of every node would report the annotation, the initialiser and the
 * argument list as documented positions, and none of those is a declaration.
 */
function documentedChildrenOf(node: ts.Node): readonly ts.Node[] {
  if (isMemberContainer(node)) {
    return node.members;
  }
  if (ts.isNamedExports(node) || ts.isNamedImports(node)) {
    return node.elements;
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties;
  }
  if (ts.isModuleBlock(node)) {
    return node.statements;
  }
  return [];
}

/**
 * The top-level statements — every position this gate read before it walked members.
 *
 * Its own function because the control below drives it as the FOIL: the reading this
 * gate performed while a member-position stack was outside its claim. A foil that
 * restated the per-declaration check would prove the restatement rather than the
 * widening, so it is the real site set minus the members and nothing else.
 */
function statementDeclarationSites(sourceFile: ts.SourceFile): readonly DeclarationSite[] {
  return sourceFile.statements.map((statement, index) => ({
    node: statement,
    exemptFromStacked: index === 0,
  }));
}

/**
 * Every nested position under `node`, itself included, none of them exempt.
 *
 * NONE EXEMPT, unlike the first statement: the exemption above is structural — a
 * module header written as a block leads whatever statement comes first — and there is
 * no analogue inside a brace. A container's own documentation sits ABOVE it, where the
 * statement reading already judges it, so the first member has no excuse the fourth
 * does not, and neither has the first specifier of a door or the first statement of an
 * ambient body.
 */
function nestedDeclarationSites(node: ts.Node): readonly DeclarationSite[] {
  const sites: DeclarationSite[] = [];
  const collect = (candidate: ts.Node): void => {
    for (const child of documentedChildrenOf(candidate)) {
      sites.push({ node: child, exemptFromStacked: false });
    }
  };
  collect(node);
  forEachDescendant(node, collect);
  return sites;
}

/** Every position in `sourceFile` a documentation block can lead, top level and nested. */
function declarationSites(sourceFile: ts.SourceFile): readonly DeclarationSite[] {
  return statementDeclarationSites(sourceFile).flatMap((site) => [
    site,
    ...nestedDeclarationSites(site.node),
  ]);
}

/**
 * Whether the documentation at one site describes what is under it, and how it fails.
 *
 * TWO SHAPES, and the second is invisible to the first's instrument. STACKED is more
 * than one leading block: the count comes from the comment ranges the parser resolves
 * for the declaration's own full start, filtered to blocks that open a JSDoc — a line
 * comment and a plain block comment are not documentation and do not participate.
 *
 * DETACHED is a block written INSIDE the modifiers, between `export` and the
 * declaration keyword — or between `readonly` and a member's name — and it documents
 * nothing at all: the parser attaches no JSDoc node to the declaration and resolves
 * zero leading ranges for it, so a gate reading only the declaration's own start
 * reports it as undocumented and the block as absent — both wrongly, and both
 * silently. Every editor and every reader still shows the sentence, which is why the
 * shape survives review. It is read from the last modifier's end, which is the one
 * position that trivia leads.
 */
function strandedDocumentationAt(
  displayPath: string,
  source: string,
  sourceFile: ts.SourceFile,
  site: DeclarationSite,
): readonly StrandedDocumentation[] {
  const found: StrandedDocumentation[] = [];
  const line = sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile)).line + 1;
  const stacked = site.exemptFromStacked
    ? 0
    : documentationBlocksAt(source, site.node.getFullStart());
  if (stacked > 1) {
    found.push({ displayPath, line, cause: "stacked", blockCount: stacked });
  }
  const modifiers = ts.canHaveModifiers(site.node) ? ts.getModifiers(site.node) : undefined;
  const lastModifier = modifiers?.at(-1);
  if (lastModifier === undefined) {
    return found;
  }
  const detached = documentationBlocksInModifiers(source, lastModifier.end);
  if (detached > 0) {
    found.push({ displayPath, line, cause: "detached", blockCount: detached });
  }
  return found;
}

/**
 * The reading over a site set, in source order.
 *
 * Sorted by line rather than left in walk order: a container's members are collected
 * after the statement that holds them, so a module reported in walk order would name
 * its lines out of sequence and read as two lists.
 */
function strandedDocumentationOver(
  displayPath: string,
  source: string,
  sourceFile: ts.SourceFile,
  sites: readonly DeclarationSite[],
): readonly StrandedDocumentation[] {
  return sites
    .flatMap((site) => strandedDocumentationAt(displayPath, source, sourceFile, site))
    .sort((left, right) => left.line - right.line);
}

/** Every declaration in `source` — statement or member — whose documentation is wrong. */
export function strandedDocumentationIn(
  displayPath: string,
  source: string,
): readonly StrandedDocumentation[] {
  const sourceFile = parseSourceText(displayPath, source);
  return strandedDocumentationOver(displayPath, source, sourceFile, declarationSites(sourceFile));
}

/**
 * What this gate reported while its walk was `sourceFile.statements` and nothing else.
 *
 * THE FOIL THE CONTROL DRIVES, and it is the old SITE SET rather than a second copy of
 * the rule: the per-declaration check it applies is the one above, so a control showing
 * this answering nothing where {@link strandedDocumentationIn} answers a hit is showing
 * the widening and not a paraphrase of it.
 */
export function statementPositionsOnly(
  displayPath: string,
  source: string,
): readonly StrandedDocumentation[] {
  const sourceFile = parseSourceText(displayPath, source);
  return strandedDocumentationOver(
    displayPath,
    source,
    sourceFile,
    statementDeclarationSites(sourceFile),
  );
}

/** How a failure names one: where it is, which shape, and how many blocks. */
export function describeStranded(entry: StrandedDocumentation): string {
  const blocks = `${String(entry.blockCount)} documentation block${entry.blockCount === 1 ? "" : "s"}`;
  return entry.cause === "stacked"
    ? `${entry.displayPath}:${String(entry.line)} carries ${blocks} on one declaration`
    : `${entry.displayPath}:${String(entry.line)} carries ${blocks} inside its own modifiers, where the parser attaches it to nothing`;
}
