// Keeping the application's chords alive inside a page the application does not own.
//
// `Spec-023 §Console Design (Meridian)` 12.4. Nothing here renders: correct behaviour
// on this surface is the absence of a complaint. Four rules, and each one is a
// decision about who wins a keystroke:
//
//   • **A chord is claimed only when it carries control, meta, or alt AND the mirror
//     holds that exact chord.** Bare keys and shift-only combinations are typing, and
//     a page that lost `S` to a "save" binding would be unusable — and a page that
//     lost Cmd+C, Cmd+L, and every other modified keystroke to a mirror holding one
//     chord would be unusable in the same way, so the second half is an EQUALITY
//     against a mirrored chord rather than a test that the mirror is not empty.
//   • **A claimed chord is NOT executed where it was seen.** It is handed back to the
//     renderer, which focuses the pane and replays it as a key event ON THE PANE ROOT
//     — so the `when` grammar, the operator's rebindings, the palette, and the pane's
//     own capture handlers behave exactly as they do anywhere else, because they are
//     the same code path. The window hears it as it bubbles out of the pane.
//   • **The mirror holds which chords EXIST, never what they mean.** Anything more
//     would be a second source of truth for a binding, and the two would drift the
//     first time somebody rebound a key.
//   • **Unreadable defaults to the page.** No mirror, no claim. Failing open toward
//     the page is the safe direction here, because the page is the surface the
//     operator is looking at.
//
// THE MACHINE, AND NOT THE VOCABULARY. The keystroke descriptor, the two modifier
// predicates, the projection a mirror is built from, and the close-tab chord live in
// `chord-claim.ts` beside this file; this module imports them and nothing there
// imports back. The split is the one the rules already draw: which chords MAY be
// claimed is a vocabulary a main process can carry, and who wins THIS keystroke is a
// decision only the renderer holding the pane can make.
//
// ONE CHORD GRAMMAR, RESOLVED FOR THE RIGHT PLATFORM. The mirror is parsed by
// `palette/keybinding-chord.ts` — the console's single chord parser — and the
// keystroke is MATCHED against the result through that module's `chordMatchesEvent`,
// which is the console's one wrapper over tinykeys' own `matchKeybindingPress`. So a
// mirror and the keybinding table cannot disagree about whether `$mod+k`,
// `$mod+KeyK`, and a meta-K keystroke are one thing: they are put through the same
// matcher. `$mod` is resolved HERE, before parsing, because the parser resolves it
// against whichever host the bundle loaded under and the platform is an INPUT to this
// decision.
//
// WHY A MATCH AND NOT AN EQUALITY OF NORMALIZED SETS. tinykeys' grammar has two
// modifier sets, required and OPTIONAL — `$mod+[Shift]+KeyK` means "meta-K, and I do
// not mind whether shift is down". A keystroke has neither set: it has modifiers that
// are held. Re-authoring the keystroke as a chord put every held modifier in the
// required set and left the optional one empty, so a bracketed binding compared equal
// to no keystroke at all and could not be handed back with shift held OR without it —
// a chord the console had CLAIMED from the page and could then never replay. The
// matcher answers the question the sets are for: every required modifier is held, and
// no modifier outside the two sets is.
//
// THE MATCH TARGET IS A REAL `KeyboardEvent`, re-authored from the descriptor by the
// same helper `replay` dispatches through. tinykeys reads `key`, `code`, and
// `getModifierState`, and building the event is how those come from one place rather
// than from a hand-written stand-in that could answer differently from the one that
// is dispatched a line later.
//
// WHAT IS NOT INVENTED HERE. 12.4 names `browser.onAccelerator`, an arm of
// `browser.subscribe`, as the handback carrier, and it is on `Plan-023 §Console growth
// slate` row `browser-pane-namespace` with no growth-port operation registered. So
// this family owns the two halves that are the renderer's either way — the PROJECTION
// a main-process mirror is built from, and the REPLAY a claimed chord arrives at —
// and names no method string. The projection is deliberately handed a chord LIST
// rather than reading one out of `palette/`: `KeyBindingTable` exposes no enumeration
// of installed chords today, and inventing a second list here is exactly the drift the
// third rule forbids. What this module does take from that family is the GRAMMAR the
// paragraph above names, because a second chord grammar is that same drift by another
// route.
//
// `KeyboardHandback` carries a one-line claim naming the growth slate row that owns
// its wire, for `chord-claim.ts`' reason: the claim is the difference between a symbol
// waiting for a named consumer and one nothing will ever import.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { chordMatchesEvent, parseChord } from "../../palette/index.js";
import {
  PLATFORM_MODIFIER_CHORD_TOKEN,
  PLATFORM_MODIFIER_TOKEN,
  type ChordPlatform,
} from "../../primitives/index.js";
import {
  carriesApplicationModifier,
  projectClaimableChords,
  type ChordDescriptor,
} from "./chord-claim.js";

/** The subsystem name every refusal this module raises carries. */
export const KEYBOARD_HANDBACK_REFUSAL_ORIGIN = "browser-keyboard-handback";

/** Why a handback was refused. Closed, so a second reason is a decision. */
export const KEYBOARD_HANDBACK_REFUSAL_CODES = ["not-claimable", "pane-detached"] as const;

export type KeyboardHandbackRefusalCode = (typeof KEYBOARD_HANDBACK_REFUSAL_CODES)[number];

/** Why a keystroke was not claimed. Every arm leaves the keystroke with the page. */
export const HANDBACK_DECLINE_REASONS = [
  "composing",
  "no-application-modifier",
  "mirror-unreadable",
  "not-mirrored",
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

/**
 * An authored chord with `$mod` resolved for the platform the keystroke was raised on.
 *
 * Resolved here rather than left to the parser, which resolves it against the host at
 * import time — `primitives/chord-format.ts` says the same about the printer, for the
 * same reason. The platform is an input, so a test can drive all three.
 */
function resolvePlatformModifier(chord: string, platform: ChordPlatform): string {
  return chord.replaceAll(PLATFORM_MODIFIER_CHORD_TOKEN, PLATFORM_MODIFIER_TOKEN[platform]);
}

/**
 * The keystroke as a `KeyboardEvent` again — the shape both the matcher and the
 * replay need.
 *
 * One author for both, because they have to agree: a stand-in built for the match
 * that answered `getModifierState` differently from the event actually dispatched
 * would claim one chord from the page and replay another. `bubbles`, `cancelable`,
 * and `composed` are the replay's, and cost the match nothing.
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

export interface KeyboardHandbackOptions {
  /**
   * The chords the console has installed, or `undefined` while the registry has not
   * loaded. `undefined` is a real answer and is 12.4's degraded arm — it is not an
   * empty list, which would say "the console has no chords" rather than "nobody has
   * asked yet".
   */
  readonly readInstalledChords: () => readonly string[] | undefined;
  /**
   * The platform the keystrokes this instance decides were raised on. A parameter
   * rather than a reading, for `primitives/chord-format.ts`' reason — every renderer
   * there takes the platform in so a fixture can pin it — and because this decision has
   * to come out the same in a test, in the renderer, and in the main process that
   * consults the mirror.
   */
  readonly platform: ChordPlatform;
}

/**
 * The renderer's half of the handback.
 *
 * A class because the projection is read through a supplier that can change answer
 * between calls, and because a replay has to be attributable: `replayCount` is what a
 * test asserts against instead of trusting that a dispatched event was delivered.
 */
// Consumed by growth slate row `browser-pane-namespace`
export class KeyboardHandback {
  readonly #readInstalledChords: () => readonly string[] | undefined;
  readonly #platform: ChordPlatform;
  #replayCount = 0;

  public constructor(options: KeyboardHandbackOptions) {
    this.#readInstalledChords = options.readInstalledChords;
    this.#platform = options.platform;
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
    const mirror = this.mirrorChords();
    if (mirror === undefined) {
      return { claimed: false, because: "mirror-unreadable" };
    }
    return this.#isMirrored(descriptor, mirror)
      ? { claimed: true }
      : { claimed: false, because: "not-mirrored" };
  }

  /**
   * Whether the mirror holds a chord THIS keystroke satisfies. A match, never a
   * presence test.
   *
   * It is handed the mirror `decide` just read, so a supplier that changes answer
   * mid-decision cannot make the claim disagree with the reason given for it. Nothing
   * is cached across keystrokes, for `mirrorChords`' reason: an operator rebinding a
   * key changes the set, and a cached comparison would claim what they gave away.
   *
   * A chord the parser refuses — a multi-press sequence, or modifiers with no key —
   * matches nothing rather than throwing, so an unparseable mirror entry leaves the
   * keystroke with the page, which is this module's fourth rule.
   */
  #isMirrored(descriptor: ChordDescriptor, mirror: readonly string[]): boolean {
    const pressed = authorKeyboardEvent(descriptor);
    return mirror.some((chord) => {
      const parsed = parseChord(resolvePlatformModifier(chord, this.#platform));
      return parsed.ok && chordMatchesEvent(parsed.press, pressed);
    });
  }

  /**
   * Focus the pane and replay the chord into it as a key event.
   *
   * An EVENT and not a direct command invocation, which is the point of the whole
   * surface: the keybinding table, its `when` clauses, the palette, and the pane's own
   * handlers all see a keystroke indistinguishable from one typed with the pane
   * focused, so none needs a second code path for chords that came from a page.
   *
   * ON THE PANE ROOT, NOT ON THE WINDOW. Dispatching on `window` makes the window the
   * target, and a target's propagation path excludes its descendants — so the pane's
   * own `onKeyDownCapture` never ran and the one chord `BrowserPane` handles there,
   * the close-tab chord of 12.2, was silently swallowed: no refusal, no close, and a
   * keystroke the mirror had just CLAIMED from the page. The window still hears it,
   * which is why this is a re-target and not a second route: a bubbling event
   * dispatched inside the document reaches `window` on the way down to a capture
   * listener and again on the way up. Routing the close chord specially instead would
   * be the second replay path the second rule at the top of this module forbids.
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
    paneRoot.dispatchEvent(authorKeyboardEvent(descriptor));
    this.#replayCount += 1;
    return { status: "replayed" };
  }

  #refuse(code: KeyboardHandbackRefusalCode, detail: string): ChordReplayOutcome {
    return { status: "refused", refusal: refuse(KEYBOARD_HANDBACK_REFUSAL_ORIGIN, code, detail) };
  }
}
