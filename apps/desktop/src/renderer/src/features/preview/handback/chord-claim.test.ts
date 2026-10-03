// Which keystrokes the console may take from a page: the chords projected into the mirror the
// main-process listener claims from, and the close-tab chord the pane swallows. A rule one
// modifier too broad takes `S` from a page's search box, and neither shows until somebody types.

import { describe, expect, it } from "vitest";

import {
  chordCarriesApplicationModifier,
  isCloseTabChord,
  projectClaimableChords,
} from "./chord-claim.js";
import { chord } from "./keyboard-handback.test-support.js";

describe("projectClaimableChords", () => {
  it("drops bare chords, so a mirror can never hold one", () => {
    expect(projectClaimableChords(["KeyS", "Shift+KeyS", "$mod+KeyS"])).toStrictEqual([
      "$mod+KeyS",
    ]);
  });

  it("keeps a multi-press sequence out of the mirror", () => {
    // `parseChord` refuses a sequence, so a mirrored one would be taken from the page and never
    // matched.
    expect(chordCarriesApplicationModifier("$mod+KeyK $mod+KeyB")).toBe(false);
    expect(projectClaimableChords(["$mod+KeyK $mod+KeyB"])).toStrictEqual([]);
  });
});

describe("isCloseTabChord", () => {
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
});
