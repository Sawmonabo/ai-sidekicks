// The keystroke factory and the handback builder every case in this seam drives.
//
// One home for both, because the two production modules are two halves of one
// question and their suites pose the same keystroke to each: a descriptor factory
// written twice would drift on the field a case forgot to set, and that field is
// exactly where a claim rule goes one modifier too wide.

import type { ChordPlatform } from "../../../primitives/index.js";
import { type ChordDescriptor } from "./chord-claim.js";
import { KeyboardHandback } from "./keyboard-handback.js";

/** One keystroke, in the fields a claim reads, with meta-K as the unmodified default. */
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
 * A handback over a fixed chord set. `darwin` by default because meta is the modifier
 * every case reaches for; the platform cases name theirs.
 */
export function handbackOver(
  installed: readonly string[] | undefined,
  platform: ChordPlatform = "darwin",
): KeyboardHandback {
  return new KeyboardHandback({ readInstalledChords: () => installed, platform });
}

/** A focusable pane root that is actually in the document, which `replay` requires. */
export function attachedPaneRoot(): HTMLElement {
  const root = document.createElement("div");
  root.tabIndex = -1;
  document.body.append(root);
  return root;
}
