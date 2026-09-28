// Watching the composer's own line, without owning a second copy of it.
//
// The discovery surface opens on a leading slash in the message input. That input is
// the send bar's — its text is the send controller's single source of truth, and the
// controller is what clears it, walks its history, and locks it while a dispatch is
// in flight. A popover that held its own copy would be a second answer to "what is in
// the line", and the two would disagree the first time either side changed it.
//
// So this hook OBSERVES rather than owns: it reads the composer's draft and never
// writes to it. `use-composer-draft-text.ts` is the shape for exactly that — the snapshot
// is the value, and a value read between render and subscription is not missed the
// way an effect-written state would miss it.
//
// AND WHAT IT OBSERVES IS THE DRAFT STORE, NOT THE DOM. It used to subscribe to the
// line element's native `input` event, which fires for typing and for nothing else.
// The controlled line's value comes from the draft store, and several composer paths
// write there without a keystroke: ArrowUp history recall replaces the draft, a send
// clears it, and a command run by clicking the button clears it too. Each of those
// left this surface reading a value the line no longer held — a recalled slash
// command with the list still shut, a recalled ordinary line with a stale popover
// standing over it, and a cleared line with the popover for the command that had
// just run. The store is the one source every path writes through and it notifies
// per draft key, so subscribing there covers all of them and leaves NO path needing
// a DOM event beside it: the line is `value`-controlled from this same store, so its
// displayed text cannot change without a write the store announces. The listener the
// hook still installs is for KEYS, which the store knows nothing about.
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

import { useCallback, useEffect, useRef, useState } from "react";

import type { DraftStore } from "../../../console/persistence/index.js";
import { readDirectiveName } from "../directive-syntax.js";
import { useComposerDraftText } from "../use-composer-draft-text.js";

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

/** Where the composer's unsent body lives, and under which address. */
export interface DirectiveLineSource {
  /** The window-lifetime store the composer seat is handed. */
  readonly draftStore: DraftStore;
  /** This composer's address key, so the surface watches its own line. */
  readonly draftKey: string;
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
  source: DirectiveLineSource,
): DirectiveLineDiscovery {
  const { draftStore, draftKey } = source;
  // The same reading the send bar takes of the same key, through the same hook.
  const { text: lineText, read: readLineText } = useComposerDraftText(draftStore, draftKey);

  const [dismissedAtText, setDismissedAtText] = useState<string | undefined>(undefined);
  const [stepIntoListToken, setStepIntoListToken] = useState(0);

  const typedPrefix = readDirectiveName(lineText);
  const isOpen = typedPrefix !== undefined && dismissedAtText !== lineText;

  const dismiss = useCallback(() => {
    const element = region.current;
    const line = lineElementWithin(element);
    // Keyed on the same reading the open decision is made from, so a dismissal and
    // the text it was raised at can never be two different strings.
    setDismissedAtText(readLineText());
    // Focus follows the surface that closed. A list dismissed while it held focus
    // would otherwise drop focus onto the document body, which leaves a keyboard
    // reader nowhere — and the place they were is the line they were typing in.
    if (line !== null && element !== null && element.contains(document.activeElement)) {
      line.focus();
    }
  }, [region, readLineText]);

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
