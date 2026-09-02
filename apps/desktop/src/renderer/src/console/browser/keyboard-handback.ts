// Keeping the application's chords alive inside a page the application does not own.
//
// `Spec-023 §Console Design (Meridian)` 12.4. Nothing here renders: correct behaviour
// on this surface is the absence of a complaint. Four rules, and each one is a
// decision about who wins a keystroke:
//
//   • **A chord is claimed only when it carries control, meta, or alt.** Bare keys
//     and shift-only combinations are typing, and a page that lost `S` to a "save"
//     binding would be unusable.
//   • **A claimed chord is NOT executed where it was seen.** It is handed back to the
//     renderer, which focuses the pane and replays it as a window key event — so the
//     `when` grammar, the operator's rebindings, and the palette behave exactly as
//     they do anywhere else, because they are the same code path.
//   • **The mirror holds which chords EXIST, never what they mean.** Anything more
//     would be a second source of truth for a binding, and the two would drift the
//     first time somebody rebound a key.
//   • **Unreadable defaults to the page.** No mirror, no claim. Failing open toward
//     the page is the safe direction here, because the page is the surface the
//     operator is looking at.
//
// WHAT IS NOT INVENTED HERE. 12.4 names `browser.onAccelerator`, an arm of
// `browser.subscribe`, as the handback carrier, and it is on `Plan-023 §Console growth
// slate` row `browser-pane-namespace` with no growth-port operation registered. So
// this module owns the two halves that are the renderer's either way — the PROJECTION
// a main-process mirror is built from, and the REPLAY a claimed chord arrives at —
// and names no method string. The projection is deliberately handed a chord list
// rather than reaching into `palette/`: `KeyBindingTable` exposes no enumeration of
// installed chords today, and inventing a second list here is exactly the drift the
// third rule forbids.
//
// The close-tab chord of 12.2 lives here too, and not beside the tab strip, because it
// is the same question — is this keystroke the application's? — and a second modifier
// comparison written next to the strip is how the two answers start to disagree.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { decodeChordKeyToken, type ChordPlatform } from "../primitives/index.js";

/** The subsystem name every refusal this module raises carries. */
export const KEYBOARD_HANDBACK_REFUSAL_ORIGIN = "browser-keyboard-handback";

/** Why a handback was refused. Closed, so a second reason is a decision. */
export const KEYBOARD_HANDBACK_REFUSAL_CODES = ["not-claimable", "pane-detached"] as const;

export type KeyboardHandbackRefusalCode = (typeof KEYBOARD_HANDBACK_REFUSAL_CODES)[number];

/** The key token the platform close-tab chord carries, in its layout-independent form. */
const CLOSE_TAB_KEY_TOKEN = "W";

/**
 * One keystroke, in the fields both halves of this module read.
 *
 * A descriptor rather than a `KeyboardEvent` because the claim decision has to be
 * makeable where there is no DOM — the mirror it feeds is consulted in the main
 * process — and because a predicate over seven booleans and two strings is one a test
 * can drive exhaustively.
 */
export interface ChordDescriptor {
  /** `KeyboardEvent.key` — layout-dependent, so it is the fallback and not the key. */
  readonly key: string;
  /** `KeyboardEvent.code` — layout-independent, which is what the console binds on. */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

/** Read a descriptor off a real event. The one place the DOM shape is depended on. */
export function describeChordEvent(event: KeyboardEvent): ChordDescriptor {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
  };
}

/**
 * 12.4's first rule, as a predicate. Shift is deliberately absent from the test: a
 * shift-only combination is a capital letter.
 */
export function carriesApplicationModifier(descriptor: ChordDescriptor): boolean {
  return descriptor.ctrlKey || descriptor.metaKey || descriptor.altKey;
}

/**
 * The modifier tokens an authored chord can name.
 *
 * `$mod` resolves to meta on macOS and control elsewhere, so it counts on every
 * platform. This is a PRESENCE test over a closed token set and not a chord parser —
 * it resolves no key, no sequence, and no optional modifier, and the console's one
 * chord parser stays `palette/keybinding-chord.ts`.
 */
export const CHORD_MODIFIER_TOKENS = ["$mod", "Meta", "Control", "Ctrl", "Alt", "Option"] as const;

/** Whether an authored chord names a modifier that makes it claimable at all. */
export function chordCarriesApplicationModifier(chord: string): boolean {
  const tokens = new Set(chord.split("+").map((token) => token.trim().replace(/^\[|\]$/gu, "")));
  return CHORD_MODIFIER_TOKENS.some((modifier) => tokens.has(modifier));
}

/**
 * The mirror, as a projection of the chords it was handed.
 *
 * Filtering here rather than at the claim site is what keeps the main process from
 * ever holding a chord it must not claim: a bare `KeyS` binding never reaches the
 * mirror, so no amount of main-process logic can take `S` away from a page.
 */
export function projectClaimableChords(chords: readonly string[]): readonly string[] {
  return [...new Set(chords.filter((chord) => chordCarriesApplicationModifier(chord)))].sort();
}

/** Why a keystroke was not claimed. Every arm leaves the keystroke with the page. */
export const HANDBACK_DECLINE_REASONS = [
  "composing",
  "no-application-modifier",
  "mirror-unreadable",
] as const;

export type HandbackDeclineReason = (typeof HANDBACK_DECLINE_REASONS)[number];

/** The claim decision. `claimed` is the only arm that takes a keystroke from a page. */
export type HandbackDecision =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly because: HandbackDeclineReason };

/** What a replay did. A refusal is rendered; it is never swallowed. */
export type ChordReplayOutcome =
  | { readonly status: "replayed" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

export interface KeyboardHandbackOptions {
  /**
   * The chords the console has installed, or `undefined` while the registry has not
   * loaded. `undefined` is a real answer and is 12.4's degraded arm — it is not an
   * empty list, which would say "the console has no chords" rather than "nobody has
   * asked yet".
   */
  readonly readInstalledChords: () => readonly string[] | undefined;
}

/**
 * The renderer's half of the handback.
 *
 * A class because the projection is read through a supplier that can change answer
 * between calls, and because a replay has to be attributable: `replayCount` is what a
 * test asserts against instead of trusting that a dispatched event was delivered.
 */
export class KeyboardHandback {
  readonly #readInstalledChords: () => readonly string[] | undefined;
  #replayCount = 0;

  public constructor(options: KeyboardHandbackOptions) {
    this.#readInstalledChords = options.readInstalledChords;
  }

  /**
   * The mirror a main-process listener is built from, or `undefined` when the registry
   * has not loaded. Never a stale copy: it is projected on every read, because the
   * chord set changes whenever an operator rebinds a key.
   */
  public mirrorChords(): readonly string[] | undefined {
    const installed = this.#readInstalledChords();
    return installed === undefined ? undefined : projectClaimableChords(installed);
  }

  /** How many chords were replayed into the window. Deliberately not a guess. */
  public get replayCount(): number {
    return this.#replayCount;
  }

  /** 12.4's whole claim rule, in the order the rules are stated. */
  public decide(descriptor: ChordDescriptor): HandbackDecision {
    if (descriptor.isComposing) {
      return { claimed: false, because: "composing" };
    }
    if (!carriesApplicationModifier(descriptor)) {
      return { claimed: false, because: "no-application-modifier" };
    }
    return this.mirrorChords() === undefined
      ? { claimed: false, because: "mirror-unreadable" }
      : { claimed: true };
  }

  /**
   * Focus the pane and replay the chord as a window key event.
   *
   * The replay is a WINDOW event and not a direct command invocation, which is the
   * point of the whole surface: the keybinding table, its `when` clauses, and the
   * palette all see a keystroke indistinguishable from one typed with the pane
   * focused, so none of them needs a second code path for chords that came from a page.
   */
  public replay(descriptor: ChordDescriptor, paneRoot: HTMLElement): ChordReplayOutcome {
    const decision = this.decide(descriptor);
    if (!decision.claimed) {
      return this.#refuse(
        "not-claimable",
        `This keystroke is the page's — ${decision.because.replaceAll("-", " ")} — so the console does not replay it.`,
      );
    }
    if (!paneRoot.isConnected) {
      return this.#refuse(
        "pane-detached",
        "The pane that received this chord is no longer on screen, so there is nothing to focus and nothing to replay it into.",
      );
    }
    paneRoot.focus();
    paneRoot.ownerDocument.defaultView?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: descriptor.key,
        code: descriptor.code,
        ctrlKey: descriptor.ctrlKey,
        metaKey: descriptor.metaKey,
        altKey: descriptor.altKey,
        shiftKey: descriptor.shiftKey,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    this.#replayCount += 1;
    return { status: "replayed" };
  }

  #refuse(code: KeyboardHandbackRefusalCode, detail: string): ChordReplayOutcome {
    return { status: "refused", refusal: refuse(KEYBOARD_HANDBACK_REFUSAL_ORIGIN, code, detail) };
  }
}

/**
 * The platform close-tab chord of 12.2, as one predicate.
 *
 * "The handler rejects an in-progress composition, rejects alt and shift, and requires
 * the platform's own modifier with the other absent, so the chord closes a tab and
 * never the window." The exclusivity is the part worth stating: on macOS, control-W
 * is a page chord and meta-W is the application's, and a test for "either modifier"
 * would take both.
 */
export function isCloseTabChord(descriptor: ChordDescriptor, platform: ChordPlatform): boolean {
  if (descriptor.isComposing || descriptor.altKey || descriptor.shiftKey) {
    return false;
  }
  const platformModifierHeld = platform === "darwin" ? descriptor.metaKey : descriptor.ctrlKey;
  const otherModifierHeld = platform === "darwin" ? descriptor.ctrlKey : descriptor.metaKey;
  if (!platformModifierHeld || otherModifierHeld) {
    return false;
  }
  return closeTabKeyToken(descriptor) === CLOSE_TAB_KEY_TOKEN;
}

/**
 * The chord's key, normalised through the console's one decoder so `KeyW`, `w`, and
 * `W` are one keystroke. `code` first, because it is layout-independent and a
 * `key`-only test binds the chord to whichever letter the operator's layout puts there.
 */
function closeTabKeyToken(descriptor: ChordDescriptor): string {
  const token = descriptor.code === "" ? descriptor.key : descriptor.code;
  return decodeChordKeyToken(token).toUpperCase();
}

/** The close-tab chord in the console's own authoring grammar, for a hint. */
export const CLOSE_TAB_CHORD = "$mod+KeyW";
