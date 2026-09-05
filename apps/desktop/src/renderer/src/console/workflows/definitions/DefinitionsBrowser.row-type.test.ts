// The browser's row IS the wire summary, checked where that claim lives.
//
// Not about the markup at all. `WorkflowDefinitionRow` is an ALIAS of the wire summary
// rather than a second declaration of it, and nothing a render can observe would
// notice the difference: a hand-written mirror renders the same four members right up
// until the reply grows a fifth. So the claim is checked in the type system, with the
// mirror it replaced planted beside it.

import { describe, expect, it } from "vitest";

import type { WorkflowDefinitionSummary } from "../../bridge/index.js";
import type { WorkflowDefinitionRow, WorkflowDefinitionScope } from "./DefinitionsBrowser.js";

/**
 * Whether two types are the same type, rather than one merely fitting the other.
 *
 * Both directions, because one alone is exactly the check a stale mirror passes: a
 * reply carrying more than a mirror asks for is still assignable TO that mirror, so a
 * one-way test stays green for the whole time the view vocabulary is wrong. Each side
 * is wrapped in a tuple so the `extends` compares the types rather than distributing
 * over the members of a union.
 */
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

/** The alias's whole claim: the browser's row IS the enumeration's reply. */
const ROW_IS_THE_WIRE_SUMMARY: MutuallyAssignable<
  WorkflowDefinitionRow,
  WorkflowDefinitionSummary
> = true;

/**
 * The foil: the mirror this file's subject used to be, one member short.
 *
 * Hand-written on purpose and short on purpose. `createdAt` stands for whichever
 * member the wire grows next — the point is that a mirror keeps compiling while the
 * reply moves past it, and that this file notices.
 */
interface DriftedDefinitionMirror {
  readonly id: string;
  readonly name: string;
  readonly scope: WorkflowDefinitionScope;
  readonly scopeRef: string;
  readonly latestVersionNumber: number;
  readonly latestWorkflowVersionId: string;
  readonly contentHash: string;
  readonly resolvesAtThisContext: boolean;
}

/**
 * The same claim about the mirror, which the compiler resolves to `false`.
 *
 * The suppressed error IS the assertion: it stops occurring — and this directive
 * becomes the error — the day a mirror missing a member starts counting as the wire
 * summary, which is the day the check would have stopped meaning anything.
 */
// @ts-expect-error — a mirror one member short is not the wire summary.
const MIRROR_THE_COMPILER_REJECTS: MutuallyAssignable<
  DriftedDefinitionMirror,
  WorkflowDefinitionSummary
> = true;

describe("the row type", () => {
  it("is the bridge's own definition summary rather than a second declaration", () => {
    expect(ROW_IS_THE_WIRE_SUMMARY).toBe(true);
  });

  it("negative control: a hand-written mirror one member short is not that summary", () => {
    // Reads the value the `@ts-expect-error` above suppressed, so the directive is a
    // claim this file executes rather than a comment nobody runs. Without the pair,
    // the case above would pass over any mirror the reply happens to fit today.
    expect(MIRROR_THE_COMPILER_REJECTS).toBe(true);
  });
});
