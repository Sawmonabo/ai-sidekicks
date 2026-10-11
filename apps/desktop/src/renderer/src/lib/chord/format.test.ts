// How a chord prints and is spoken on each system's keyboard: macOS's glyphs run together, and a
// PC keyboard's words joined by `+`, its Meta key branded by the system.

import { describe, expect, it } from "vitest";

import { LINUX_KEYBOARD_CONVENTION } from "./convention/linux.js";
import { MAC_KEYBOARD_CONVENTION } from "./convention/mac.js";
import { WINDOWS_KEYBOARD_CONVENTION } from "./convention/windows.js";
import { formatChordForPlatform, renderChordForPlatform } from "./format.js";

describe("a chord as each keyboard prints it", () => {
  it("prints macOS glyphs as one run, and a PC keyboard's words joined by +", () => {
    expect(formatChordForPlatform("$mod+Shift+KeyK", MAC_KEYBOARD_CONVENTION)).toBe("⌘⇧K");
    for (const convention of [WINDOWS_KEYBOARD_CONVENTION, LINUX_KEYBOARD_CONVENTION]) {
      expect(formatChordForPlatform("$mod+Shift+KeyK", convention)).toBe("Ctrl+Shift+K");
      expect(formatChordForPlatform("Alt+Escape Delete", convention)).toBe("Alt+Esc Del");
    }
  });

  it("brands the Meta key as each PC system does, printed and spoken", () => {
    expect(renderChordForPlatform("Meta+KeyE", WINDOWS_KEYBOARD_CONVENTION)).toStrictEqual([
      { modifiers: [{ glyph: "Win", spoken: "Windows" }], key: { glyph: "E", spoken: "E" } },
    ]);
    expect(renderChordForPlatform("Meta+KeyE", LINUX_KEYBOARD_CONVENTION)).toStrictEqual([
      { modifiers: [{ glyph: "Super", spoken: "Super" }], key: { glyph: "E", spoken: "E" } },
    ]);
  });
});
