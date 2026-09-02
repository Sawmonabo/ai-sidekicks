// React's view of the sidebar: one subscription, one lifecycle, and nothing else.
//
// The pattern is `store/hooks.ts`'s and is followed rather than re-derived — a
// component subscribes through `useSyncExternalStore` and never reaches into the
// state it is reading. What differs is only the source: `SidebarModel` is the
// sidebar's own state rather than a wire projection, so it has its own emitter
// instead of a zustand store, and these three hooks are the whole of the bridge
// between the two.
//
// EVERY EFFECT HERE IS A LIFECYCLE, NOT A DERIVATION. The model is constructed
// once per session, the durable restore fires once, and the keyboard is installed
// once and detached on unmount. A render body does none of it, which is what lets
// React discard a pass without leaving a listener behind.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { type UiStateStore } from "../../persistence/index.js";
import { type SidebarSectionId } from "../../seats/index.js";
import { SidebarKeyboard, type SidebarCommandTargets } from "./sidebar-commands.js";
import { SidebarModel, type SidebarSnapshot } from "./sidebar-model.js";

/**
 * The model for one session, restored from the durable store exactly once.
 *
 * Re-created when the session changes, because the collapsed set is written under
 * the session's partition and a model carried across a session switch would show
 * the previous session's shape and then write it back under the new session's key.
 */
export function useSidebarModel(
  sessionId: string,
  uiStateStore: UiStateStore | undefined,
): SidebarModel {
  const model = useMemo(
    () =>
      new SidebarModel(uiStateStore === undefined ? { sessionId } : { sessionId, uiStateStore }),
    [sessionId, uiStateStore],
  );
  useEffect(() => {
    // `restore` is documented never to throw, so there is no arm to handle here
    // and a `catch` would be a claim that one exists.
    void model.restore();
  }, [model]);
  return model;
}

/** What the model currently holds. The one subscription a component makes. */
export function useSidebarSnapshot(model: SidebarModel): SidebarSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => model.subscribe(onStoreChange),
    [model],
  );
  const read = useCallback(() => model.snapshot, [model]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Install the sidebar's chords on its own element, and take them down with it.
 *
 * Returns the keyboard so a caller can print a chord beside the act it fires;
 * `chordFor` reads the same table that dispatches, so a hint can never name a
 * chord that would not fire.
 */
export function useSidebarKeyboard(
  model: SidebarModel,
  targets: SidebarCommandTargets,
  containerRef: React.RefObject<HTMLElement | null>,
): SidebarKeyboard {
  // The targets object is rebuilt every render by any ordinary caller, and the
  // keyboard must not be: rebuilding it would tear down and re-install the
  // listener on every pass. A ref carries the live callbacks into commands that
  // were built once.
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const keyboard = useMemo(
    () =>
      new SidebarKeyboard(model, {
        openPane: (address) => {
          targetsRef.current.openPane(address);
        },
        focusSection: (id: SidebarSectionId) => {
          targetsRef.current.focusSection(id);
        },
      }),
    [model],
  );
  useEffect(() => {
    const container = containerRef.current;
    if (container !== null) {
      keyboard.install(container);
    }
    return () => {
      keyboard.dispose();
    };
  }, [keyboard, containerRef]);
  return keyboard;
}
