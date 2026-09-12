// The composer chord's grammar.
//
// The chord is read by two processes that cannot see each other, so what is
// checkable here is not "the string is `$mod+KeyL`" — that is the declaration
// restating itself — but the two properties both readers depend on: the printed
// chord and the matched keystroke name the SAME key, and the match is exact on
// every modifier rather than only on the primary one. A loose match is invisible in
// a screenshot and shows up as a keystroke a person bound to something else being
// eaten by a window that has no control for it.

import { describe, expect, it } from "vitest";

import {
  COMPOSER_FOCUS_CHORD,
  composerChordPrimaryModifier,
  matchesComposerFocusChord,
  type ComposerChordKeystroke,
} from "./composer-chord.js";

/** A keystroke with no modifier held. Each case turns on exactly what it names. */
function keystroke(overrides: Partial<ComposerChordKeystroke> = {}): ComposerChordKeystroke {
  return { code: "KeyL", control: false, meta: false, alt: false, shift: false, ...overrides };
}

describe("the composer chord names one key in both halves", () => {
  it("prints the same physical key the matcher answers to", () => {
    // The two halves are a string a renderer binds and a comparison main performs,
    // and nothing else holds them together. A chord printed as `KeyL` whose matcher
    // read `KeyK` would bind one key and consume another, with both halves green.
    const [, printedKey] = COMPOSER_FOCUS_CHORD.split("+");
    expect(printedKey).toBe("KeyL");
    expect(
      matchesComposerFocusChord(keystroke({ code: printedKey ?? "", control: true }), "control"),
    ).toBe(true);
  });

  it("carries the platform-resolved primary modifier rather than a literal one", () => {
    // `$mod` is what makes one declaration serve both platforms. A chord spelled
    // with `Meta` or `Control` would be right on one desktop and unpressable on the
    // other.
    expect(COMPOSER_FOCUS_CHORD.startsWith("$mod+")).toBe(true);
  });
});

describe("the chord's primary modifier follows the host", () => {
  it("is command on macOS and control everywhere else", () => {
    expect(composerChordPrimaryModifier("darwin")).toBe("meta");
    expect(composerChordPrimaryModifier("win32")).toBe("control");
    expect(composerChordPrimaryModifier("linux")).toBe("control");
  });
});

describe("the chord match is exact on every modifier", () => {
  it("answers the chord on each platform's own primary modifier", () => {
    expect(matchesComposerFocusChord(keystroke({ meta: true }), "meta")).toBe(true);
    expect(matchesComposerFocusChord(keystroke({ control: true }), "control")).toBe(true);
  });

  it("refuses the other platform's modifier", () => {
    // Without this, a control-L typed on macOS — which is the readline chord for
    // "clear the screen" in every terminal a person has muscle memory from — would
    // be consumed by a window that has no composer.
    expect(matchesComposerFocusChord(keystroke({ control: true }), "meta")).toBe(false);
    expect(matchesComposerFocusChord(keystroke({ meta: true }), "control")).toBe(false);
  });

  it("refuses the chord with a further modifier held", () => {
    // The negative control for the exactness rule: a matcher that read only the
    // primary modifier would answer all three of these true, and each is a chord a
    // person may have bound to something the auxiliary window would never run.
    expect(matchesComposerFocusChord(keystroke({ meta: true, alt: true }), "meta")).toBe(false);
    expect(matchesComposerFocusChord(keystroke({ meta: true, shift: true }), "meta")).toBe(false);
    expect(matchesComposerFocusChord(keystroke({ meta: true, control: true }), "meta")).toBe(false);
  });

  it("refuses a bare press of the same key", () => {
    // Typing an `l` into a find field is not a request for the composer.
    expect(matchesComposerFocusChord(keystroke(), "meta")).toBe(false);
    expect(matchesComposerFocusChord(keystroke(), "control")).toBe(false);
  });

  it("refuses another key held with the same modifier", () => {
    expect(matchesComposerFocusChord(keystroke({ code: "KeyK", meta: true }), "meta")).toBe(false);
  });
});
