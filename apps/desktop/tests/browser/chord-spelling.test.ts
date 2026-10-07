// A held chord fires only in the app's one spelling. tinykeys asks the event for each modifier by
// the name the chord writes, and which names Chromium's `getModifierState` answers to is the
// engine's call: happy-dom ignores case there, so only a real press decides it.

import { describe, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { normalizeChord } from "#renderer/lib/chord-format.js";
import { chordMatchesEvent, parseChord } from "#renderer/registries/keybindings/chord.js";

/** The names asked of each press: the ones tinykeys reads and the spellings it does not. */
const MODIFIER_NAMES = ["Control", "Ctrl", "control", "Alt", "Option"] as const;

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

/** Whether the parsed chord matches this press; a chord that does not parse matches nothing. */
function chordMatches(chord: string, press: KeyboardEvent): boolean {
  const parsed = parseChord(chord);
  return parsed.ok && chordMatchesEvent(parsed.press, press);
}

describe("a modifier name a real press answers to", () => {
  it("answers Control and Alt only, so Ctrl and Option fire once respelled", async () => {
    const presses = recordKPresses();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("{Alt>}k{/Alt}");
    const [controlK, altK] = presses;
    if (controlK === undefined || altK === undefined) {
      throw new Error("the engine dispatched no keydown for K");
    }

    const answers = (press: KeyboardEvent): Record<string, boolean> =>
      Object.fromEntries(MODIFIER_NAMES.map((name) => [name, press.getModifierState(name)]));
    expect([answers(controlK), answers(altK)]).toStrictEqual([
      { Control: true, Ctrl: false, control: false, Alt: false, Option: false },
      { Control: false, Ctrl: false, control: false, Alt: true, Option: false },
    ]);

    // The chord as a person may write it misses the press; its one spelling meets it.
    expect(chordMatches("Ctrl+KeyK", controlK)).toBe(false);
    expect(chordMatches(normalizeChord("Ctrl+KeyK", "darwin"), controlK)).toBe(true);
    expect(chordMatches("Option+KeyK", altK)).toBe(false);
    expect(chordMatches(normalizeChord("Option+KeyK", "darwin"), altK)).toBe(true);
  });
});
