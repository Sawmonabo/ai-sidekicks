// This family's claim on the frame-lifetime binding board.
//
// A REGISTRAR OF ITS OWN, not a call inside the workspace component's module scope.
// The board is handed to `families.ts` so a composition can fill it into a registry it
// owns — a test's, an auxiliary window's subset — and a family that reached for the
// process-wide singleton instead would write into production from every caller.
//
// It is a `.ts` module beside the component rather than the component's own file for
// the package's one-component rule: `DetachedPaneBinding.tsx` declares the component,
// and this declares who claims which slot with it.

import { createElement } from "react";

import { type FrameBindingRegistry } from "../../seats/index.js";
import { DetachedPaneBinding } from "./DetachedPaneBinding.js";

/** The family that owns the slot, so an unmounted binding names somebody. */
const WORKSPACE_BINDING_OWNER = "workspace-auxiliary";

/**
 * Claim the detached-pane binding.
 *
 * The element is built by the mount rather than here, on the board's own shape: what a
 * family hands over is `createElement(TheBinding, …)`, so the hooks run inside the
 * family's own component and get their own instance and their own place in the tree.
 */
export function registerWorkspaceFrameBindings(registry: FrameBindingRegistry): void {
  registry.register({
    slot: "detached-panes",
    owner: WORKSPACE_BINDING_OWNER,
    mount: (props) => createElement(DetachedPaneBinding, props),
  });
}
