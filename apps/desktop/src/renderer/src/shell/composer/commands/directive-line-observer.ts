// Watching the composer's own line, without owning a second copy of it.
//
// The discovery surface opens on a leading slash in the message input. That input is
// the send bar's — its text is the send controller's single source of truth, and the
// controller is what clears it, walks its history, and locks it while a dispatch is
// in flight. A popover that held its own copy would be a second answer to "what is in
// the line", and the two would disagree the first time either side changed it.
//
// So this hook OBSERVES rather than owns: it reads the line element's own value on
// the events that change it and never writes to it. `useSyncExternalStore` is the
// shape for exactly that — the DOM is the store, the snapshot is the value, and a
// value read between render and subscription is not missed the way an effect-written
// state would miss it.
//
// THREE KEYS PRESSED IN THE LINE ARE THIS SURFACE'S AND THE REST ARE THE LINE'S.
// Escape dismisses the popover; ArrowDown steps into the list; Enter belongs to Send
// and is treated as a dismissal so a sent line never leaves a popover standing over a
// cleared input. Only the first two stop propagating — Enter is passed straight
// through, because a discovery surface that swallowed Send would be a discovery
// surface that broke the composer. And all three are scoped to keystrokes whose
// target IS the line: the listener sits on the region because that is the node this
// zone was handed, and a region-wide arrow interception would swallow the keys of the
// list it just opened.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { readDiscoveryPrefix } from "./provider-command-catalog.js";

/** What the composer's line is currently asking the discovery surface for. */
export interface DirectiveLineDiscovery {
  /** The typed name after the trigger, or `undefined` while the surface is closed. */
  readonly prefix: string | undefined;
  /** Bumped when the person asks the list to take the arrow keys. */
  readonly stepIntoListToken: number;
  /** Close the surface for the text now in the line. */
  readonly dismiss: () => void;
}

/** The line the composer region holds, or `undefined` when it holds none. */
function lineElementWithin(region: HTMLElement | null): HTMLTextAreaElement | null {
  return region?.querySelector("textarea") ?? null;
}

/**
 * Read the composer's line and decide what it opens.
 *
 * The dismissal is keyed on the TEXT it was raised at rather than on a boolean, so it
 * lifts by itself the moment the person types anything else — including the moment a
 * send clears the line. A boolean would need someone to remember to clear it, and the
 * arm nobody remembers is the one a person meets.
 */
export function useDirectiveLineDiscovery(
  region: React.RefObject<HTMLElement | null>,
): DirectiveLineDiscovery {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const element = region.current;
      if (element === null) {
        return () => undefined;
      }
      element.addEventListener("input", onStoreChange);
      return () => {
        element.removeEventListener("input", onStoreChange);
      };
    },
    [region],
  );
  const readLineText = useCallback(() => lineElementWithin(region.current)?.value ?? "", [region]);
  const lineText = useSyncExternalStore(subscribe, readLineText, readLineText);

  const [dismissedAtText, setDismissedAtText] = useState<string | undefined>(undefined);
  const [stepIntoListToken, setStepIntoListToken] = useState(0);

  const typedPrefix = readDiscoveryPrefix(lineText);
  const isOpen = typedPrefix !== undefined && dismissedAtText !== lineText;

  const dismiss = useCallback(() => {
    const element = region.current;
    const line = lineElementWithin(element);
    setDismissedAtText(line?.value ?? "");
    // Focus follows the surface that closed. A list dismissed while it held focus
    // would otherwise drop focus onto the document body, which leaves a keyboard
    // reader nowhere — and the place they were is the line they were typing in.
    if (line !== null && element !== null && element.contains(document.activeElement)) {
      line.focus();
    }
  }, [region]);

  // The three keys, read through a ref so the listener installed once never evaluates
  // a stale open state.
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  useEffect(() => {
    const element = region.current;
    if (element === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // The LINE's keys only. The listener is on the region because that is the one
      // node this zone was handed, but the popover mounted inside that region owns
      // its own arrows — and a listener that stopped them here would swallow the
      // keystrokes of the list it exists to open.
      if (event.target !== lineElementWithin(element)) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        // Not stopped and not prevented: Send is the send bar's and stays its.
        setDismissedAtText(readLineText());
        return;
      }
      if (!isOpenRef.current) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAtText(readLineText());
        return;
      }
      if (event.key === "ArrowDown") {
        // Stopped as well as prevented, so the line's own history walk does not also
        // fire on the keystroke that stepped into the list.
        event.preventDefault();
        event.stopPropagation();
        setStepIntoListToken((token) => token + 1);
      }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [region, readLineText]);

  return {
    prefix: isOpen ? typedPrefix : undefined,
    stepIntoListToken,
    dismiss,
  };
}
