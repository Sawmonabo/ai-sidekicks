// The probe a composition suite registers to show a composition writes into the pane registry it
// was handed and not the process-wide one. The probe kind is derived from what the composition
// left free and registered after it, because a hard-coded kind would collide once the feature that
// owns it lands and would run out when every kind is owned. When nothing is free the composition
// itself is the probe; nothing is unregistered to make room.

import { PANE_KINDS, type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { type PaneRegistry } from "./pane-registry.js";

/** The first pane kind `claimed` does not hold, in declaration order. */
export function firstFreePaneKind(claimed: readonly PaneKind[]): PaneKind | undefined {
  return PANE_KINDS.find((kind) => !claimed.includes(kind));
}

/**
 * Puts a probe body into `registry` on a free kind and returns the kind. `undefined` means every
 * kind is claimed, so the composition's own registrations are the probe.
 */
export function registerFreePaneKindProbe(
  registry: PaneRegistry,
  owner: string,
): PaneKind | undefined {
  const kind = firstFreePaneKind(registry.registeredPaneKinds());
  if (kind === undefined) {
    return undefined;
  }
  registry.register({ kind, owner, render: () => null });
  return kind;
}
