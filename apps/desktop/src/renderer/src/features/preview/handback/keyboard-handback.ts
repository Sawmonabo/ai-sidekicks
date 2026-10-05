// The renderer's half of the keyboard handback: decides whether a keystroke seen inside a page
// belongs to the application, and forwards a claimed chord as a key event on the pane root.
// A chord is claimed only with control, meta or alt AND a matching chord in the mirror. The mirror
// lists which chords exist, never what they mean; an unreadable mirror leaves keys to the page.

import { refuse, type Refusal } from "#renderer/lib/refusal/refusal.js";
import { chordMatchesEvent, parseChord } from "#renderer/registries/keybindings/chord.js";
import {
  PLATFORM_MODIFIER_CHORD_TOKEN,
  PLATFORM_MODIFIER_TOKEN,
  type ChordPlatform,
} from "#renderer/lib/chord-format.js";
import {
  carriesApplicationModifier,
  projectClaimableChords,
  type ChordDescriptor,
} from "./chord/claim.js";

/** The subsystem name every refusal this module raises carries. */
export const KEYBOARD_HANDBACK_REFUSAL_ORIGIN = "preview-keyboard-handback";

/** Why a handback was refused. Closed, so a second reason is a decision. */
export const KEYBOARD_HANDBACK_REFUSAL_CODES = ["not-claimable", "pane-detached"] as const;

/** One of `KEYBOARD_HANDBACK_REFUSAL_CODES`. */
export type KeyboardHandbackRefusalCode = (typeof KEYBOARD_HANDBACK_REFUSAL_CODES)[number];

/** Why a keystroke was not claimed. Every arm leaves the keystroke with the page. */
export const HANDBACK_DECLINE_REASONS = [
  "composing",
  "no-application-modifier",
  "mirror-unreadable",
  "not-mirrored",
] as const;

/** One of `HANDBACK_DECLINE_REASONS`. */
export type HandbackDeclineReason = (typeof HANDBACK_DECLINE_REASONS)[number];

/** The claim decision. `claimed` is the only arm that takes a keystroke from a page. */
export type HandbackDecision =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly because: HandbackDeclineReason };

/** What a forward did. A refusal is rendered; it is never swallowed. */
export type ChordForwardOutcome =
  | { readonly status: "forwarded" }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** What a `KeyboardHandback` reads: the installed chords and the host platform. */
export interface KeyboardHandbackOptions {
  /**
   * The chords the console has installed, or `undefined` while the registry has not loaded.
   * `undefined` means nothing is claimed; an empty list would say the console has no chords.
   * The caller supplies them, so the module can be driven without a palette.
   */
  readonly readInstalledChords: () => readonly string[] | undefined;
  /**
   * The platform the keystrokes were raised on. A parameter, not a reading, so a fixture can
   * pin it and the decision comes out the same in a test, the renderer and the main process.
   */
  readonly platform: ChordPlatform;
}

/**
 * The renderer's half of the handback. `forwardCount` lets a test assert that a forward happened
 * rather than trust that a dispatched event was delivered.
 */
export class KeyboardHandback {
  readonly #readInstalledChords: () => readonly string[] | undefined;
  readonly #platform: ChordPlatform;
  #forwardCount = 0;

  public constructor(options: KeyboardHandbackOptions) {
    this.#readInstalledChords = options.readInstalledChords;
    this.#platform = options.platform;
  }

  /**
   * The mirror a main-process listener is built from, or `undefined` before the registry loads.
   * Projected on every read and never cached, because rebinding a key changes the set.
   */
  public mirrorChords(): readonly string[] | undefined {
    const installed = this.#readInstalledChords();
    return installed === undefined ? undefined : projectClaimableChords(installed);
  }

  /** How many chords were forwarded into the window. */
  public get forwardCount(): number {
    return this.#forwardCount;
  }

  /** Whether the application claims this keystroke from the page, and if not, why. */
  public decide(descriptor: ChordDescriptor): HandbackDecision {
    if (descriptor.isComposing) {
      return { claimed: false, because: "composing" };
    }
    if (!carriesApplicationModifier(descriptor)) {
      return { claimed: false, because: "no-application-modifier" };
    }
    const mirror = this.mirrorChords();
    if (mirror === undefined) {
      return { claimed: false, because: "mirror-unreadable" };
    }
    return this.#isMirrored(descriptor, mirror)
      ? { claimed: true }
      : { claimed: false, because: "not-mirrored" };
  }

  /**
   * Focus the pane and forward the chord into it as a key event, so the keybinding table, its
   * `when` clauses, the palette and the pane's handlers see it as if typed with the pane focused.
   *
   * Dispatched on the pane root, not `window`: a window target excludes its descendants, so the
   * pane's `onKeyDownCapture` (the close-tab chord) would never run. `window` still hears it as
   * the event bubbles.
   */
  public forwardChord(descriptor: ChordDescriptor, paneRoot: HTMLElement): ChordForwardOutcome {
    const decision = this.decide(descriptor);
    if (!decision.claimed) {
      return this.#refuse(
        "not-claimable",
        "This keystroke is the page's — " +
          `${decision.because.replaceAll("-", " ")} — so the console does ` +
          "not forward it.",
      );
    }
    if (!paneRoot.isConnected) {
      return this.#refuse(
        "pane-detached",
        "The pane that received this chord is no longer on screen, so " +
          "there is nothing to focus and nothing to forward it into.",
      );
    }
    paneRoot.focus();
    paneRoot.dispatchEvent(authorKeyboardEvent(descriptor));
    this.#forwardCount += 1;
    return { status: "forwarded" };
  }

  /**
   * Whether the mirror holds a chord THIS keystroke satisfies, through tinykeys' matcher. Not a
   * comparison of normalized sets: a chord like `$mod+[Shift]+KeyK` has optional modifiers that
   * a keystroke has no counterpart for. It takes the mirror `decide` just read, so a changing
   * supplier cannot make the claim disagree with the reason given. A chord the parser refuses
   * (a sequence, or modifiers with no key) matches nothing and leaves the key with the page.
   */
  #isMirrored(descriptor: ChordDescriptor, mirror: readonly string[]): boolean {
    const pressed = authorKeyboardEvent(descriptor);
    return mirror.some((chord) => {
      const parsed = parseChord(resolvePlatformModifier(chord, this.#platform));
      return parsed.ok && chordMatchesEvent(parsed.press, pressed);
    });
  }

  #refuse(code: KeyboardHandbackRefusalCode, detail: string): ChordForwardOutcome {
    return { status: "refused", refusal: refuse(KEYBOARD_HANDBACK_REFUSAL_ORIGIN, code, detail) };
  }
}

/**
 * An authored chord with `$mod` resolved for the platform the keystroke was raised on. The
 * parser resolves it against the host at import time; the platform is an input here so a test
 * can drive all three.
 */
function resolvePlatformModifier(chord: string, platform: ChordPlatform): string {
  return chord.replaceAll(PLATFORM_MODIFIER_CHORD_TOKEN, PLATFORM_MODIFIER_TOKEN[platform]);
}

/**
 * The keystroke as a `KeyboardEvent` again, shared by the matcher and the forward so a stand-in
 * built for the match cannot answer `getModifierState` differently from the event dispatched.
 */
function authorKeyboardEvent(descriptor: ChordDescriptor): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: descriptor.key,
    code: descriptor.code,
    ctrlKey: descriptor.ctrlKey,
    metaKey: descriptor.metaKey,
    altKey: descriptor.altKey,
    shiftKey: descriptor.shiftKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
}
