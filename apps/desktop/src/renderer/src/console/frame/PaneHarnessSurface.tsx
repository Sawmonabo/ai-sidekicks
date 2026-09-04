// The one door through which a registered pane body can be opened in a running
// console window — fixture builds only.
//
// WHY IT EXISTS. `Spec-023 §Console Design (Meridian)` §Budgets bounds one
// `terminal` pane instance, and a budget's harness has to hold the subject the row
// names: the emulator, its WebGL renderer, and the pane's own React tree, lease,
// and store state. Nothing in this revision mounts a registered pane — the deck
// that will open them is a later family's — so the endurance tier had no window in
// which one could be held, and the row sat ungated for want of a mount rather than
// for want of a measurement. This is that mount, and it is deliberately the
// smallest one that is honest: an address, the registry's own resolve, and a
// control that opens another instance.
//
// WHY IT RESOLVES THROUGH THE REGISTRY AND NEVER IMPORTS A PANE. The thing being
// measured is what the DECK would mount, which is the descriptor a family
// registered — `panes/terminal/index.ts`'s `TERMINAL_PANE_DESCRIPTOR`, reached by
// `ConsolePaneRegistry.descriptorFor`. A harness that imported `TerminalPane`
// directly would measure a component that happens to sit beside the registration,
// and would keep measuring it on the day the registration changed.
//
// WHY IT IS PER KIND AND NOT PER TERMINAL. Every §Budgets row that bounds ONE PANE
// has the same shape — open the surface empty, open n instances of one kind, read
// the difference — so the kind travels on the address and this module names no pane
// kind anywhere. The terminal is the only kind whose row is measured today; the
// next one costs a different hash and no code.
//
// WHY THE BODIES ARE MOUNTED AS COMPONENTS RATHER THAN CALLED. `RouteSurface`
// invokes `descriptor.render(context)` inline, which is correct for a surface:
// exactly one mounts, and its hooks are this component's hooks in a fixed order.
// A harness holds a VARIABLE number of bodies, and every registered pane body holds
// hooks — so calling them inline would splice n × k hooks into one component and
// change that count the moment the control was used, which is the one React rule a
// render cannot bend. Each body is therefore mounted as its own element with a
// stable key, which is also what makes opening a second instance leave the first
// one standing: the measurement's per-instance slope depends on it.
//
// WHAT THE SUBJECT IS, AND WHAT IT IS NOT. What this surface holds is one pane
// instance and everything that instance owns. It is NOT a deck: there is no tab
// strip, no layout, no drag target, and no detach path, and that is the right
// boundary rather than a gap — the row's own sentence bounds "one `terminal` pane
// instance … the `@xterm/xterm` instance, its WebGL renderer, and the pane's own
// state", and a reading taken inside a deck would fold the deck's chrome into a
// per-instance figure and report a pane over its budget for the deck's own cost.

import { useState, type ReactNode } from "react";

import { Nothing } from "../primitives/index.js";
import {
  parseConsolePaneAddress,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type ConsolePaneRegistry,
} from "../seats/index.js";
import { type ConsoleSurfaceContext, type ConsoleSurfaceRegistry } from "./surface-registry.js";

/** The surface region's accessible name — how a driver finds this surface. */
const PANE_HARNESS_LABEL = "Pane harness";

/** The control that mounts one more instance of the addressed kind. */
const OPEN_CONTROL_LABEL = "Open a pane";

/** The control that unmounts the newest one. */
const CLOSE_CONTROL_LABEL = "Close the newest pane";

/**
 * Claim the harness slot, in a fixture build and in no other.
 *
 * The guard is HERE rather than at the composition site: `families.ts` states that
 * no condition lands in it and that a family owns its own decision, and whether
 * this surface exists at all is this module's decision. Under
 * `__SIDEKICKS_CONSOLE_FIXTURES__ === false` Rollup collapses the body, the
 * component below is referenced from nothing, and the whole harness leaves the
 * bundle — the same treatment the fixture bridge and its scenarios get.
 *
 * BOTH registries are parameters, on `registerConsoleFamilies`' rule: the surface
 * is registered into the board the composition owns, and it resolves pane bodies
 * out of the pane board that same composition owns. Reaching for either module
 * singleton would make a window composing its own boards mount bodies from the
 * production one.
 */
export function registerPaneHarnessSurface(
  surfaceRegistry: ConsoleSurfaceRegistry,
  paneRegistry: ConsolePaneRegistry,
): void {
  if (!__SIDEKICKS_CONSOLE_FIXTURES__) {
    return;
  }
  surfaceRegistry.register({
    slot: "pane-harness",
    owner: "pane-harness",
    render: (context) => <PaneHarnessSurface context={context} paneRegistry={paneRegistry} />,
  });
}

export interface PaneHarnessSurfaceProps {
  readonly context: ConsoleSurfaceContext;
  readonly paneRegistry: ConsolePaneRegistry;
}

/**
 * The harness: an addressed pane kind, and however many instances of it are open.
 *
 * Exported for its own co-located test, which drives it without a route by handing
 * it a context — the same shape every other surface in this family takes.
 */
export function PaneHarnessSurface(props: PaneHarnessSurfaceProps): React.JSX.Element {
  const { context, paneRegistry } = props;
  const [openInstanceCount, setOpenInstanceCount] = useState(0);
  const { route } = context;

  if (route.kind !== "pane-harness") {
    // Unreachable through `surfaceSlotFor`, which maps this slot from this arm
    // alone. Rendered rather than thrown because a surface that throws takes the
    // window's error boundary and reports a crash for what is a composition
    // mistake with a name.
    return (
      <HarnessFrame instanceCount={0} paneKindLabel={undefined}>
        <Nothing
          kind="error"
          placement="surface"
          title="This surface was mounted on an address it does not serve."
          detail={`The pane harness reads its pane kind off the "#/pane-harness/…" address and this window is on a "${route.kind}" route.`}
        />
      </HarnessFrame>
    );
  }

  // The console's ONE admission point for an address that arrived untyped — the
  // same predicate a layout snapshot read off disk is held to. A hash anyone can
  // type is exactly the second boundary that function names, so the harness holds
  // its segment to it rather than deciding for itself which kinds exist.
  const address = parseConsolePaneAddress(route.paneKind, undefined);
  if ("code" in address) {
    return (
      <HarnessFrame instanceCount={0} paneKindLabel={route.paneKind}>
        <Nothing
          kind="error"
          placement="surface"
          title="That address does not name a pane this build can open."
          detail={`${address.code}: ${address.detail}`}
        />
      </HarnessFrame>
    );
  }

  const descriptor = paneRegistry.descriptorFor(address.kind);
  if (descriptor === undefined) {
    // Reserved, not stubbed — `RouteSurface`'s rule one level down. The kind is a
    // pane kind; no family has registered a body for it.
    return (
      <HarnessFrame instanceCount={0} paneKindLabel={address.kind}>
        <Nothing
          kind="empty"
          placement="surface"
          title="No family has registered a body for this pane kind."
          detail={`"${address.kind}" is one of the deck's pane kinds and nothing in this build renders it, so there is no instance for a harness to hold.`}
        />
      </HarnessFrame>
    );
  }

  // The registered body, mounted as an element per instance. Named here so the
  // element below reads as a component rather than as a call.
  const PaneBody = descriptor.render;

  return (
    <HarnessFrame
      instanceCount={openInstanceCount}
      paneKindLabel={address.kind}
      onOpen={() => {
        // Unbounded on purpose. The bound that matters is the page's WebGL context
        // ledger, which `terminal/renderer-pool.ts` already holds and already
        // degrades past — a second ceiling here would be a bound with no reader,
        // and one this surface would have to keep in step with that one.
        setOpenInstanceCount((count) => count + 1);
      }}
      onClose={() => {
        setOpenInstanceCount((count) => Math.max(0, count - 1));
      }}
    >
      {instanceIndices(openInstanceCount).map((instanceIndex) => (
        <PaneBody
          key={paneInstanceId(address, instanceIndex)}
          {...paneContextFor(context, address, instanceIndex)}
        />
      ))}
    </HarnessFrame>
  );
}

/**
 * The region, its controls, and its count — the parts every arm above renders.
 *
 * Shared rather than repeated because the count line is what a driver reads to know
 * how many bodies are mounted, and an arm that rendered an absence without it would
 * leave a driver waiting on a line that never appears.
 */
function HarnessFrame(props: {
  readonly instanceCount: number;
  readonly paneKindLabel: string | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly children?: ReactNode;
}): React.JSX.Element {
  const { instanceCount, paneKindLabel, onOpen, onClose, children } = props;
  return (
    <section aria-label={PANE_HARNESS_LABEL}>
      <p>
        {/* The two facts a driver waits on, in one line: which kind is addressed
            and how many of it are mounted right now. */}
        {`${paneKindLabel ?? "no"} panes open: ${String(instanceCount)}`}
      </p>
      <button
        type="button"
        disabled={onOpen === undefined}
        onClick={() => {
          onOpen?.();
        }}
      >
        {OPEN_CONTROL_LABEL}
      </button>
      <button
        type="button"
        disabled={onClose === undefined || instanceCount === 0}
        onClick={() => {
          onClose?.();
        }}
      >
        {CLOSE_CONTROL_LABEL}
      </button>
      {children}
    </section>
  );
}

/** `[0, 1, … count - 1]`. A named helper so the render body holds no arithmetic. */
function instanceIndices(count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => index);
}

/**
 * One instance's identity in this harness.
 *
 * Stable across a count change, which is what makes opening a second instance an
 * ADDITION rather than a re-key that would unmount and rebuild the first — and the
 * per-instance slope the budget's negative control compares depends on the first
 * instance surviving the second one's mount.
 */
function paneInstanceId(address: ConsolePaneAddress, instanceIndex: number): string {
  return `pane-harness-${address.kind}-${String(instanceIndex)}`;
}

/**
 * What a pane body is handed here, and why each member is the surface's own.
 *
 * Every store comes off the surface context rather than being minted here: the
 * budget's subject is a pane in a RUNNING console, so the pane reads the window's
 * own bridge, frame store, session store, durable UI state, and drafts — the same
 * five a deck would hand it. The two members a deck decides and this harness does
 * not are passed absent rather than invented: nothing opened this pane from another
 * pane, and no actor is attributed to it, which is the neutral answer
 * `ConsolePaneContext` documents for both.
 */
function paneContextFor(
  context: ConsoleSurfaceContext,
  address: ConsolePaneAddress,
  instanceIndex: number,
): ConsolePaneContext {
  return {
    ...address,
    paneId: paneInstanceId(address, instanceIndex),
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore: context.sessionStore,
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    linkedSourcePaneId: undefined,
    focusHue: undefined,
  };
}
