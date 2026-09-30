// A claim rule one modifier too broad takes `S` from a page's search box; one too narrow kills
// the operator's whole chord set inside a pane. Neither shows until somebody is typing.

import { describe, expect, it } from "vitest";

import {
  CLAIMABLE_MODIFIER_TOKENS,
  CLOSE_TAB_CHORD,
  carriesApplicationModifier,
  chordCarriesApplicationModifier,
  describeChordEvent,
  isCloseTabChord,
  projectClaimableChords,
} from "./chord-claim.js";
import { chord } from "./keyboard-handback.test-support.js";

describe("carriesApplicationModifier", () => {
  it("counts control, meta, and alt", () => {
    expect(carriesApplicationModifier(chord({ ctrlKey: true }))).toBe(true);
    expect(carriesApplicationModifier(chord({ metaKey: true }))).toBe(true);
    expect(carriesApplicationModifier(chord({ altKey: true }))).toBe(true);
  });

  it("does not count shift, because a shift-only combination is a capital letter", () => {
    expect(carriesApplicationModifier(chord({ shiftKey: true }))).toBe(false);
    expect(carriesApplicationModifier(chord())).toBe(false);
  });
});

describe("describeChordEvent", () => {
  it("reads every field the claim decision depends on off a real event", () => {
    const descriptor = describeChordEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(descriptor).toStrictEqual(chord({ metaKey: true, shiftKey: true }));
  });
});

describe("projectClaimableChords", () => {
  it("drops bare chords, so a mirror can never hold one", () => {
    expect(projectClaimableChords(["KeyS", "Shift+KeyS", "$mod+KeyS"])).toStrictEqual([
      "$mod+KeyS",
    ]);
  });

  it("accepts every modifier token the grammar names, including a bracketed one", () => {
    for (const modifier of CLAIMABLE_MODIFIER_TOKENS) {
      expect(chordCarriesApplicationModifier(`${modifier}+KeyK`)).toBe(true);
    }
    expect(chordCarriesApplicationModifier("[Alt]+KeyK")).toBe(true);
  });

  it("subtracts only shift from the console's chord vocabulary", () => {
    // The set is derived, so assert the one subtraction rather than the members.
    expect(CLAIMABLE_MODIFIER_TOKENS).not.toContain("Shift");
    expect(chordCarriesApplicationModifier("Shift+KeyS")).toBe(false);
  });

  it("reads the plus key chord the grammar spells `$mod++`", () => {
    // tinykeys splits a press on `+` preceded by a word character, so `$mod++` is meta-plus. The
    // printer's splitter agrees with the parser about that; a split on `+` does not.
    expect(chordCarriesApplicationModifier("$mod++")).toBe(true);
    expect(projectClaimableChords(["$mod++"])).toStrictEqual(["$mod++"]);
  });

  it("keeps a multi-press sequence out of the mirror", () => {
    // `parseChord` refuses a sequence, so a mirrored one would be taken from the page and never
    // matched.
    expect(chordCarriesApplicationModifier("$mod+KeyK $mod+KeyB")).toBe(false);
    expect(projectClaimableChords(["$mod+KeyK $mod+KeyB"])).toStrictEqual([]);
  });

  it("negative control: the sequence rule is not rejecting every modified chord", () => {
    // A predicate answering false for everything would pass the cases above and empty the mirror.
    expect(chordCarriesApplicationModifier("$mod+KeyK")).toBe(true);
    expect(chordCarriesApplicationModifier(" $mod+KeyK ")).toBe(true);
  });

  it("deduplicates and sorts, so two mirrors of one set compare equal", () => {
    expect(projectClaimableChords(["$mod+KeyB", "$mod+KeyA", "$mod+KeyB"])).toStrictEqual([
      "$mod+KeyA",
      "$mod+KeyB",
    ]);
  });

  it("negative control: the filter is not rejecting everything", () => {
    // A projection returning the empty array would pass the bare-chord case and drop every chord.
    expect(projectClaimableChords(["Control+KeyP"])).toHaveLength(1);
  });
});

describe("isCloseTabChord", () => {
  it("takes the platform's own modifier on each platform", () => {
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true }), "darwin")).toBe(true);
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", ctrlKey: true }), "win32")).toBe(true);
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", ctrlKey: true }), "linux")).toBe(true);
  });

  it("refuses the OTHER platform's modifier, so control-W stays the page's on macOS", () => {
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", ctrlKey: true }), "darwin")).toBe(false);
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true }), "win32")).toBe(false);
  });

  it("refuses both modifiers together, which is a different chord", () => {
    expect(
      isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true, ctrlKey: true }), "darwin"),
    ).toBe(false);
  });

  it("refuses alt, shift, and an in-progress composition", () => {
    expect(
      isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true, altKey: true }), "darwin"),
    ).toBe(false);
    expect(
      isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true, shiftKey: true }), "darwin"),
    ).toBe(false);
    expect(
      isCloseTabChord(
        chord({ key: "w", code: "KeyW", metaKey: true, isComposing: true }),
        "darwin",
      ),
    ).toBe(false);
  });

  it("reads the layout-independent code, and falls back to the key when there is none", () => {
    expect(isCloseTabChord(chord({ key: "∑", code: "KeyW", metaKey: true }), "darwin")).toBe(true);
    expect(isCloseTabChord(chord({ key: "W", code: "", metaKey: true }), "darwin")).toBe(true);
  });

  it("refuses every other key", () => {
    expect(isCloseTabChord(chord({ key: "q", code: "KeyQ", metaKey: true }), "darwin")).toBe(false);
  });

  it("is the chord the hint prints", () => {
    expect(CLOSE_TAB_CHORD).toBe("$mod+KeyW");
  });
});
