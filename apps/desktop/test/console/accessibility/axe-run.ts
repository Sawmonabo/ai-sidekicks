// The accessibility tier's one axe invocation, shared by every file in it.
//
// Not a test file — no `include` glob reaches it. Each file in this tier asks axe
// the same question of a different surface, and the question has three parts: which
// rule set the run is scoped to, what a violation is reported AS, and which root it
// is run over. A per-file copy of any of them would be two surfaces measured by two
// instruments and then compared as though the results were comparable — and the
// drift would be silent, because a run with a narrower tag list reports fewer
// violations rather than reporting that it asked less.
//
// WHY THE RUN IS IN-PAGE AND NOT THROUGH `@axe-core/playwright`
//
// That adapter wants a `@playwright/test` `Page` handle, which Vitest browser mode
// hands only to server-side custom commands and never to test code — and the handle
// it would hand over is the orchestrator page rather than the tester iframe the
// console is actually mounted in. Same engine, same rule set, one less indirection.
//
// `axe-core` is MPL-2.0 and is admitted as a never-distributed test dependency by
// ADR-020's Decision Log. It is imported here and by this tier's test files, and it
// must not reach a shipped bundle — which is why it appears nowhere under `src/`.

import axe, { type Result } from "axe-core";

/** WCAG 2.2 A + AA, which is the level `Spec-023 §Console Design (Meridian)` rule 3 sets. */
export const AXE_TAGS: readonly string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Run this tier's rule set over one root, and hand back the violations alone.
 *
 * The violations rather than the whole `AxeResults`, because every caller in this
 * tier wants exactly that list and a caller holding the full result is a caller free
 * to assert on `passes.length` — a number that moves whenever axe adds a rule, which
 * would make an unrelated dependency bump look like a regression in the console.
 *
 * The tag list is spread into a fresh array on the way in: `runOnly.values` is a
 * mutable `string[]` in axe's own types, and handing it the module-level constant
 * would let a rule set the whole tier shares be edited by whatever it is passed to.
 */
export async function runAxe(root: Element): Promise<readonly Result[]> {
  const results = await axe.run(root, { runOnly: { type: "tag", values: [...AXE_TAGS] } });
  return results.violations;
}

/**
 * One line per violation: the rule, its impact, and the nodes that broke it.
 *
 * Assertions in this tier compare this list against `[]` rather than comparing a
 * COUNT against zero, so a failure names the rule and the element instead of saying
 * a number went up — which is the difference between a report somebody can act on
 * and one they have to reproduce locally before they can even read it.
 */
export function describeViolations(violations: readonly Result[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? "unknown"}): ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}
