// The one way a registered pane body can be opened in a running window — fixture
// builds only.
//
// WHY IT EXISTS. The console budgets bound one `terminal` pane instance, and a budget's
// harness has to hold the subject the row names: the emulator, its WebGL renderer, and
// the pane's own React tree, lease, and store state. The endurance tier needs a window in
// which one pane instance is held without the pane layout around it. This is that mount,
// and it is deliberately the smallest one that is honest: an address, the registry's own resolve,
// and a control that opens another instance.
//
// WHY IT RESOLVES THROUGH THE REGISTRY AND NEVER IMPORTS A PANE. The thing being
// measured is what the PANE LAYOUT would mount, which is the descriptor a feature
// registered — the one the terminal feature's `registerTerminalPane` declares,
// reached by `PaneRegistry.descriptorFor`. A harness that imported `TerminalPane`
// directly would measure a component that happens to sit beside the registration,
// and would keep measuring it on the day the registration changed.
//
// WHY IT IS PER KIND AND NOT PER TERMINAL. Every budget row that bounds ONE PANE has
// the same shape — open the harness empty, open n instances of one kind, read the
// difference — so the kind travels on the address and this module names no pane kind
// anywhere. The terminal is the only kind whose row is measured today; the next one
// costs a different hash and no code.
//
// WHY THE BODIES ARE MOUNTED AS COMPONENTS RATHER THAN CALLED. `AppRouter`
// invokes `descriptor.render(context)` inline, which is correct for a screen:
// exactly one mounts, and its hooks are this component's hooks in a fixed order.
// A harness holds a VARIABLE number of bodies, and every registered pane body holds
// hooks — so calling them inline would splice n × k hooks into one component and
// change that count the moment the control was used, which is the one React rule a
// render cannot bend. Each body is therefore mounted as its own element with a
// stable key, which is also what makes opening a second instance leave the first
// one standing: the measurement's per-instance slope depends on it.
//
// WHAT KEEPS ONE ROUTE'S PANES OFF ANOTHER ROUTE'S SUBJECT. Two `#/pane-harness/…`
// addresses resolve to this one screen, so `AppRouter` keys the screen it mounts
// on the address itself and this component is rebuilt — count and all — whenever the
// pane kind or the session changes. The pane keys below carry the session for the
// same reason, one level down: they are the identity React reconciles an instance
// by, and two addresses that differ only in their session would otherwise produce
// identical keys, handing the instances to a session they were never bound to.
//
// WHAT THE SUBJECT IS, AND WHAT IT IS NOT. What this harness holds is one pane
// instance and everything that instance owns. It is NOT a pane layout: there is no tab
// strip, no layout, no drag target, and no detach path, and that is the right
// boundary rather than a gap — the row's own sentence bounds "one `terminal` pane
// instance … the `@xterm/xterm` instance, its WebGL renderer, and the pane's own
// state", and a reading taken inside a pane layout would fold the pane layout's chrome into a
// per-instance figure and report a pane over its budget for the pane layout's own cost.

import { useState } from "react";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { PaneHarnessFrame } from "./PaneHarnessFrame.js";
import { paneHarnessInstances } from "./pane-harness-instances.js";
import { parsePaneAddress } from "@renderer/routing/panes/parse-pane-address.js";
import { type PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";

/** The harness screen's inputs: the route's context and the pane board it resolves from. */
export interface PaneHarnessScreenProps {
  readonly context: ScreenContext;
  readonly paneRegistry: PaneRegistry;
}

/**
 * The harness: an addressed pane kind, and however many instances of it are open.
 *
 * Exported for its own co-located test, which drives it without a route by handing
 * it a context — the same shape every other screen takes.
 */
export function PaneHarnessScreen(props: PaneHarnessScreenProps): React.JSX.Element {
  const { context, paneRegistry } = props;
  const [openInstanceCount, setOpenInstanceCount] = useState(0);
  const { route } = context;

  if (route.kind !== "pane-harness") {
    // Unreachable through `findScreenNameForRoute`, which maps this screen from this arm
    // alone. Rendered rather than thrown because a screen that throws takes the
    // window's error boundary and reports a crash for what is a composition
    // mistake with a name.
    return (
      <PaneHarnessFrame instanceCount={0} paneKindLabel={undefined}>
        <Nothing
          kind="error"
          placement="block"
          title="This screen was opened at an address it does not serve."
          detail={`The pane harness reads its pane kind off the "#/pane-harness/…" address and this window is on a "${route.kind}" route.`}
        />
      </PaneHarnessFrame>
    );
  }

  // The console's ONE admission point for an address that arrived untyped — the
  // same predicate a layout snapshot read off disk is held to. A hash anyone can
  // type is exactly the second boundary that function names, so the harness holds
  // its segment to it rather than deciding for itself which kinds exist.
  const address = parsePaneAddress(route.paneKind, undefined);
  if ("code" in address) {
    return (
      <PaneHarnessFrame instanceCount={0} paneKindLabel={route.paneKind}>
        <Nothing
          kind="error"
          placement="block"
          title="That address does not name a pane this build can open."
          detail={`${address.code}: ${address.detail}`}
        />
      </PaneHarnessFrame>
    );
  }

  const descriptor = paneRegistry.descriptorFor(address.kind);
  if (descriptor === undefined) {
    // The kind is a pane kind no feature has registered a body for, so the harness
    // says so instead of drawing a placeholder, as `AppRouter` does for a screen.
    return (
      <PaneHarnessFrame instanceCount={0} paneKindLabel={address.kind}>
        <Nothing
          kind="empty"
          placement="block"
          title="No feature has registered a body for this pane kind."
          detail={`"${address.kind}" is one of the pane kinds and nothing in this build renders it, so there is no instance for a harness to hold.`}
        />
      </PaneHarnessFrame>
    );
  }

  const instances = paneHarnessInstances(
    descriptor,
    context,
    address,
    route.sessionId,
    openInstanceCount,
  );

  return (
    <PaneHarnessFrame
      instanceCount={openInstanceCount}
      paneKindLabel={address.kind}
      onOpen={() => {
        // Unbounded on purpose. The bound that matters is the page's WebGL context
        // ledger, which `terminal/emulator/renderer-pool.ts` already holds and already
        // degrades past — a second ceiling here would be a bound with no reader,
        // and one this harness would have to keep in step with that one.
        setOpenInstanceCount((count) => count + 1);
      }}
      onClose={() => {
        setOpenInstanceCount((count) => Math.max(0, count - 1));
      }}
    >
      {instances.map(({ key, PaneBody, context: paneContext }) => (
        <PaneBody key={key} {...paneContext} />
      ))}
    </PaneHarnessFrame>
  );
}
