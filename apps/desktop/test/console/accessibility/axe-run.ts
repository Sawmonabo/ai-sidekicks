// How the accessibility tier runs axe, in one place.
//
// Not a test file — no `include` glob reaches it. It is imported by every file in
// the tier, because the rule SET is a property of the tier: a family that ran a
// different set of tags would report clean against a different standard, and the
// two results would be compared as though they were comparable.
//
// It runs INSIDE the browser-mode page rather than through `@axe-core/playwright`,
// which wants a `@playwright/test` `Page` handle Vitest browser mode hands only to
// server-side custom commands, never to test code, and which is the orchestrator
// page rather than the tester iframe — same engine, same rule set, one less
// indirection. (`axe-core` is MPL-2.0 and is admitted as a never-distributed test
// dependency by ADR-020's Decision Log; it must not reach a shipped bundle, which
// is why it is imported here and nowhere under `src/`.)

import axe, { type Result } from "axe-core";

/** WCAG 2.2 A + AA, which is the level `Spec-023 §Console Design (Meridian)` rule 3 sets. */
export const AXE_TAGS: readonly string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * A violation as one readable line.
 *
 * The tier asserts on the LIST rather than on a count, so a failure names the rule
 * and the node instead of saying a number went up.
 */
export function describeViolations(violations: readonly Result[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? "unknown"}): ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}

/** Run the tier's rule set over one subtree and describe whatever it found. */
export async function axeViolationsIn(root: Element): Promise<string[]> {
  const results = await axe.run(root, { runOnly: { type: "tag", values: [...AXE_TAGS] } });
  return describeViolations(results.violations);
}

/**
 * The rule ids axe finds in a subtree with a known defect planted in it.
 *
 * The negative control for every clean result in the tier: axe returning nothing is
 * the expected result, and a misconfigured run — wrong root, wrong tags, an
 * exception swallowed — returns exactly the same nothing. The planted node is
 * removed whatever happens, so a failing assertion cannot leave a violation behind
 * for the next file in the page to find.
 */
export async function plantedViolationIds(): Promise<readonly string[]> {
  const planted = document.createElement("div");
  planted.innerHTML = '<img src="data:," />';
  document.body.append(planted);
  try {
    const results = await axe.run(planted, {
      runOnly: { type: "tag", values: [...AXE_TAGS] },
    });
    return results.violations.map((violation) => violation.id);
  } finally {
    planted.remove();
  }
}
