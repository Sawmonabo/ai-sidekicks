// The marker a pane wears while its body's module is still in flight, and the one
// reader of it.
//
// WHY A MARKER EXISTS AT ALL. A loader-backed pane body arrives as its own chunk, so
// between the pane mounting and the module landing there is a frame in which the pane
// is its chrome and nothing else. That frame is correct — it is what
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine", buys by
// keeping a body off the initial import graph — but it must never be the frame a
// screenshot reference is minted from, or the reference records a pane that had not
// finished loading and every later run is compared against it.
//
// So the pending state says so in the DOM, and the screenshot tier's capture helper
// refuses to photograph a tree that carries one. The attribute is the whole mechanism:
// there is no timer to tune and no "settled" heuristic to get wrong — either the marker
// is on the page or it is not.
//
// THE PRODUCER AND THE READER SHARE THIS MODULE, which is the package's rule for two
// sides of one seam: `PendingPaneBody.tsx` stamps the attribute and `pendingPaneBodiesIn`
// finds it, and a second spelling of the string in a test would drift the first time the
// attribute was renamed and the gate would go green over a fallback.

/**
 * The attribute a pending pane body stamps on its own chrome.
 *
 * A `data-` attribute rather than a class name: a class is a styling hook and would
 * invite a rule that made the pending state LOOK like something, and the whole point of
 * this state is that it looks like the pane's own empty frame. Nothing styles it.
 */
export const PENDING_PANE_BODY_ATTRIBUTE = "data-meridian-pane-body-pending";

/** The selector form, so no caller composes the brackets itself. */
export const PENDING_PANE_BODY_SELECTOR: string = `[${PENDING_PANE_BODY_ATTRIBUTE}]`;

/**
 * Every pending pane body inside a tree, in document order.
 *
 * Returns the elements rather than a count or a boolean so a caller can say WHICH pane
 * was still loading — a failure that names `workflow-run` is actionable and one that
 * says "something was pending" is a second debugging session.
 *
 * The root itself is included in the search: a caller that captures one pane hands this
 * the pane's own element, and `querySelectorAll` alone would look only at descendants
 * and report a pending pane as settled.
 */
export function pendingPaneBodiesIn(root: Element): readonly Element[] {
  const withinRoot = [...root.querySelectorAll(PENDING_PANE_BODY_SELECTOR)];
  return root.matches(PENDING_PANE_BODY_SELECTOR) ? [root, ...withinRoot] : withinRoot;
}

/**
 * Which pane kinds are still loading inside a tree, for a failure message.
 *
 * Reads the attribute's own value, which the fallback sets to the pane kind, so the
 * message names the pane rather than the number of them.
 */
export function pendingPaneKindsIn(root: Element): readonly string[] {
  return pendingPaneBodiesIn(root).map(
    (element) => element.getAttribute(PENDING_PANE_BODY_ATTRIBUTE) ?? "unknown",
  );
}
