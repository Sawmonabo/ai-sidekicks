// The hand-off registry this window holds, for as long as the window is up.
//
// A FRAME-LIFETIME BINDING AND NOT A SURFACE, for the reason `seats/frame-bindings.ts`
// names: the workspace is a BODY, mounted when a route names it and unmounted when the
// route moves on, and which panes are showing in windows of their own is not a fact
// about which destination is open. Held on the surface, it went away every time a
// person navigated — and the auxiliary windows, which are the shell's, did not.
//
// IT RENDERS NOTHING, per that seat's own rule: it holds one read-free registry and
// returns the subtree it was handed, so nothing here is a surface a route can reach or
// a person can leave.

import { createContext, useContext } from "react";

import { ConsoleRefusalError, refuse } from "../../core/index.js";
// The seat's own props type rather than a second declaration of the same two members:
// this component IS a frame binding's mount, so its shape is the board's.
import { type FrameBindingProps } from "../../seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../store/index.js";
import { AuxiliaryHandoffRegistry } from "./aux-handoff-registry.js";

/** The subsystem a missing binding names as the author of its refusal. */
const DETACHED_PANE_BINDING_ORIGIN = "detached-pane-binding";

/**
 * How a registry ends: it is disposed, and a disposed one is readable.
 *
 * The terminal arm `frame/session-lifecycle.ts` states for the window's session
 * plumbing, and for its reason: React's double-mount would otherwise re-commit the
 * retired registry, and this window would go on filing hand-offs in a map nothing
 * reads.
 */
const HANDOFF_REGISTRY_DISPOSAL: SubjectScopedDisposal<AuxiliaryHandoffRegistry> = {
  dispose: (retired) => {
    retired.dispose();
  },
  isClosed: (registry) => registry.isDisposed,
};

const AuxiliaryHandoffRegistryContext = createContext<AuxiliaryHandoffRegistry | undefined>(
  undefined,
);

/**
 * Hold this window's hand-off registry and provide it to whatever is below.
 *
 * THE BRIDGE IS THE SUBJECT. A hand-off holds a subscription opened over one bridge's
 * auxiliary-window plane, so a scenario switch that replaces the bridge has to retire
 * the whole registry: a cell seeded on the first render would keep plumbing the
 * retired resolution, and every watch it holds would go on draining a signal nothing
 * reads.
 */
export function DetachedPaneBinding(props: FrameBindingProps): React.JSX.Element {
  const { bridge } = props.context;
  const { value: registry } = useSubjectScopedResource(
    bridge,
    undefined,
    () => new AuxiliaryHandoffRegistry({ auxiliaryWindows: bridge.auxiliaryWindows }),
    HANDOFF_REGISTRY_DISPOSAL,
  );
  return (
    <AuxiliaryHandoffRegistryContext.Provider value={registry}>
      {props.children}
    </AuxiliaryHandoffRegistryContext.Provider>
  );
}

/**
 * The registry the binding above holds.
 *
 * RAISES RATHER THAN SUBSTITUTES, on `useSessionAttention`'s rule: a surface reaching
 * for a binding no composition mounted is a wiring defect, and a mount-lifetime
 * registry minted here as a fallback would be exactly the state this binding exists to
 * remove — one that looks right until somebody navigates.
 */
export function useAuxiliaryHandoffRegistry(): AuxiliaryHandoffRegistry {
  const held = useContext(AuxiliaryHandoffRegistryContext);
  if (held === undefined) {
    throw new ConsoleRefusalError(
      refuse(
        DETACHED_PANE_BINDING_ORIGIN,
        "binding-unmounted",
        "This surface reads the window's detached-pane binding, and no composition mounted one above it.",
      ),
    );
  }
  return held;
}
