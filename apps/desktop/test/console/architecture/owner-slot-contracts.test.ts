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

function declaredContractsIn(module: string, sourceText: string): readonly DeclaredContract[] {
  const parsed = parseSourceText(module, sourceText);
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
    const members = new Map<string, string>();
    for (const property of node.initializer.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const value = literalStringOf(property.initializer);
      if (value !== undefined) {
        members.set(property.name.getText(parsed), value);
      }
    }
    found.push({ module, name: node.name.getText(parsed), members });
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

  it("negative control: the needle matches the shape it is looking for", () => {
    // Without this the case above passes over a needle that matches nothing, which is
    // the failure a pattern edit produces and no fixture would otherwise reveal.
    expect(GOVERNANCE_ID.test("Plan-013 — the timeline family's input-ask card")).toBe(true);
    expect(GOVERNANCE_ID.test("the usage-meters plan's context-window meter")).toBe(false);
  });
});
