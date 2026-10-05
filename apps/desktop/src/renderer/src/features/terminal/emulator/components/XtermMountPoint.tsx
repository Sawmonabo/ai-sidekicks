// The emulator's mount point: a DOM box and the lifetime of one `XtermTerminalAdapter` against it.
// The emulator's code arrives a commit after the mount (`emulator-loader.ts`), so the box reads
// `Loading the terminal…` until it lands, or `Could not load the terminal` with `Retry`. This
// component names the region and leaves the live text to xterm's own `aria-live` region, since
// announcing the grid again would read every cell twice.

import { useEffect, useRef, useState } from "react";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
import { terminalEmulatorLoader, type TerminalEmulatorModule } from "../emulator-loader.js";
import { useTerminalEmulator, type TerminalEmulatorState } from "../hooks/useTerminalEmulator.js";
import type { TerminalRendererMode } from "../xterm/adapter.js";

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
  // A terminal takes typing only while the lease allows it and a keystroke has somewhere to go.
  const isWritable = isWriteEnabled && canWriteToWire;
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
          aria-label={isWritable ? props.label : `${props.label}, read-only`}
        />
      ) : (
        renderEmulatorAbsence(emulator)
      )}
    </div>
  );
}

/** The adapter instance type, taken from the class the loader resolves. */
type XtermTerminalAdapterInstance = InstanceType<TerminalEmulatorModule["XtermTerminalAdapter"]>;

/**
 * What stands in the box while the emulator's code is not there: one line while the fetch is in
 * flight, and one line naming the pane with `Retry` when it failed.
 */
function renderEmulatorAbsence(
  emulator: Exclude<TerminalEmulatorState, { status: "loaded" }>,
): React.JSX.Element {
  return emulator.status === "loading" ? (
    <Nothing kind="not-loaded" placement="block" title="Loading the terminal…" />
  ) : (
    <Nothing
      kind="error"
      placement="block"
      title="Could not load the terminal"
      action={
        <button
          type="button"
          className={
            "meridian-action-button meridian-action-button--small " +
            "meridian-action-button--outline"
          }
          onClick={emulator.retry}
        >
          Retry
        </button>
      }
    />
  );
}
