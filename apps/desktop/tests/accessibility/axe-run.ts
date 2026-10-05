// How this tier runs axe and reports what it found. The rule set and the failure message live
// here once so every file in the tier agrees on them: a narrower set would report clean over
// violations its neighbor catches, and a red run must name the rule and the node.
//
// axe runs inside the browser-mode page rather than through `@axe-core/playwright`, which needs
// a `Page` handle Vitest browser mode gives only to server-side commands, and which is the
// orchestrator page, not the tester iframe. axe audits only the nodes of the window it was loaded
// in, so a view drawn into another window is audited by a copy of axe loaded into that window.
//
// `axe-core` is MPL-2.0, admitted as a never-distributed test dependency: it is imported under
// `tests/` and nowhere under `src/`, so it cannot reach a shipped bundle.

import axe, { type Result } from "axe-core";

/**
 * WCAG 2.2 A + AA, the level every app view is held to.
 *
 * Both levels of every version, because axe's tags select the criteria a version introduced,
 * not everything its conformance requires: `wcag22aa` alone would claim 2.2 at both levels and
 * select only one. At the pinned `axe-core`, `wcag22a` selects no rule (2.2's Level A
 * additions are Consistent Help and Redundant Entry, which axe does not automate) and
 * `wcag22aa` selects `target-size`.
 */
export const AXE_TAGS: readonly string[] = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

/**
 * Run the tier's rule set over one element and hand back what it found. Scoped to an element
 * so a page holding several mounted views does not blame one view for another's violation.
 */
export async function runTierAxe(element: Element): Promise<readonly Result[]> {
  const results = await axeOf(element).run(element, {
    runOnly: { type: "tag", values: [...AXE_TAGS] },
  });
  // Copied into this window's array: another window's axe answers in that window's, which a strict
  // comparison here would tell apart from an equal one.
  return [...results.violations];
}

/** One line per violation: the rule, its impact, and the nodes it landed on. */
export function describeViolations(violations: readonly Result[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? "unknown"}): ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}

/**
 * The tier's negative control: a node known to violate one of these rules. A misconfigured run
 * returns the same empty list as a clean one, so finding a planted violation is what makes a
 * clean result evidence. The caller removes the node.
 */
export function plantAxeViolation(ownerDocument: Document): HTMLElement {
  const planted = ownerDocument.createElement("div");
  planted.innerHTML = '<img src="data:," />';
  ownerDocument.body.append(planted);
  return planted;
}

/** The rule id `plantAxeViolation`'s node breaks. Named so a case can assert it. */
export const PLANTED_VIOLATION_RULE_ID = "image-alt";

/** The window axe is loaded into, under the global name its own script gives it. */
type WindowWithAxe = Window & { axe?: typeof axe };

/** axe as loaded in the element's own window, loading it there the first time it is asked. */
function axeOf(element: Element): typeof axe {
  const ownerWindow: WindowWithAxe | null = element.ownerDocument.defaultView;
  if (ownerWindow === null || ownerWindow === window) {
    return axe;
  }
  if (ownerWindow.axe === undefined) {
    const script = element.ownerDocument.createElement("script");
    script.textContent = axe.source;
    element.ownerDocument.head.append(script);
  }
  if (ownerWindow.axe === undefined) {
    throw new Error("axe did not load into the window the audited element is drawn in");
  }
  return ownerWindow.axe;
}
