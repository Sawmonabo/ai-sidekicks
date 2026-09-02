// The chord printer, pinned.
//
// This file exists because of a specific escape. The console authors chords in the
// `KeyboardEvent.code` form (`"$mod+KeyK"`) so a binding stays on the same physical
// key across keyboard layouts, and the binding table decoded that form correctly for
// the strings it printed into palette rows. The `ChordHint` primitive kept a second,
// parallel set of tables that did NOT decode it, and its doc comment asserted the
// two were one function. Every hint for a `code`-form binding therefore printed the
// literal string `KeyK` on a keycap, and nothing caught it until a screenshot did.
//
// The tests below are written against the property that failure violated — one
// decoding, reachable from both renderings — rather than against the one string that
// was wrong. Its other half, that the palette's CONFLICT comparator decodes by the
// same function, is asserted in `palette/chord-decoding.test.ts`, which is where
// the comparator lives.

import { describe, expect, it } from "vitest";

import {
  CHORD_PLATFORMS,
  HOST_CHORD_PLATFORM,
  formatChordForPlatform,
  renderChordForPlatform,
  type ChordPlatform,
} from "./chord-format.js";

/** Flatten a press to the keycaps a person sees, in print order. */
function glyphsOf(chord: string, platform: ChordPlatform): readonly string[] {
  return renderChordForPlatform(chord, platform).flatMap((press) => [
    ...press.modifiers.map((modifier) => modifier.glyph),
    press.key.glyph,
  ]);
}

/** Flatten a press to the words a screen reader says. */
function spokenOf(chord: string, platform: ChordPlatform): readonly string[] {
  return renderChordForPlatform(chord, platform).flatMap((press) => [
    ...press.modifiers.map((modifier) => modifier.spoken),
    press.key.spoken,
  ]);
}

describe("chord rendering — the `code` form reaches the keycap", () => {
  it("decodes a letter code to the letter", () => {
    expect(glyphsOf("$mod+KeyK", "darwin")).toStrictEqual(["⌘", "K"]);
    expect(glyphsOf("$mod+KeyK", "win32")).toStrictEqual(["Ctrl", "K"]);
  });

  it("decodes a digit code to the digit", () => {
    expect(glyphsOf("$mod+Digit1", "darwin")).toStrictEqual(["⌘", "1"]);
  });

  it("decodes punctuation codes to the character on the key", () => {
    // The whole point of the code form: `Comma` is the NAME of a key, and a person
    // reading a hint needs the mark, not the noun.
    expect(glyphsOf("$mod+Comma", "darwin")).toStrictEqual(["⌘", ","]);
    expect(glyphsOf("$mod+Slash", "darwin")).toStrictEqual(["⌘", "/"]);
    expect(glyphsOf("$mod+BracketLeft", "darwin")).toStrictEqual(["⌘", "["]);
  });

  it("speaks the punctuation key by name rather than by mark", () => {
    // "Command comma" is a sentence. "Command ," is a pause.
    expect(spokenOf("$mod+Comma", "darwin")).toStrictEqual(["Command", "Comma"]);
  });

  it("leaves a literally-authored key alone", () => {
    // Both forms are admissible — `FRAME_KEY_BINDINGS` authors `$mod+,` literally,
    // because a comma should follow the layout rather than the physical key — so
    // the decoder must not mangle what was never a code spelling.
    expect(glyphsOf("$mod+,", "darwin")).toStrictEqual(["⌘", ","]);
    expect(glyphsOf("$mod+k", "darwin")).toStrictEqual(["⌘", "K"]);
  });

  it("does not mistake a longer name that merely starts with a prefix", () => {
    // `Key` and `Digit` are stripped only at their exact code lengths; a named key
    // is not a code with a prefix, and shaving three characters off `Keyboard`
    // would be a silent corruption.
    expect(glyphsOf("Keyboard", "darwin")).toStrictEqual(["Keyboard"]);
  });
});

describe("chord rendering — one source, two renderings", () => {
  it("prints the same glyphs the formatted string is built from", () => {
    // The property the old duplication broke: whatever a keycap shows, the string
    // form shows the same. Asserted over the platforms and forms that differ, so a
    // future second table cannot pass this by agreeing in one case.
    const chords = ["$mod+KeyK", "$mod+Digit1", "$mod+Comma", "Shift+ArrowUp", "Alt+Enter"];
    // Driven from the closed set itself rather than a list repeated here: a fourth
    // platform added to the vocabulary must arrive already covered by this
    // property, not silently skipped by a stale literal.
    for (const platform of CHORD_PLATFORMS) {
      for (const chord of chords) {
        const glyphs = glyphsOf(chord, platform);
        const joined = platform === "darwin" ? glyphs.join("") : glyphs.join("+");
        expect(formatChordForPlatform(chord, platform)).toBe(joined);
      }
    }
  });

  it("never speaks a glyph", () => {
    // A screen reader pronounces ⌘ as "place of interest sign". Every spoken token
    // must be words, which here means ASCII — the arrow keys are the deliberate
    // exception check, since their glyph IS in the printed set and their spoken
    // form must not be.
    const spoken = [
      ...spokenOf("$mod+Shift+Alt+KeyK", "darwin"),
      ...spokenOf("Shift+ArrowUp", "darwin"),
      ...spokenOf("$mod+Escape", "darwin"),
    ];
    for (const word of spoken) {
      expect(word).toMatch(/^[A-Za-z0-9 ]+$/u);
    }
  });
});

describe("chord rendering — platform conventions", () => {
  it("runs macOS glyphs together and joins other platforms with plus", () => {
    expect(formatChordForPlatform("$mod+Shift+KeyK", "darwin")).toBe("⌘⇧K");
    expect(formatChordForPlatform("$mod+Shift+KeyK", "win32")).toBe("Ctrl+Shift+K");
  });

  it("names the Meta key the way each platform brands it", () => {
    // "⌘" printed on Windows would name a key that is not on the keyboard.
    expect(formatChordForPlatform("Meta+KeyK", "darwin")).toBe("⌘K");
    expect(formatChordForPlatform("Meta+KeyK", "win32")).toBe("Win+K");
    expect(formatChordForPlatform("Meta+KeyK", "linux")).toBe("Super+K");
  });

  it("omits an optional modifier rather than instructing a person to hold it", () => {
    // `[Shift]` is what the chord TOLERATES. Printing it would be a lie about what
    // must be pressed.
    expect(formatChordForPlatform("$mod+[Shift]+KeyK", "darwin")).toBe("⌘K");
  });

  it("renders a multi-press sequence as separate presses", () => {
    // `parseChord` refuses to BIND a sequence, but the printer is also asked about
    // chords the table never installed — a platform accelerator main owns, say.
    const presses = renderChordForPlatform("KeyG KeyS", "darwin");
    expect(presses).toHaveLength(2);
    expect(presses.map((press) => press.key.glyph)).toStrictEqual(["G", "S"]);
    expect(formatChordForPlatform("KeyG KeyS", "darwin")).toBe("G S");
  });
});

describe("chord rendering — every platform in the closed set is renderable", () => {
  it("prints and speaks something for `$mod` on each platform", () => {
    // The vocabulary is a tuple with the union derived from it, so this walks the
    // real set. `$mod` is the token with the widest per-platform divergence, which
    // makes it the one that catches a platform added to the union with no entry in
    // either modifier table.
    const printed = CHORD_PLATFORMS.map((platform) =>
      formatChordForPlatform("$mod+KeyK", platform),
    );

    for (const [index, platform] of CHORD_PLATFORMS.entries()) {
      expect(spokenOf("$mod+KeyK", platform)[0]).toMatch(/^[A-Za-z]+$/u);
      // The unknown-modifier fallback prints the raw token, so a platform with no
      // table entry would leak "$mod" onto a keycap rather than fail loudly.
      expect(printed[index]).not.toContain("$mod");
    }

    expect(printed).toHaveLength(3);
    // The control: macOS and the two non-macOS platforms genuinely disagree, so the
    // set is being walked rather than one entry rendered three times.
    expect(new Set(printed).size).toBe(2);
  });

  it("detects a host platform that is a member of the set", () => {
    // `HOST_CHORD_PLATFORM` is the ONE reading of the real host, and it is taken
    // from the user agent rather than from `process` — so its fallback arm has to
    // land inside the union rather than on whatever the sniff produced.
    const hostPlatform: ChordPlatform = HOST_CHORD_PLATFORM;
    expect(CHORD_PLATFORMS).toContain(hostPlatform);
    expect(formatChordForPlatform("$mod+KeyK", hostPlatform)).not.toContain("$mod");
  });
});
