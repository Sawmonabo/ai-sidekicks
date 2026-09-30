// The harness the mount module uses: what a mounted view is, and how a tier finds it. Split from
// `repos.tsx`, which holds mounts and nothing else.

import { within } from "@testing-library/react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedView {
  readonly element: HTMLElement;
  readonly bridge: PlatformBridge;
}

/**
 * Finds the one region a view renders itself as, by the name it announces.
 *
 * By accessible name, not class, because that is what assistive technology navigates by: a view
 * that lost its name would still match a class selector. `getByRole` resolves the name through
 * `aria-labelledby` and its heading as the accessibility tree does. A pattern is accepted because
 * a pane's name is its whole address trail (`PaneFrame` names a pane "session-1 workspace-01
 * Diff"); a caller wanting "the diff pane, whichever subject" anchors a pattern at the kind.
 */
export function requireLabeledRegion(
  container: HTMLElement,
  accessibleName: string | RegExp,
): HTMLElement {
  return within(container).getByRole("region", { name: accessibleName });
}

/**
 * Finds a view that announces no name of its own, by the class it renders under.
 *
 * The sidebar section is the one such view: the chrome owns its heading and disclosure state, so
 * a second announced name would put two regions in the tree. Throws instead of returning null so
 * a tier never compares an empty box against a baseline.
 */
export function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree matches \`${selector}\``);
  }
  return element;
}

/**
 * What the pane chrome calls a pane of one kind mounted over `sessionId`.
 *
 * Every scope the address carries, then what the pane is.
 */
export function paneTrailName(sessionId: string | undefined, paneWord: string): string {
  return `${sessionId ?? "No session"} ${paneWord}`;
}
