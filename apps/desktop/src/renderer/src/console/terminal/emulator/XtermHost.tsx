// The emulator's mount point, and nothing else.
//
// The component's whole job is to own a DOM box and the lifetime of one
// `XtermTerminalAdapter` against it. Everything a terminal DOES — the buffer, the
// renderer, the addons, the write gate — belongs to that class, so this file has
// no branch a reviewer has to trace: the emulator's code is fetched, an effect
// attaches on mount, detaches on unmount, and a second effect forwards the write
// gate.
//
// WHY THE EMULATOR ARRIVES ON A LATER COMMIT THAN THE MOUNT. `@xterm/xterm`, its
// five addons, and its stylesheet are the console's largest single dependency, and
// `Spec-023 §Console Design (Meridian)` §Budgets excludes the terminal from the
// initial bundle by name. So this component reaches the adapter through
// `emulator-loader.ts`'s `import()` rather than a static import, and renders the
// box's absence — `not-loaded`, the read-in-flight kind — until the chunk lands.
// The skeleton is the primitive every other surface uses for a read in flight; a
// spinner here would be the console's second vocabulary for one state.
//
// WHERE THAT FETCH IS DECIDED. `emulator-state.ts` beside this file holds the
// reading and the rejection arm, because this component resolves the page's own
// loader and a fetch that REFUSES is only drivable where the loader is a parameter.
// This module renders the reading and decides nothing about it.
//
// WHY THE ADAPTER IS BUILT IN AN EFFECT AND NOT IN THE RENDER BODY. React may
// discard a render pass, and an adapter constructed during one would be an
// emulator — with a pooled WebGL context — that nothing will ever dispose. An
// effect runs only for a commit that stuck, and its cleanup is the only place the
// construction can be paired with the disposal. The one extra render that costs is
// paid once per mount and buys a teardown that cannot leak a context.
//
// WHY THE CALLBACKS ARE REACHED THROUGH A REF AND ARE NOT DEPENDENCIES. A parent
// that builds `onKeystroke` in its own render body hands this component a new
// function on every pass, and an effect that depended on that identity would
// dispose the adapter and build a fresh emulator for a re-render that changed
// nothing — silently dropping the operator's scrollback, and with it whatever the
// shell had printed. The emulator's lifetime belongs to the terminal id, so the
// functions live in a ref the adapter reads at call time. What DOES stay in the
// dependency list is whether each callback is present at all: a surface that
// gains the ability to write to the wire is built differently, and the adapter's
// own gate is the absence of the option rather than a check inside it.
//
// WHY THE RENDERER MODE IS SUBSCRIBED AND NOT COPIED. The renderer an instance
// draws with is not settled for the life of the mount: the GPU can take the WebGL
// context away at any point, and the addon's fallback to the DOM renderer is
// permanent for that instance. A mode read once at attachment would leave this
// box's `data-renderer` — and every consumer of `onRendererMode` — reporting
// `webgl` over a terminal that is no longer drawing with one.
//
// WHY THE HOST BOX IS ONLY NAMED AND THE LIVE TEXT IS NOT HERE. xterm.js draws
// a grid of spans (or a WebGL canvas), and its own accessibility layer exposes rows
// through an `aria-live="assertive"` region with a twenty-row flood guard. That
// region is the terminal's; announcing the grid a second time from outside it would
// read every cell twice. So this component names the region and lets the emulator
// own what is inside it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Nothing } from "../../primitives/index.js";
import { terminalEmulatorLoader, type TerminalEmulatorModule } from "./emulator-loader.js";
import { useTerminalEmulator, type TerminalEmulatorState } from "./emulator-state.js";
import type { TerminalRendererMode } from "./xterm-adapter.js";

export interface XtermHostProps {
  /** The shared terminal this surface is a view of. One per session in V1. */
  readonly terminalId: string;
  /** Whether the lease says this participant may type. Watch mode is `false`. */
  readonly isWriteEnabled: boolean;
  /** The surface's accessible name, supplied by the pane that mounted it. */
  readonly label: string;
  /** Where keystrokes go. Absent means this surface never writes to the wire. */
  readonly onKeystroke?: ((data: string) => void) | undefined;
  /** Where an allowed link goes. Absent means links render and never activate. */
  readonly onActivateLink?: ((url: string) => void) | undefined;
  /**
   * Told which renderer the instance settled on, and told again whenever that
   * changes — a lost WebGL context falls the instance back to the DOM renderer
   * for good, and a surface reporting the old one is reporting a renderer that is
   * no longer drawing anything.
   */
  readonly onRendererMode?: ((mode: TerminalRendererMode) => void) | undefined;
}

export function XtermHost(props: XtermHostProps): React.JSX.Element {
  const hostElementRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<XtermTerminalAdapterInstance | undefined>(undefined);
  const [rendererMode, setRendererMode] = useState<TerminalRendererMode | undefined>(undefined);
  const emulator = useTerminalEmulator(terminalEmulatorLoader);

  const { terminalId, isWriteEnabled, onKeystroke, onActivateLink, onRendererMode } = props;
  const callbacksRef = useLatestRef({ onKeystroke, onActivateLink, onRendererMode });
  // What the surface CAN do, rather than which functions were passed this pass.
  // Gaining or losing a capability changes how the emulator is built and is worth
  // a rebuild; a freshly created function for a capability the surface already had
  // is not.
  const canWriteToWire = onKeystroke !== undefined;
  const canActivateLinks = onActivateLink !== undefined;
  const writeGate = terminalWriteGate(isWriteEnabled, canWriteToWire);
  const isWritable = writeGate === "writable";
  // THE LEASE AS THE MOUNT EFFECT SEES IT, and the reason the gate has exactly one
  // mutator. An adapter is replaced whenever the terminal id or a capability moves,
  // and the lease does not move with it — so a gate applied only by the effect that
  // watches the LEASE left the fresh binding on its default shut stdin while the box
  // below went on rendering `data-write-enabled="true"`, and every character the
  // holder typed was discarded until the shell next changed hands. Handing the answer
  // to the construction rather than correcting the binding afterwards is what keeps
  // the two in step: a binding is BUILT with the lease, and `setWriteEnabled` moves it
  // only when the lease itself does.
  const isWritableRef = useLatestRef(isWritable);

  useEffect(() => {
    const hostElement = hostElementRef.current;
    if (emulator.status !== "loaded" || hostElement === null) {
      // Nothing to pair a disposal with yet: the box below is the absence, not the
      // surface, so there is no element for an emulator to open against.
      return undefined;
    }
    const adapter = new emulator.module.XtermTerminalAdapter({
      terminalId,
      isWriteEnabled: isWritableRef.current,
      onKeystroke: canWriteToWire
        ? (data: string): void => {
            callbacksRef.current.onKeystroke?.(data);
          }
        : undefined,
      onActivateLink: canActivateLinks
        ? (url: string): void => {
            callbacksRef.current.onActivateLink?.(url);
          }
        : undefined,
    });
    adapterRef.current = adapter;
    let unsubscribeFromRendererMode: (() => void) | undefined;
    // EVERY STEP THAT CAN LEAVE AN EMULATOR BEHIND, UNDER ONE GUARD, and the reason
    // is that React only pairs a construction with a disposal through the cleanup
    // this effect RETURNS. An attach opens the terminal and can take a pooled WebGL
    // context; the subscription that follows delivers the settled mode
    // SYNCHRONOUSLY, so a parent's `onRendererMode` that throws — a render-phase
    // store write, a consumer that asserts — threw out of the effect body before the
    // cleanup existed. React then had no disposer for a live emulator: its terminal,
    // its observers, and its renderer allocation stayed for the life of the page,
    // and the page's context allowance stayed spent. Disposing here and re-raising
    // keeps the failure visible while leaving nothing running behind it.
    try {
      adapter.attach(hostElement);
      // After the attach, because the renderer selection happens synchronously
      // inside it and the subscription delivers the current mode on subscribe — so
      // this order reports the SETTLED mode once rather than the constructed one
      // followed by the selected one. Every later delivery is a context loss, which
      // reaches the adapter asynchronously and so cannot slip through this gap.
      unsubscribeFromRendererMode = adapter.subscribeToRendererMode((mode) => {
        setRendererMode(mode);
        callbacksRef.current.onRendererMode?.(mode);
      });
    } catch (setupFailure: unknown) {
      adapterRef.current = undefined;
      adapter.dispose();
      throw setupFailure;
    }
    return () => {
      adapterRef.current = undefined;
      // Before the disposal, which resets the mode: a delivery from a teardown
      // would be a state write against a tree React is dropping, and it would say
      // the renderer fell back when what happened is that the pane closed.
      unsubscribeFromRendererMode?.();
      // Final, not `detach()`. The pane is going away, so the emulator's hold on
      // its renderer has to go back — a detach would keep the instance alive for
      // a remount that is never coming.
      adapter.dispose();
    };
  }, [emulator, terminalId, canWriteToWire, canActivateLinks, callbacksRef, isWritableRef]);

  // Separate from the mount effect on purpose: the lease changes far more often
  // than the pane mounts, and folding the two would tear down an emulator every
  // time the shell changed hands. It watches the LEASE and nothing else, because a
  // binding that did not exist when the lease last moved was constructed with the
  // answer above — so this is the gate's one mutator, and there is no second list of
  // adapter-replacing inputs here to fall out of step with the mount effect's.
  useEffect(() => {
    adapterRef.current?.setWriteEnabled(isWritable);
  }, [isWritable]);

  return (
    <div
      className="meridian-terminal-host"
      data-renderer={rendererMode ?? "pending"}
      data-write-enabled={isWritable ? "true" : "false"}
    >
      {emulator.status === "loaded" ? (
        <div
          className="meridian-terminal-host__surface"
          ref={hostElementRef}
          role="group"
          aria-label={surfaceName(props.label, writeGate)}
        />
      ) : (
        renderEmulatorAbsence(emulator)
      )}
    </div>
  );
}

/**
 * Hold the newest value where a long-lived consumer can read it, without making
 * that consumer depend on the value's identity.
 *
 * A `useLayoutEffect` rather than an assignment in the render body: a render pass
 * React discards must not be able to move what a live emulator will call, and a
 * layout effect runs on the commit that stuck and before the browser can deliver
 * the next keystroke. Local to this file on `apps/desktop/AGENTS.md`'s hoist-on-
 * the-second-use rule — the console has one consumer today, and the home for a
 * second one is `primitives/`.
 */
function useLatestRef<Value>(value: Value): { readonly current: Value } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** The adapter instance type, taken from the class the loader resolves. */
type XtermTerminalAdapterInstance = InstanceType<TerminalEmulatorModule["XtermTerminalAdapter"]>;

/**
 * What stands in the host box while the emulator's code is not there.
 *
 * Two of `Nothing`'s five kinds, and the two the states actually are: a fetch in
 * flight is `not-loaded` — the skeleton that says nothing, because there is nothing
 * yet to say — and a fetch that refused is `error`. Neither is `empty`, which would
 * claim the shell printed nothing, and neither is `not-checked`, which would claim
 * nobody asked.
 *
 * The refused arm renders the refusal's own two halves, which is the shape
 * `browser/settings/PartitionTable.tsx` already gives a surface that could not be
 * read: rule 9 puts the code on screen because a code is what a person acts on, and
 * the sentence beneath it is whatever the producing side wrote — never a
 * serialization of the rejected value, which `core/wire-rejection.ts` is the one
 * place allowed to decide.
 */
function renderEmulatorAbsence(
  emulator: Exclude<TerminalEmulatorState, { status: "loaded" }>,
): React.JSX.Element {
  return emulator.status === "loading" ? (
    <Nothing kind="not-loaded" placement="surface" title="Loading the terminal emulator" />
  ) : (
    <Nothing
      kind="error"
      placement="surface"
      title={emulator.refusal.code}
      detail={emulator.refusal.detail}
    />
  );
}

/**
 * Whether this surface may be typed into, and when it may not, why.
 *
 * Two conditions and not one. The lease says whether this participant is ALLOWED
 * to write; `onKeystroke` says whether there is anywhere for a keystroke to GO.
 * A surface built without the writer — which is what the pane mounts today, and
 * what a re-render across a terminal id already exercises — opened xterm's stdin
 * on the lease alone, so the emulator accepted every character, the adapter's
 * `onData` subscription did not exist to forward it, and the region announced
 * itself writable while the shell heard nothing. A gate is only a gate if it
 * covers the whole path.
 *
 * The set is declared as the table that RENDERS it, rather than as a tuple beside
 * a record: the suffix a gate carries is what distinguishes it on screen, so the
 * two cannot be allowed to drift, and a fourth gate is a compile error here rather
 * than a name that silently reads like one of these three.
 *
 * `Spec-023 §Console Design (Meridian)` 8.8 requires a non-holder to get "the live
 * output in a read-only watch mode with the input area absent rather than
 * disabled". A disabled input announces itself as a control that exists and cannot
 * be used, which is a different and worse claim than "you are watching" — so the
 * state reaches assistive technology through the region's own name instead.
 *
 * The third name is not a variant of the second: "you do not hold the shell" and
 * "this build has nowhere to send what you type" send a person to two different
 * places, and collapsing them would have them wait for a lease they already hold.
 */
const SURFACE_NAME_SUFFIXES = {
  writable: "",
  "lease-not-held": ", read-only",
  "no-input-channel": ", read-only: no input channel",
} as const;

type TerminalWriteGate = keyof typeof SURFACE_NAME_SUFFIXES;

function terminalWriteGate(isWriteEnabled: boolean, canWriteToWire: boolean): TerminalWriteGate {
  if (!isWriteEnabled) {
    // First, because it is the state 8.8 names and the one a person is in most of
    // the time: somebody else holds the shell, and no input channel would change
    // that.
    return "lease-not-held";
  }
  return canWriteToWire ? "writable" : "no-input-channel";
}

/** The surface's accessible name, which carries the write gate. */
function surfaceName(surfaceLabel: string, writeGate: TerminalWriteGate): string {
  return `${surfaceLabel}${SURFACE_NAME_SUFFIXES[writeGate]}`;
}
