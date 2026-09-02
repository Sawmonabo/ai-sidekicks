// The emulator's mount point, and nothing else.
//
// The component's whole job is to own a DOM box and the lifetime of one
// `XtermTerminalAdapter` against it. Everything a terminal DOES — the buffer, the
// renderer, the addons, the write gate — belongs to that class, so this file has
// no branch a reviewer has to trace: an effect attaches on mount, detaches on
// unmount, and a second effect forwards the write gate.
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
import { XtermTerminalAdapter, type TerminalRendererMode } from "./xterm-adapter.js";

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
  const adapterRef = useRef<XtermTerminalAdapter | undefined>(undefined);
  const [rendererMode, setRendererMode] = useState<TerminalRendererMode | undefined>(undefined);

  const { terminalId, isWriteEnabled, onKeystroke, onActivateLink, onRendererMode } = props;

  useEffect(() => {
    const hostElement = hostElementRef.current;
    if (hostElement === null) {
      return undefined;
    }
    const adapter = new XtermTerminalAdapter({
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
  }, [terminalId, onKeystroke, onActivateLink, onRendererMode]);

  // Separate from the mount effect on purpose: the lease changes far more often
  // than the pane mounts, and folding the two would tear down an emulator every
  // time the shell changed hands.
  useEffect(() => {
    adapterRef.current?.setWriteEnabled(isWriteEnabled);
  }, [isWriteEnabled]);

  return (
    <div
      className="meridian-terminal-host"
      data-renderer={rendererMode ?? "pending"}
      data-write-enabled={isWriteEnabled ? "true" : "false"}
    >
      <div
        className="meridian-terminal-host__surface"
        ref={hostElementRef}
        role="group"
        aria-label={label(props.label, isWriteEnabled)}
      />
    </div>
  );
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
