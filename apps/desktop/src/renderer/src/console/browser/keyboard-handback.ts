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
// ONE CHORD GRAMMAR, RESOLVED FOR THE RIGHT PLATFORM. The equality runs through
// `palette/keybinding-chord.ts` — the console's single chord parser and its single
// comparison key — with the keystroke authored back into a chord string and put
// through the same two functions the mirror side goes through, so a mirror and the
// keybinding table cannot disagree about whether `$mod+k`, `$mod+KeyK`, and a meta-K
// keystroke are one thing. `$mod` is resolved HERE, before parsing, because the parser
// resolves it against whichever host the bundle loaded under and the platform is an
// INPUT to this decision. An authored chord naming an OPTIONAL modifier —
// `$mod+[Shift]+KeyK` — therefore compares equal to no keystroke and is never claimed;
// the console installs none, and the fourth rule's direction is toward the page anyway.
//
// WHAT IS NOT INVENTED HERE. 12.4 names `browser.onAccelerator`, an arm of
// `browser.subscribe`, as the handback carrier, and it is on `Plan-023 §Console growth
// slate` row `browser-pane-namespace` with no growth-port operation registered. So
// this module owns the two halves that are the renderer's either way — the PROJECTION
// a main-process mirror is built from, and the REPLAY a claimed chord arrives at —
// and names no method string. The projection is deliberately handed a chord LIST
// rather than reading one out of `palette/`: `KeyBindingTable` exposes no enumeration
// of installed chords today, and inventing a second list here is exactly the drift the
// third rule forbids. What this module does take from that family is the GRAMMAR the
// paragraph above names, because a second chord grammar is that same drift by another
// route.
//
// The close-tab chord of 12.2 lives here too, and not beside the tab strip, because it
// is the same question — is this keystroke the application's? — and a second modifier
// comparison written next to the strip is how the two answers start to disagree.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { normalizePressForComparison, parseChord } from "../palette/index.js";
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
 * The token an authored chord names for "this platform's own application modifier".
 * Spelled out again in `CHORD_MODIFIER_TOKENS` rather than referenced there, because
 * `isolatedDeclarations` will not emit an exported tuple whose members it would have
 * to infer from another declaration.
 */
const PLATFORM_MODIFIER_CHORD_TOKEN = "$mod";

/**
 * Which modifier `$mod` stands for on each platform — meta on macOS, control
 * elsewhere.
 *
 * The ONE resolution in this module, and both halves read it: the claim rule
 * substitutes it into an authored chord before parsing, and the close-tab predicate
 * asks which of a descriptor's two modifiers it names. A second comparison written
 * beside either one is how the two answers start to disagree.
 */
const PLATFORM_MODIFIER_TOKEN: Readonly<Record<ChordPlatform, "Meta" | "Control">> = {
  darwin: "Meta",
  win32: "Control",
  linux: "Control",
};

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
 * The comparison key for one authored chord, or `undefined` where it does not parse.
 *
 * A chord the parser refuses — a multi-press sequence, or modifiers with no key —
 * matches nothing rather than throwing. An unparseable mirror entry therefore leaves
 * the keystroke with the page, which is this module's fourth rule.
 */
function chordComparisonKey(chord: string, platform: ChordPlatform): string | undefined {
  const parsed = parseChord(resolvePlatformModifier(chord, platform));
  return parsed.ok ? normalizePressForComparison(parsed.press) : undefined;
}

/**
 * The chord's key token. `code` first, because it is layout-independent and a
 * `key`-only test binds the chord to whichever letter the operator's layout puts there.
 */
function descriptorKeyToken(descriptor: ChordDescriptor): string {
  return descriptor.code === "" ? descriptor.key : descriptor.code;
}

/**
 * The keystroke, written back out as the chord somebody would have had to author to
 * bind it. Modifier order is irrelevant — the comparison key sorts them — and this is
 * the one place a held modifier is written in the parser's own vocabulary, so the
 * authored form and the form the mirror is parsed into cannot drift apart.
 */
function authorChordForDescriptor(descriptor: ChordDescriptor): string {
  const modifiers: string[] = [];
  if (descriptor.ctrlKey) {
    modifiers.push("Control");
  }
  if (descriptor.metaKey) {
    modifiers.push("Meta");
  }
  if (descriptor.altKey) {
    modifiers.push("Alt");
  }
  if (descriptor.shiftKey) {
    modifiers.push("Shift");
  }
  return [...modifiers, descriptorKeyToken(descriptor)].join("+");
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
   * Whether the mirror holds THIS chord. An equality, never a presence test.
   *
   * It is handed the mirror `decide` just read, so a supplier that changes answer
   * mid-decision cannot make the claim disagree with the reason given for it. Nothing
   * is cached across keystrokes, for `mirrorChords`' reason: an operator rebinding a
   * key changes the set, and a cached comparison would claim what they gave away.
   */
  #isMirrored(descriptor: ChordDescriptor, mirror: readonly string[]): boolean {
    const pressed = chordComparisonKey(authorChordForDescriptor(descriptor), this.#platform);
    if (pressed === undefined) {
      return false;
    }
    return mirror.some((chord) => chordComparisonKey(chord, this.#platform) === pressed);
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
    paneRoot.dispatchEvent(
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
  const platformModifierIsMeta = PLATFORM_MODIFIER_TOKEN[platform] === "Meta";
  const platformModifierHeld = platformModifierIsMeta ? descriptor.metaKey : descriptor.ctrlKey;
  const otherModifierHeld = platformModifierIsMeta ? descriptor.ctrlKey : descriptor.metaKey;
  if (!platformModifierHeld || otherModifierHeld) {
    return false;
  }
  return closeTabKeyToken(descriptor) === CLOSE_TAB_KEY_TOKEN;
}

/**
 * The chord's key, normalised through the console's one decoder so `KeyW`, `w`, and
 * `W` are one keystroke.
 */
function closeTabKeyToken(descriptor: ChordDescriptor): string {
  return decodeChordKeyToken(descriptorKeyToken(descriptor)).toUpperCase();
}

/** The close-tab chord in the console's own authoring grammar, for a hint. */
export const CLOSE_TAB_CHORD = "$mod+KeyW";
