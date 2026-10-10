// Keys as the system sends them, straight to the page through the browser's protocol, so a case
// presses a real key rather than a script's event. A keydown on macOS carries the editing command
// the key binds to, which is how macOS acts on a key.

import { cdp } from "vitest/browser";

import { HOST_CHORD_PLATFORM, PLATFORM_MODIFIER_TOKEN } from "#renderer/lib/chord-format.js";

/** The bits of a protocol key event's modifiers, by the name the app's chords spell them. */
const MODIFIER = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
/** Whether this host is macOS, as the app reads it, whose keydowns carry their editing command. */
const IS_MACOS = HOST_CHORD_PLATFORM === "darwin";
/** The modifier the system's shortcuts hold, as the app's chords resolve it on this host. */
const SHORTCUT_MODIFIER = MODIFIER[PLATFORM_MODIFIER_TOKEN[HOST_CHORD_PLATFORM]];
/**
 * The modifier the system's own word step holds: Option on macOS, Control elsewhere. A fact of the
 * system, not read from the app's tables, so a case pressing it checks the table the app picked.
 */
const WORD_MODIFIER = IS_MACOS ? MODIFIER.Alt : MODIFIER.Control;

/** A key as the system sends it, and the editing command macOS's key bindings name for it. */
export interface SystemKey {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly modifiers: number;
  readonly macCommand: string;
}

/** Shift and the right arrow: the selection's focus one character on. */
export const SHIFT_ARROW_RIGHT: SystemKey = {
  key: "ArrowRight",
  code: "ArrowRight",
  keyCode: 39,
  modifiers: MODIFIER.Shift,
  macCommand: "moveRightAndModifySelection",
};

/**
 * The system's word step with Shift and the right arrow, Option on macOS and Control elsewhere: the
 * selection's focus a word on.
 */
export const SHIFT_WORD_RIGHT: SystemKey = {
  key: "ArrowRight",
  code: "ArrowRight",
  keyCode: 39,
  modifiers: WORD_MODIFIER | MODIFIER.Shift,
  macCommand: "moveWordRightAndModifySelection",
};

/** Shift and Page Down: the selection's focus a page on. */
export const SHIFT_PAGE_DOWN: SystemKey = {
  key: "PageDown",
  code: "PageDown",
  keyCode: 34,
  modifiers: MODIFIER.Shift,
  macCommand: "pageDownAndModifySelection",
};

/** The system's Select All shortcut. */
export const SELECT_ALL: SystemKey = {
  key: "a",
  code: "KeyA",
  keyCode: 65,
  modifiers: SHORTCUT_MODIFIER,
  macCommand: "selectAll",
};

/** The system's Copy shortcut. */
export const COPY: SystemKey = {
  key: "c",
  code: "KeyC",
  keyCode: 67,
  modifiers: SHORTCUT_MODIFIER,
  macCommand: "copy",
};

/** One of `key`'s events as the system sends it, a repeat flagged as one. */
export async function sendKey(
  key: SystemKey,
  type: "rawKeyDown" | "keyUp",
  isRepeat = false,
): Promise<void> {
  await cdp().send("Input.dispatchKeyEvent", {
    type,
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers: key.modifiers,
    autoRepeat: isRepeat,
    commands: type === "rawKeyDown" && IS_MACOS ? [key.macCommand] : [],
  });
}

/** Presses and releases `key`. */
export async function pressKey(key: SystemKey): Promise<void> {
  await sendKey(key, "rawKeyDown");
  await sendKey(key, "keyUp");
}
