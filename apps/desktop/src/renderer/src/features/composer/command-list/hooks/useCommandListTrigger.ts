// Watches the composer's draft to decide what the command list opens, without owning a copy of it.
// It observes the draft store, not the DOM: history recall, send and a button-run command all
// write the store without a keystroke. Keydown is for keys only, and only ones aimed at the line:
// Escape dismisses, ArrowDown steps into the list, and Enter (Send's) dismisses and passes on.

import { useCallback, useEffect, useRef, useState } from "react";

import type { DraftStore } from "@renderer/store/draft-store.js";
import { readSlashCommandName } from "../../slash-command-syntax.js";
import { useComposerDraftText } from "../../hooks/useComposerDraftText.js";

/** What the composer's line is currently asking the command list for. */
export interface CommandListTrigger {
  /** The typed name after the trigger, or `undefined` while the command list is closed. */
  readonly prefix: string | undefined;
  /** Bumped when the person asks the list to take the arrow keys. */
  readonly stepIntoListToken: number;
  /** Close the command list for the text now in the line. */
  readonly dismiss: () => void;
}

/** Where the composer's unsent body lives, and under which address. */
export interface DraftLineSource {
  /** The window-lifetime store the composer is handed. */
  readonly draftStore: DraftStore;
  /** This composer's address key, so the command list watches its own line. */
  readonly draftKey: string;
}

/**
 * Read the composer's line and decide what it opens. The dismissal is keyed on the text it was
 * raised at, not a boolean, so it lifts by itself once the text changes, including when a send
 * clears the line.
 */
export function useCommandListTrigger(
  region: React.RefObject<HTMLElement | null>,
  source: DraftLineSource,
): CommandListTrigger {
  const { draftStore, draftKey } = source;
  // The same reading the send bar takes of the same key, through the same hook.
  const { text: lineText, read: readLineText } = useComposerDraftText(draftStore, draftKey);

  const [dismissedAtText, setDismissedAtText] = useState<string | undefined>(undefined);
  const [stepIntoListToken, setStepIntoListToken] = useState(0);

  const typedPrefix = readSlashCommandName(lineText);
  const isOpen = typedPrefix !== undefined && dismissedAtText !== lineText;

  const dismiss = useCallback(() => {
    const element = region.current;
    const line = lineElementWithin(element);
    // Keyed on the same reading the open decision uses, so a dismissal and its text cannot differ.
    setDismissedAtText(readLineText());
    // Focus follows the closed list: otherwise it drops to the body and a keyboard reader has
    // nowhere.
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
      // The line's keys only: the popover inside this region owns its own arrows, and stopping
      // them here would swallow the list's keystrokes.
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

/** The line the composer region holds, or `undefined` when it holds none. */
function lineElementWithin(region: HTMLElement | null): HTMLTextAreaElement | null {
  return region?.querySelector("textarea") ?? null;
}
