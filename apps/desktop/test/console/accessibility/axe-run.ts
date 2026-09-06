// How this tier runs axe, and how it reports what axe found.
//
// Not a test file — no `include` glob reaches it. Two things every file in the tier
// has to agree on: the RULE SET, because a file running a narrower set would report
// clean over violations its neighbour would have caught, and the FAILURE MESSAGE,
// because the tier's whole claim is that a red run names the rule and the node
// rather than saying a number went up. Both live here once.
//
// It runs INSIDE the browser-mode page rather than through `@axe-core/playwright`,
// which wants a `@playwright/test` `Page` handle Vitest browser mode hands only to
// server-side custom commands, never to test code, and which is the orchestrator
// page rather than the tester iframe — same engine, same rule set, one less
// indirection.
//
// (`axe-core` is MPL-2.0 and is admitted as a never-distributed test dependency by
// ADR-020's Decision Log; it must not reach a shipped bundle, which is why it is
// imported under `test/` and nowhere under `src/`.)

import axe, { type Result } from "axe-core";

/** WCAG 2.2 A + AA, which is the level `Spec-023 §Console Design (Meridian)` rule 3 sets. */
const AXE_TAGS: readonly string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Run the tier's rule set over one element and hand back what it found.
 *
 * Takes the element rather than the whole document so a surface-scoped case reports
 * its own surface: a document-scoped run over a page holding three mounted surfaces
 * would attribute every violation to whichever one a reader looked at first.
 */
export async function runTierAxe(element: Element): Promise<readonly Result[]> {
  const results = await axe.run(element, { runOnly: { type: "tag", values: [...AXE_TAGS] } });
  return results.violations;
}

/**
 * One line per violation: the rule, its impact, and the nodes it landed on.
 *
 * The tier asserts on this LIST rather than on a count, so a failure names what to
 * fix instead of reporting that a number moved.
 */
export function describeViolations(violations: readonly Result[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? "unknown"}): ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}

/**
 * The tier's negative control: a node that is known to violate one of these rules.
 *
 * axe returning nothing is the expected result of every clean case, and a
 * misconfigured run — wrong root, wrong tags, an exception swallowed — returns
 * exactly the same nothing. Planting a violation and finding it is what makes a
 * clean result evidence. The caller removes the node it is handed.
 */
export function plantAxeViolation(): HTMLElement {
  const planted = document.createElement("div");
  planted.innerHTML = '<img src="data:," />';
  document.body.append(planted);
  return planted;
}

/** The rule id `plantAxeViolation`'s node breaks. Named so a case can assert it. */
export const PLANTED_VIOLATION_RULE_ID = "image-alt";
