// Every owner-slot contract in the tree, and the one thing none of them may carry.
//
// WHY THIS FILE EXISTS. An `OwnerSlotContract` is prose a developer reads: which plan
// owns the seat, what the host supplies, and which PR deletes the shell. It is also
// three RUNTIME STRINGS sitting in a shipped module, and the repository's rule is
// that governance identifiers live in comments and never in those — a participant who
// meets one is reading the build's internal bookkeeping, and a string that names a
// plan is a string somebody will eventually render because it reads like a label.
//
// The claim had been asserted where the seats are rendered, over a HAND LIST of the
// four contracts that one unit mounts. A hand list is the wrong instrument for a
// claim about every declaration: the two contracts outside that file were unswept,
// and one of them carries a plan id under a doc comment that says it does not. So the
// sweep moves here, where it can be exhaustive, and the rendering claim stays beside
// the render, which is the only place it can be made.
//
// A PARSER, NOT A PATTERN. "Which declarations are a seat contract" is a question about
// the tree. A pattern over the text answers it wrongly at the first nested literal, and
// — worse for this claim — would read the doc comment above a declaration as part of it,
// so a comment correctly naming the owning plan would fail the gate while the string
// beneath it passed. `typescript-source.ts` holds the parse the two sibling gates
// already use.
//
// BOTH ANNOTATIONS, BECAUSE ONE OF THEM SWEEPS ALMOST NOTHING. A seat is written two
// ways: a bare `OwnerSlotContract` where the mounting component takes the body as its
// own prop, and an `OwnerSlotProps<Body>` where the contract and the body travel
// together as one constant — which is what every seat that carries a fixture body is.
// A gate reading only the first annotation resolved the five workflow declarations and
// the input-ask card and swept none of the four seats that pair a contract with a body,
// which is where a plan id had actually reached a runtime string. So the resolver reads
// the nested `contract` member too, and an `OwnerSlotProps` whose contract it cannot
// resolve is reported with no members rather than skipped — the completeness case then
// fails on it, which is the opposite of the false green a skip would produce.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The annotation whose initializer IS a contract. */
const CONTRACT_TYPE_NAME = "OwnerSlotContract";

/** The annotation that carries one inside its `contract` member, beside a body. */
const SLOT_PROPS_TYPE_NAME = "OwnerSlotProps";

/** The member of an `OwnerSlotProps` literal that holds the contract. */
const CONTRACT_MEMBER_NAME = "contract";

/** The three facts the type requires, so a partial literal is a red check. */
const CONTRACT_MEMBERS: readonly string[] = ["owningTask", "mountObligation", "deleteShellIn"];

/**
 * The identifier shapes that belong in comments and never in a runtime string.
 *
 * The repository's own prefixes, each followed by a digit so ordinary prose survives:
 * "the workflow orchestration plan's picker" is what these members are supposed to
 * read like, and only `Plan-013` and its siblings are the thing being kept out.
 */
const GOVERNANCE_ID = /\b(?:Spec|Plan|ADR|BL|CP|I|T)-\d/;

/**
 * The floor this gate holds itself to.
 *
 * Ten contracts are declared today, re-derived by counting both annotations: six named
 * `OwnerSlotContract` outright — the five workflow bodies and the input-ask card — and
 * four reached through an `OwnerSlotProps` literal's `contract` member: the two settings
 * owner-slot pages and the two sidekick-definition editors. Asserting the count is at
 * least that many is what keeps a broken resolver from reporting a clean sweep over
 * nothing — the same false green every source-text gate in this directory guards
 * against, and the reason the number is a floor rather than a pin: an eleventh seat is
 * ordinary growth.
 */
const MINIMUM_DECLARED_CONTRACTS = 10;

/** One contract literal, resolved to the strings it actually declares. */
interface DeclaredContract {
  readonly module: string;
  readonly name: string;
  readonly members: ReadonlyMap<string, string>;
}

/**
 * The string a property initializer is, or `undefined` where it is not a literal one.
 *
 * Only the two literal forms are read. A member composed at runtime is not a member
 * this gate can rule on, and reporting one as clean would be the false green above; it
 * is reported as unresolved instead, and the case below fails on it.
 */
function literalStringOf(initializer: ts.Expression): string | undefined {
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
    return initializer.text;
  }
  return undefined;
}

/**
 * Every `const NAME = { … }` object literal in one module, keyed by its name.
 *
 * Collected because a contract may be COMPOSED — a shared constant holding the two
 * members every seat in a family answers the same way, spread into each declaration
 * beside the one member that differs. Without this the spread members are invisible:
 * the completeness case reads them as absent and the governance-id case, which is the
 * one that matters, sweeps a literal that carries none of the strings it is about. A
 * composed contract was exactly how a plan id first reached a runtime string here.
 *
 * ONE LEVEL AND ONE MODULE. A spread of anything else — an import, a call, a nested
 * spread — is left unresolved rather than guessed at, so the completeness case fails
 * on it and this gate never reports clean over a literal it could not read.
 */
function objectLiteralsIn(parsed: ts.SourceFile): ReadonlyMap<string, ts.ObjectLiteralExpression> {
  const literals = new Map<string, ts.ObjectLiteralExpression>();
  forEachDescendant(parsed, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer) &&
      ts.isIdentifier(node.name)
    ) {
      literals.set(node.name.text, node.initializer);
    }
  });
  return literals;
}

/**
 * The string members one literal declares, with a same-module spread folded in first.
 *
 * Spread first and assignments after, which is the order the language itself applies,
 * so a declaration that overrides a shared member is read the way it runs.
 */
function stringMembersOf(
  literal: ts.ObjectLiteralExpression,
  parsed: ts.SourceFile,
  literalsByName: ReadonlyMap<string, ts.ObjectLiteralExpression>,
): ReadonlyMap<string, string> {
  const members = new Map<string, string>();
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      const spread = literalsByName.get(property.expression.text);
      if (spread !== undefined) {
        for (const [member, value] of stringMembersOf(spread, parsed, literalsByName)) {
          members.set(member, value);
        }
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const value = literalStringOf(property.initializer);
    if (value !== undefined) {
      members.set(property.name.getText(parsed), value);
    }
  }
  return members;
}

/**
 * The `contract` member of an `OwnerSlotProps` literal, as a literal of its own.
 *
 * The member is written inline on every seat in the tree today, and an identifier
 * naming a same-module literal is resolved too so the shared-constant shape the
 * workflow family uses stays available to a paired seat. Anything else is unresolved,
 * and the caller reports the declaration with no members rather than dropping it.
 */
function contractLiteralOf(
  slotLiteral: ts.ObjectLiteralExpression,
  parsed: ts.SourceFile,
  literalsByName: ReadonlyMap<string, ts.ObjectLiteralExpression>,
): ts.ObjectLiteralExpression | undefined {
  for (const property of slotLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (property.name.getText(parsed) !== CONTRACT_MEMBER_NAME) {
      continue;
    }
    if (ts.isObjectLiteralExpression(property.initializer)) {
      return property.initializer;
    }
    if (ts.isIdentifier(property.initializer)) {
      return literalsByName.get(property.initializer.text);
    }
    return undefined;
  }
  return undefined;
}

function declaredContractsIn(module: string, sourceText: string): readonly DeclaredContract[] {
  const parsed = parseSourceText(module, sourceText);
  const literalsByName = objectLiteralsIn(parsed);
  const found: DeclaredContract[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) {
      return;
    }
    const annotation = node.type;
    if (annotation === undefined || !ts.isTypeReferenceNode(annotation)) {
      return;
    }
    const annotationName = annotation.typeName.getText(parsed);
    if (annotationName !== CONTRACT_TYPE_NAME && annotationName !== SLOT_PROPS_TYPE_NAME) {
      return;
    }
    if (!ts.isObjectLiteralExpression(node.initializer)) {
      return;
    }
    const literal =
      annotationName === CONTRACT_TYPE_NAME
        ? node.initializer
        : contractLiteralOf(node.initializer, parsed, literalsByName);
    found.push({
      module,
      name: node.name.getText(parsed),
      members:
        literal === undefined
          ? new Map<string, string>()
          : stringMembersOf(literal, parsed, literalsByName),
    });
  });
  return found;
}

const DECLARED_CONTRACTS: readonly DeclaredContract[] = consoleSourceModules().flatMap((module) =>
  declaredContractsIn(module.displayPath, readConsoleSourceModule(module)),
);

describe("owner-slot contracts — developer prose, and no governance id in any of it", () => {
  it("resolves every declaration in the tree, and finds more than none", () => {
    expect(DECLARED_CONTRACTS.length).toBeGreaterThanOrEqual(MINIMUM_DECLARED_CONTRACTS);
  });

  it("answers all three facts on every one of them", () => {
    const incomplete = DECLARED_CONTRACTS.filter((contract) =>
      CONTRACT_MEMBERS.some((member) => (contract.members.get(member) ?? "").length === 0),
    ).map((contract) => `${contract.module}: ${contract.name}`);
    expect(incomplete).toStrictEqual([]);
  });

  it("carries no governance identifier in any member's runtime string", () => {
    const offenders = DECLARED_CONTRACTS.flatMap((contract) =>
      [...contract.members]
        .filter(([, value]) => GOVERNANCE_ID.test(value))
        .map(([member]) => `${contract.module}: ${contract.name}.${member}`),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("planted control: a composed contract's spread members are swept, not skipped", () => {
    // The half the tree cannot prove on its own once every declaration is clean. A
    // literal built from a shared constant reads as three absent members to a walker
    // that stops at property assignments — so both cases above would pass over it, and
    // the id in the shared half would never be reported. Driven through the real
    // resolver with a composed source whose verdict is known.
    const composed = [
      "const SHARED: Pick<OwnerSlotContract, 'owningTask' | 'deleteShellIn'> = {",
      "  owningTask: 'Plan-017 — the workflow engine bodies',",
      "  deleteShellIn: 'the task that mounts the body',",
      "};",
      "export const COMPOSED_SLOT: OwnerSlotContract = {",
      "  ...SHARED,",
      "  mountObligation: 'the pane supplies the context and reads back nothing',",
      "};",
    ].join("\n");

    const resolved = declaredContractsIn("composed.ts", composed);

    expect(resolved).toHaveLength(1);
    const members = resolved[0]?.members;
    for (const member of CONTRACT_MEMBERS) {
      expect(members?.get(member) ?? "", `${member} was not resolved`).not.toBe("");
    }
    expect(GOVERNANCE_ID.test(members?.get("owningTask") ?? "")).toBe(true);
  });

  it("planted control: a paired seat's nested contract is swept, not skipped", () => {
    // The other half the tree cannot prove once every declaration is clean, and the one
    // that was actually broken: a seat whose contract travels beside a body was invisible
    // to a resolver reading only the outer annotation, so both cases above passed over
    // four real declarations. Driven through the real resolver with a paired source whose
    // verdict is known.
    const paired = [
      "export const PAIRED_SLOT: OwnerSlotProps<PageBody> = {",
      "  contract: {",
      "    owningTask: 'Plan-030 (mounted through CP-023-6)',",
      "    mountObligation: 'a bounded region and the subject, and nothing else',",
      "    deleteShellIn: 'the editor task that fills this slot',",
      "  },",
      "  body: undefined,",
      "};",
    ].join("\n");

    const resolved = declaredContractsIn("paired.ts", paired);

    expect(resolved).toHaveLength(1);
    const members = resolved[0]?.members;
    for (const member of CONTRACT_MEMBERS) {
      expect(members?.get(member) ?? "", `${member} was not resolved`).not.toBe("");
    }
    expect(GOVERNANCE_ID.test(members?.get("owningTask") ?? "")).toBe(true);
  });

  it("planted control: a paired seat whose contract cannot be read fails rather than passes", () => {
    // The disposition that decides whether an unreadable literal is a false green. A
    // contract composed at runtime resolves to no members, which is what the
    // completeness case fails on — so the gate reports what it could not read instead of
    // reporting it clean.
    const opaque = [
      "export const OPAQUE_SLOT: OwnerSlotProps<PageBody> = {",
      "  contract: contractFor('accounts'),",
      "  body: undefined,",
      "};",
    ].join("\n");

    const resolved = declaredContractsIn("opaque.ts", opaque);

    expect(resolved).toHaveLength(1);
    expect([...(resolved[0]?.members ?? [])]).toStrictEqual([]);
  });

  it("negative control: the needle matches the shape it is looking for", () => {
    // Without this the case above passes over a needle that matches nothing, which is
    // the failure a pattern edit produces and no fixture would otherwise reveal.
    expect(GOVERNANCE_ID.test("Plan-013 — the timeline family's input-ask card")).toBe(true);
    expect(GOVERNANCE_ID.test("the usage-meters plan's context-window meter")).toBe(false);
  });
});
