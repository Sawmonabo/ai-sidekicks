// The emulator's mount point: a DOM box and the lifetime of one `XtermTerminalAdapter` against it.
// The emulator's code arrives a commit after the mount (`emulator-loader.ts`), so the box shows a
// `not-loaded` absence until it lands. This component names the region and leaves the live text
// to xterm's own `aria-live` region, since announcing the grid again would read every cell twice.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { terminalEmulatorLoader, type TerminalEmulatorModule } from "../emulator-loader.js";
import { useTerminalEmulator, type TerminalEmulatorState } from "../hooks/useTerminalEmulator.js";
import type { TerminalRendererMode } from "../xterm-adapter.js";

/** Props for the emulator's box: which terminal, the write gate, and the callbacks to forward. */
export interface XtermMountPointProps {
  /** The shared terminal this emulator shows. One per session. */
  readonly terminalId: string;
  /** Whether the lease says this user may type. Watch mode is `false`. */
  readonly isWriteEnabled: boolean;
  /** The terminal region's accessible name, supplied by the pane that mounted it. */
  readonly label: string;
  /** Where keystrokes go. Absent means this terminal never writes to the wire. */
  readonly onKeystroke?: ((data: string) => void) | undefined;
  /** Where an allowed link goes. Absent means links render and never activate. */
  readonly onActivateLink?: ((url: string) => void) | undefined;
  /**
   * Told which renderer the instance settled on, and again on every change: a lost WebGL
   * context falls the instance back to the DOM renderer for good.
   */
  readonly onRendererMode?: ((mode: TerminalRendererMode) => void) | undefined;
}

/** The emulator's box for one terminal, with a region name that carries the write gate. */
export function XtermMountPoint(props: XtermMountPointProps): React.JSX.Element {
  const mountElementRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<XtermTerminalAdapterInstance | undefined>(undefined);
  const [rendererMode, setRendererMode] = useState<TerminalRendererMode | undefined>(undefined);
  const emulator = useTerminalEmulator(terminalEmulatorLoader);

  const { terminalId, isWriteEnabled, onKeystroke, onActivateLink, onRendererMode } = props;
  const callbacksRef = useLatestRef({ onKeystroke, onActivateLink, onRendererMode });
  // Callbacks live in `callbacksRef`, so a parent's fresh function identities do not rebuild
  // the emulator and drop its scrollback. What the terminal can do is what rebuilds it: gaining
  // or losing a capability does, a fresh function for an existing one does not.
  const canWriteToWire = onKeystroke !== undefined;
  const canActivateLinks = onActivateLink !== undefined;
  const writeGate = terminalWriteGate(isWriteEnabled, canWriteToWire);
  const isWritable = writeGate === "writable";
  // The lease as the mount effect sees it, so the write gate has one mutator: a replaced
  // adapter is built with this answer, and `setWriteEnabled` moves it only when the lease
  // moves. Applying the gate only from the lease effect left a fresh binding shut while the
  // box read `data-write-enabled="true"`.
  const isWritableRef = useLatestRef(isWritable);

  useEffect(() => {
    const mountElement = mountElementRef.current;
    if (emulator.status !== "loaded" || mountElement === null) {
      // No mount element yet, so there is nothing to pair a disposal with.
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
    // One guard around every step that can leave an emulator behind: React pairs a disposal
    // only with the cleanup this effect returns. `subscribeToRendererMode` delivers the mode
    // synchronously, so a throwing `onRendererMode` would escape before the cleanup existed
    // and leak the emulator and its renderer allocation. Dispose and re-raise.
    try {
      adapter.attach(mountElement);
      // After the attach, so the settled mode is reported once. Later deliveries are context
      // losses, which arrive asynchronously.
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
      // Before the disposal, so its mode reset is not delivered into a tree React is dropping.
      unsubscribeFromRendererMode?.();
      // Final, not `detach()`: the pane is going away, so the renderer hold must go back.
      adapter.dispose();
    };
  }, [emulator, terminalId, canWriteToWire, canActivateLinks, callbacksRef, isWritableRef]);

  // Separate from the mount effect because the lease changes far more often than the pane
  // mounts. It watches the lease only and is the write gate's one mutator.
  useEffect(() => {
    adapterRef.current?.setWriteEnabled(isWritable);
  }, [isWritable]);

  return (
    <div
      className="meridian-terminal-mount-point"
      data-renderer={rendererMode ?? "pending"}
      data-write-enabled={isWritable ? "true" : "false"}
    >
      {emulator.status === "loaded" ? (
        <div
          className="meridian-terminal-mount-point__mount-element"
          ref={mountElementRef}
          role="group"
          aria-label={accessibleNameFor(props.label, writeGate)}
        />
      ) : (
        renderEmulatorAbsence(emulator)
      )}
    </div>
  );
}

/**
 * Hold the newest value where a long-lived consumer can read it without depending on its
 * identity. Written in a layout effect, not the render body, so a discarded render cannot
 * move what a live emulator calls.
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
 * What stands in the box while the emulator's code is not there: `not-loaded` while the fetch
 * is in flight, `error` with the refusal's code and detail when it refused. Not `empty` or
 * `not-checked`, which would make claims about the shell or the session.
 */
function renderEmulatorAbsence(
  emulator: Exclude<TerminalEmulatorState, { status: "loaded" }>,
): React.JSX.Element {
  return emulator.status === "loading" ? (
    <Nothing kind="not-loaded" placement="block" title="Loading the terminal emulator" />
  ) : (
    <Nothing
      kind="error"
      placement="block"
      title={emulator.refusal.code}
      detail={emulator.refusal.detail}
    />
  );
}

/**
 * Accessible-name suffix for each write gate, and so the set of gates. A terminal may be typed
 * into only when the lease allows it AND `onKeystroke` gives a keystroke somewhere to go; the
 * lease alone left the emulator accepting input that nothing forwarded. A watcher gets
 * read-only watch mode with the input absent rather than disabled, and the state reaches
 * assistive technology through the region's name. "Lease not held" and "no input channel" stay
 * separate because they send a person to different places. Being a table, a fourth gate is a
 * compile error.
 */
const ACCESSIBLE_NAME_SUFFIXES = {
  writable: "",
  "lease-not-held": ", read-only",
  "no-input-channel": ", read-only: no input channel",
} as const;

type TerminalWriteGate = keyof typeof ACCESSIBLE_NAME_SUFFIXES;

function terminalWriteGate(isWriteEnabled: boolean, canWriteToWire: boolean): TerminalWriteGate {
  if (!isWriteEnabled) {
    // First, because it is the state a person is usually in; no input channel would not change it.
    return "lease-not-held";
  }
  return canWriteToWire ? "writable" : "no-input-channel";
}

/** The terminal region's accessible name, which carries the write gate. */
function accessibleNameFor(label: string, writeGate: TerminalWriteGate): string {
  return `${label}${ACCESSIBLE_NAME_SUFFIXES[writeGate]}`;
}
