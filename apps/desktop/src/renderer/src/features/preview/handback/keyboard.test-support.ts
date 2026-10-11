// The keystroke factory and handback builder every case in this seam drives, in one place so the
// suites cannot drift on the field a case forgot to set.

import { MAC_KEYBOARD_CONVENTION } from "#renderer/lib/chord/convention/mac.js";
import { type ChordDescriptor } from "./chord/claim.js";
import { KeyboardHandback } from "./keyboard.js";

/** One keystroke, in the fields a claim reads, defaulting to an unmodified K. */
export function chord(overrides: Partial<ChordDescriptor> = {}): ChordDescriptor {
  return {
    key: "k",
    code: "KeyK",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  };
}

/**
 * A handback over a fixed chord set, on the macOS keyboard because meta is the modifier every case
 * reaches for.
 */
export function handbackOver(installed: readonly string[] | undefined): KeyboardHandback {
  return new KeyboardHandback({
    readInstalledChords: () => installed,
    convention: MAC_KEYBOARD_CONVENTION,
  });
}

/** A focusable pane root that is actually in the document, which `forwardChord` requires. */
export function attachedPaneRoot(): HTMLElement {
  const root = document.createElement("div");
  root.tabIndex = -1;
  document.body.append(root);
  return root;
}
