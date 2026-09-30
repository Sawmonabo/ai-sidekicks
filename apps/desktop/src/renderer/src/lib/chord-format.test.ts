// A chord authored in the `KeyboardEvent.code` form (`"$mod+KeyK"`) must print as one decoding
// shared by the keycap and the string form. Its other half, that the conflict comparator decodes
// the same way, is asserted in `registries/keybindings/keybinding-chord.test.ts`.

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
    // `Comma` names the key; a person reading a hint needs the mark.
    expect(glyphsOf("$mod+Comma", "darwin")).toStrictEqual(["⌘", ","]);
    expect(glyphsOf("$mod+Slash", "darwin")).toStrictEqual(["⌘", "/"]);
    expect(glyphsOf("$mod+BracketLeft", "darwin")).toStrictEqual(["⌘", "["]);
  });

  it("speaks the punctuation key by name rather than by mark", () => {
    // "Command comma" reads as a sentence; "Command ," does not.
    expect(spokenOf("$mod+Comma", "darwin")).toStrictEqual(["Command", "Comma"]);
  });

  it("leaves a literally-authored key alone", () => {
    // Both forms are admissible (the navigation commands author `$mod+,` literally so the comma
    // follows the layout), so the decoder must leave a non-code spelling alone.
    expect(glyphsOf("$mod+,", "darwin")).toStrictEqual(["⌘", ","]);
    expect(glyphsOf("$mod+k", "darwin")).toStrictEqual(["⌘", "K"]);
  });

  it("does not mistake a longer name that merely starts with a prefix", () => {
    // `Key` and `Digit` are stripped only at their exact code lengths.
    expect(glyphsOf("Keyboard", "darwin")).toStrictEqual(["Keyboard"]);
  });
});

describe("chord rendering — one source, two renderings", () => {
  it("prints the same glyphs the formatted string is built from", () => {
    // Whatever a keycap shows, the string form shows the same, on every platform and form.
    const chords = ["$mod+KeyK", "$mod+Digit1", "$mod+Comma", "Shift+ArrowUp", "Alt+Enter"];
    // Driven from the closed set so a new platform is covered automatically.
    for (const platform of CHORD_PLATFORMS) {
      for (const chord of chords) {
        const glyphs = glyphsOf(chord, platform);
        const joined = platform === "darwin" ? glyphs.join("") : glyphs.join("+");
        expect(formatChordForPlatform(chord, platform)).toBe(joined);
      }
    }
  });

  it("never speaks a glyph", () => {
    // A screen reader mispronounces glyphs, so every spoken token must be ASCII words, arrow
    // keys included.
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
    // "⌘" on Windows would name a key that is not on the keyboard.
    expect(formatChordForPlatform("Meta+KeyK", "darwin")).toBe("⌘K");
    expect(formatChordForPlatform("Meta+KeyK", "win32")).toBe("Win+K");
    expect(formatChordForPlatform("Meta+KeyK", "linux")).toBe("Super+K");
  });

  it("omits an optional modifier rather than instructing a person to hold it", () => {
    // `[Shift]` is tolerated, not required, so it is not printed.
    expect(formatChordForPlatform("$mod+[Shift]+KeyK", "darwin")).toBe("⌘K");
  });

  it("renders a multi-press sequence as separate presses", () => {
    // `parseChord` refuses to bind a sequence, but the printer also renders chords never installed.
    const presses = renderChordForPlatform("KeyG KeyS", "darwin");
    expect(presses).toHaveLength(2);
    expect(presses.map((press) => press.key.glyph)).toStrictEqual(["G", "S"]);
    expect(formatChordForPlatform("KeyG KeyS", "darwin")).toBe("G S");
  });
});

describe("chord rendering — every platform in the closed set is renderable", () => {
  it("prints and speaks something for `$mod` on each platform", () => {
    // `$mod` diverges most across platforms, so it catches a platform with no modifier-table entry.
    const printed = CHORD_PLATFORMS.map((platform) =>
      formatChordForPlatform("$mod+KeyK", platform),
    );

    for (const [index, platform] of CHORD_PLATFORMS.entries()) {
      expect(spokenOf("$mod+KeyK", platform)[0]).toMatch(/^[A-Za-z]+$/u);
      // The unknown-modifier fallback prints the raw token, which would leak "$mod".
      expect(printed[index]).not.toContain("$mod");
    }

    expect(printed).toHaveLength(3);
    // macOS differs from the other two, so the set is walked rather than one entry repeated.
    expect(new Set(printed).size).toBe(2);
  });

  it("detects a host platform that is a member of the set", () => {
    // The user-agent sniff's fallback must land inside the union.
    const hostPlatform: ChordPlatform = HOST_CHORD_PLATFORM;
    expect(CHORD_PLATFORMS).toContain(hostPlatform);
    expect(formatChordForPlatform("$mod+KeyK", hostPlatform)).not.toContain("$mod");
  });
});
