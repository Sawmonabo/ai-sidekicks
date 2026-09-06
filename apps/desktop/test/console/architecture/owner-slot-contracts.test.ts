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
// A PARSER, NOT A PATTERN. "Which declarations are annotated `OwnerSlotContract`" is a
// question about the tree. A pattern over the text answers it wrongly at the first
// nested literal, and — worse for this claim — would read the doc comment above a
// declaration as part of it, so a comment correctly naming the owning plan would fail
// the gate while the string beneath it passed. `typescript-source.ts` holds the parse
// the two sibling gates already use.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The annotation that makes a declaration one of these contracts. */
const CONTRACT_TYPE_NAME = "OwnerSlotContract";

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
 * Six contracts are declared today. Asserting the count is at least that many is what
 * keeps a broken resolver from reporting a clean sweep over nothing — the same false
 * green every source-text gate in this directory guards against, and the reason the
 * number is a floor rather than a pin: a seventh seat is ordinary growth.
 */
const MINIMUM_DECLARED_CONTRACTS = 6;

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

function declaredContractsIn(module: string, sourceText: string): readonly DeclaredContract[] {
  const parsed = parseSourceText(module, sourceText);
  const literalsByName = objectLiteralsIn(parsed);
  const found: DeclaredContract[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) {
      return;
    }
    const annotation = node.type;
    if (
      annotation === undefined ||
      !ts.isTypeReferenceNode(annotation) ||
      annotation.typeName.getText(parsed) !== CONTRACT_TYPE_NAME
    ) {
      return;
    }
    if (!ts.isObjectLiteralExpression(node.initializer)) {
      return;
    }
    found.push({
      module,
      name: node.name.getText(parsed),
      members: stringMembersOf(node.initializer, parsed, literalsByName),
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

  it("negative control: the needle matches the shape it is looking for", () => {
    // Without this the case above passes over a needle that matches nothing, which is
    // the failure a pattern edit produces and no fixture would otherwise reveal.
    expect(GOVERNANCE_ID.test("Plan-013 — the timeline family's input-ask card")).toBe(true);
    expect(GOVERNANCE_ID.test("the usage-meters plan's context-window meter")).toBe(false);
  });
});
