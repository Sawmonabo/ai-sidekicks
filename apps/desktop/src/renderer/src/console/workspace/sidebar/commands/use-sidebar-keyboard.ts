// React's one lifecycle around the sidebar's chord table: install it, take it down.
//
// A LIFECYCLE, NOT A DERIVATION. The keyboard is constructed once per model and its
// listener is attached once and detached on unmount. A render body does none of it,
// which is what lets React discard a pass without leaving a listener behind.

import { useEffect, useMemo, useRef } from "react";

import { type SidebarSectionId } from "../../../seats/index.js";
import { type SidebarModel } from "../model/sidebar-model.js";
import { SidebarKeyboard, type SidebarCommandTargets } from "./sidebar-keyboard.js";

/**
 * Install the sidebar's chords on its own element, and take them down with it.
 *
 * Returns the keyboard so a caller can print a chord beside the act it fires;
 * `chordFor` reads the same table that dispatches, so a hint can never name a chord
 * that would not fire.
 */
export function useSidebarKeyboard(
  model: SidebarModel,
  targets: SidebarCommandTargets,
  columnReference: React.RefObject<HTMLElement | null>,
): SidebarKeyboard {
  // The targets object is rebuilt every render by any ordinary caller, and the keyboard
  // must not be: rebuilding it would tear down and re-install the listener on every
  // pass. A ref carries the live callbacks into commands that were built once.
  const targetsReference = useRef(targets);
  targetsReference.current = targets;
  const keyboard = useMemo(
    () =>
      new SidebarKeyboard(model, {
        openPane: (address) => {
          targetsReference.current.openPane(address);
        },
        focusSection: (sectionId: SidebarSectionId) => {
          targetsReference.current.focusSection(sectionId);
        },
      }),
    [model],
  );
  useEffect(() => {
    const column = columnReference.current;
    if (column !== null) {
      keyboard.install(column);
    }
    return () => {
      keyboard.dispose();
    };
  }, [keyboard, columnReference]);
  return keyboard;
}
