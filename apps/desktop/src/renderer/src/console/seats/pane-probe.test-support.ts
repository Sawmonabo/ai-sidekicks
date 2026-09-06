// The probe a composition suite registers, and how it picks a kind to register on.
//
// WHY A PICKER AND NOT A KIND
//
// Two suites prove the same seam — that a composition writes into the pane board it
// was HANDED and not into the process-wide one — and both prove it the same way: put
// a body of their own into the caller's board, then ask whether the singleton knows
// about it. The instrument needs a kind, and both suites used to name one in their
// source.
//
// A named kind cannot survive the board filling up. `pane-kinds.ts` closes the set at
// eleven members, six view families are landing at once, and once they have all
// landed every member is owned. A hard-coded kind is claimed twice the moment the
// family that owns it lands — the registry refuses a second owner rather than letting
// import order decide, which is correct and which turns the probe into a throw — and
// when the last one lands there is no kind left to name at all.
//
// So the kind is DERIVED from what the composition left free, and the probe is
// registered AFTER the composition rather than before it. That makes the instrument
// order-independent and family-independent at once: it names no kind, it holds no
// opinion about which family owns what, and it goes on working as the board fills.
//
// AND WHEN NOTHING IS FREE, THE COMPOSITION IS THE PROBE. The seam a suite is
// proving is that the caller's board holds bodies and the singleton does not. A
// board with every kind claimed already demonstrates exactly that, so the honest
// answer on that arm is to register nothing and say so — never to unregister
// somebody's body to make room, which would prove the seam over a board no
// composition ever produces.

import { PANE_KINDS, type PaneKind } from "./pane-kinds.js";
import { type ConsolePaneRegistry } from "./pane-registry.js";

/**
 * The first pane kind `claimed` does not hold, in declaration order.
 *
 * Declaration order rather than any order of its own, so the kind a suite probes on
 * is a property of the closed set and of what the composition claimed — never of
 * which family's module happened to evaluate first.
 */
export function firstFreePaneKind(claimed: readonly PaneKind[]): PaneKind | undefined {
  return PANE_KINDS.find((kind) => !claimed.includes(kind));
}

/**
 * Put a probe body into `registry` on a kind it left free, and report the kind.
 *
 * `undefined` means the registry already holds every kind in the closed set, which
 * is not a failure: the composition's own registrations are then the probe, and a
 * caller asserts over them exactly as it would over the body this registers.
 */
export function registerFreePaneKindProbe(
  registry: ConsolePaneRegistry,
  owner: string,
): PaneKind | undefined {
  const kind = firstFreePaneKind(registry.registeredPaneKinds());
  if (kind === undefined) {
    return undefined;
  }
  registry.register({ kind, owner, render: () => null });
  return kind;
}
