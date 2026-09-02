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
// WHY THE ADAPTER IS BUILT IN AN EFFECT AND NOT IN THE RENDER BODY. React may
// discard a render pass, and an adapter constructed during one would be an
// emulator — with a pooled WebGL context — that nothing will ever dispose. An
// effect runs only for a commit that stuck, and its cleanup is the only place the
// construction can be paired with the disposal. The one extra render that costs is
// paid once per mount and buys a teardown that cannot leak a context.
//
// WHY THE HOST BOX IS `aria-hidden` AND THE LIVE TEXT IS NOT HERE. xterm.js draws
// a grid of spans (or a WebGL canvas), and its own accessibility layer exposes rows
// through an `aria-live="assertive"` region with a twenty-row flood guard. That
// region is the terminal's; announcing the grid a second time from outside it would
// read every cell twice. So this component names the region and lets the emulator
// own what is inside it.

import { useEffect, useRef, useState } from "react";

import { Nothing } from "../primitives/index.js";
import {
  terminalEmulatorLoader,
  type TerminalEmulatorLoader,
  type TerminalEmulatorModule,
} from "./emulator-loader.js";
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
  /** Told which renderer the instance settled on, so a surface can report it. */
  readonly onRendererMode?: ((mode: TerminalRendererMode) => void) | undefined;
}

export function XtermHost(props: XtermHostProps): React.JSX.Element {
  const hostElementRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<XtermTerminalAdapterInstance | undefined>(undefined);
  const [rendererMode, setRendererMode] = useState<TerminalRendererMode | undefined>(undefined);
  const emulator = useTerminalEmulator(terminalEmulatorLoader);

  const { terminalId, isWriteEnabled, onKeystroke, onActivateLink, onRendererMode } = props;

  useEffect(() => {
    const hostElement = hostElementRef.current;
    if (emulator.status !== "loaded" || hostElement === null) {
      // Nothing to pair a disposal with yet: the box below is the absence, not the
      // surface, so there is no element for an emulator to open against.
      return undefined;
    }
    const adapter = new emulator.module.XtermTerminalAdapter({
      terminalId,
      onKeystroke,
      onActivateLink,
    });
    adapterRef.current = adapter;
    adapter.attach(hostElement);
    setRendererMode(adapter.rendererMode);
    onRendererMode?.(adapter.rendererMode);
    return () => {
      adapterRef.current = undefined;
      // Final, not `detach()`. The pane is going away, so the emulator's pooled
      // renderer slot has to go back — a detach would keep the instance alive for
      // a remount that is never coming.
      adapter.dispose();
    };
  }, [emulator, terminalId, onKeystroke, onActivateLink, onRendererMode]);

  // Separate from the mount effect on purpose: the lease changes far more often
  // than the pane mounts, and folding the two would tear down an emulator every
  // time the shell changed hands. It re-runs when the EMULATOR moves as well as
  // when the gate does, because the adapter is built on a later commit than the
  // one that first carried the lease — an emulator that arrived while the lease
  // already said `true` would otherwise start closed and stay closed until the
  // next transition.
  useEffect(() => {
    adapterRef.current?.setWriteEnabled(isWriteEnabled);
  }, [isWriteEnabled, emulator]);

  return (
    <div
      className="meridian-terminal-host"
      data-renderer={rendererMode ?? "pending"}
      data-write-enabled={isWriteEnabled ? "true" : "false"}
    >
      {emulator.status === "loaded" ? (
        <div
          className="meridian-terminal-host__surface"
          ref={hostElementRef}
          role="group"
          aria-label={label(props.label, isWriteEnabled)}
        />
      ) : (
        renderEmulatorAbsence(emulator)
      )}
    </div>
  );
}

/** The adapter instance type, taken from the class the loader resolves. */
type XtermTerminalAdapterInstance = InstanceType<TerminalEmulatorModule["XtermTerminalAdapter"]>;

/** Where the emulator's code is: still coming, here, or refused. */
type TerminalEmulatorState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: TerminalEmulatorModule }
  | { readonly status: "failed"; readonly reason: string };

const LOADING_EMULATOR: TerminalEmulatorState = { status: "loading" };

/**
 * What stands in the host box while the emulator's code is not there.
 *
 * Two of `Nothing`'s five kinds, and the two the states actually are: a fetch in
 * flight is `not-loaded` — the skeleton that says nothing, because there is nothing
 * yet to say — and a fetch that refused is `error`, carrying the reason verbatim
 * rather than a sentence this file wrote. Neither is `empty`, which would claim the
 * shell printed nothing, and neither is `not-checked`, which would claim nobody
 * asked.
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
      title="The terminal emulator could not be loaded."
      detail={emulator.reason}
    />
  );
}

/**
 * Fetch the emulator's chunk and say where it got to.
 *
 * A hook rather than a call in the render body, on `apps/desktop/AGENTS.md`'s rule
 * and for a concrete reason: `import()` is a side effect, and a render body that
 * started one would start a second on every discarded pass.
 *
 * UNMOUNT BEFORE THE CHUNK ARRIVES is the arm worth naming. A pane opened and
 * closed inside one fetch leaves a promise still in flight over a component React
 * has already dropped, and settling it into state would be a write against a
 * disposed host. The flag below is read on both arms, so a late resolution and a
 * late rejection are each ignored rather than one of them handled — and the memo
 * inside the loader means the fetch itself is not wasted: the next mount gets the
 * chunk this one paid for.
 */
function useTerminalEmulator(loader: TerminalEmulatorLoader): TerminalEmulatorState {
  const [emulator, setEmulator] = useState<TerminalEmulatorState>(LOADING_EMULATOR);

  useEffect(() => {
    let isMounted = true;
    loader.load().then(
      (module) => {
        if (isMounted) {
          setEmulator({ status: "loaded", module });
        }
      },
      (loadError: unknown) => {
        if (isMounted) {
          setEmulator({
            status: "failed",
            reason: loadError instanceof Error ? loadError.message : String(loadError),
          });
        }
      },
    );
    return () => {
      isMounted = false;
    };
  }, [loader]);

  return emulator;
}

/**
 * The surface's accessible name, which carries the write gate.
 *
 * `Spec-023 §Console Design (Meridian)` 8.8 requires a non-holder to get "the live
 * output in a read-only watch mode with the input area absent rather than
 * disabled". A disabled input announces itself as a control that exists and cannot
 * be used, which is a different and worse claim than "you are watching" — so the
 * state reaches assistive technology through the region's own name instead.
 */
function label(surfaceLabel: string, isWriteEnabled: boolean): string {
  return isWriteEnabled ? surfaceLabel : `${surfaceLabel}, read-only`;
}
