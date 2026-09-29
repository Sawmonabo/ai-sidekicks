// The harness the mount module uses: what a mounted surface IS, and how a tier finds it.
//
// SPLIT OUT SO THE MOUNT DOES NOT SHARE A FILE WITH THE MACHINERY. `repos.tsx` holds
// surfaces and nothing else, and reaches into this module's exports.

import { within } from "@testing-library/react";
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedView {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/**
 * Find the one region a surface renders itself as, by the name it announces.
 *
 * By accessible name rather than by class, because that is what a person using
 * assistive technology navigates by — a surface that lost its accessible name would
 * still match a class selector and would still be captured as if nothing had
 * changed. `getByRole` rather than a selector for the same reason: it resolves the
 * name the way the accessibility tree does, through `aria-labelledby` and the
 * heading it points at.
 *
 * A PATTERN AS WELL AS A STRING, because a pane's name is its whole address trail:
 * `seats/pane/ConsolePaneChrome` names a pane "session-1 workspace-01 Diff" so two panes of
 * one kind are told apart by what they are views of. A caller that wants to say "the diff
 * pane, whichever subject it is over" anchors a pattern at the kind; a caller naming a
 * surface whose name is fixed still passes the string.
 */
export function requireLabelledRegion(
  container: HTMLElement,
  accessibleName: string | RegExp,
): HTMLElement {
  return within(container).getByRole("region", { name: accessibleName });
}

/**
 * Find a surface that announces no name of its own, by the class it renders under.
 *
 * The sidebar section is the one such surface this family has, and deliberately: the
 * sidebar chrome owns the section's heading and its disclosure state, so a body that
 * announced a second name would put two regions in the tree for one section. The
 * selector is what is left, and a throw rather than a null keeps a tier from
 * comparing an empty box against a baseline.
 */
export function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree matches \`${selector}\``);
  }
  return element;
}
