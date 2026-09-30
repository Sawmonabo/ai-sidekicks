// The marker a pane wears while its body's module is in flight, and the one reader of it.
//
// A loader-backed pane is only its chrome until the module lands. The screenshot tier's capture
// helper refuses to photograph a tree carrying the marker, so a reference is never minted from
// an unfinished pane. Producer and reader share this module so the attribute is spelled once.
// A loader-backed body that is neither a pane nor a route has no chrome to reserve, so its
// fallback is `reservedBodyRegion` alone.

import { createElement } from "react";

/**
 * The attribute a pending pane body stamps on its chrome. A `data-` attribute, so nothing styles
 * it.
 */
export const PENDING_BODY_ATTRIBUTE = "data-meridian-pane-body-pending";

/** The selector form of `PENDING_BODY_ATTRIBUTE`. */
export const PENDING_BODY_SELECTOR: string = `[${PENDING_BODY_ATTRIBUTE}]`;

/**
 * Every pending pane body inside a tree, in document order, so a failure can name which pane
 * was still loading. The root is searched too, since a capture may hand over one pane's element.
 */
export function findPendingBodies(root: Element): readonly Element[] {
  const withinRoot = [...root.querySelectorAll(PENDING_BODY_SELECTOR)];
  return root.matches(PENDING_BODY_SELECTOR) ? [root, ...withinRoot] : withinRoot;
}

/**
 * The marker values (pane kind or body name) of every pending body in a tree, for a failure
 * message.
 */
export function listPendingBodyNames(root: Element): readonly string[] {
  return findPendingBodies(root).map(
    (element) => element.getAttribute(PENDING_BODY_ATTRIBUTE) ?? "unknown",
  );
}

/**
 * The reserved region for a loader-backed body with no chrome of its own. It is `hidden`, so
 * it adds no box to the layout; its marker value is `bodyName`, which a refused capture prints.
 */
export function reservedBodyRegion(bodyName: string): React.ReactNode {
  return createElement("span", { hidden: true, [PENDING_BODY_ATTRIBUTE]: bodyName });
}
