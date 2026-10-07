// A held chord fires only in the app's one spelling. tinykeys asks the event for each modifier by
// the name the chord writes, and which names Chromium's `getModifierState` answers to is the
// engine's call: happy-dom ignores case there, so only a real press decides it.

import { matchKeybindingPress, parseKeybinding } from "tinykeys";
import { describe, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { normalizeChord } from "#renderer/lib/chord-format.js";
import { chordMatchesEvent, parseChord } from "#renderer/registries/keybindings/chord.js";

/** Records every keydown of K until the test ends. */
function recordKPresses(): KeyboardEvent[] {
  const presses: KeyboardEvent[] = [];
  const listener = (event: KeyboardEvent): void => {
    if (event.code === "KeyK") {
      presses.push(event);
    }
  };
  document.addEventListener("keydown", listener);
  onTestFinished(() => {
    document.removeEventListener("keydown", listener);
  });
  return presses;
}

/** Whether the table's parser accepts the chord and it matches this press. */
function chordMatches(chord: string, press: KeyboardEvent): boolean {
  const parsed = parseChord(chord);
  return parsed.ok && chordMatchesEvent(parsed.press, press);
}

// Straight to tinykeys, past the parser that refuses these names, to show the press itself never
// answers to them.
function matchesInTinykeys(chord: string, press: KeyboardEvent): boolean {
  const [parsed] = parseKeybinding(chord);
  return parsed !== undefined && matchKeybindingPress(press, parsed);
}

describe("a chord's modifier names on a real press", () => {
  it("fires a Ctrl, control or Option chord only once it is read into the one spelling", async () => {
    const presses = recordKPresses();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("{Alt>}k{/Alt}");
    const [controlK, altK] = presses;
    if (controlK === undefined || altK === undefined) {
      throw new Error("the engine dispatched no keydown for K");
    }

    // Read for macOS so Control stays `Control`: off macOS it becomes `$mod`, which tinykeys
    // resolves against the machine running the test.
    const pairs: readonly [string, KeyboardEvent][] = [
      ["Ctrl+KeyK", controlK],
      ["control+KeyK", controlK],
      ["Option+KeyK", altK],
    ];
    for (const [stored, press] of pairs) {
      expect(matchesInTinykeys(stored, press)).toBe(false);
      expect(chordMatches(normalizeChord(stored, "darwin"), press)).toBe(true);
    }
  });
});
