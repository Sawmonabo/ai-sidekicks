// The transcript's chords: each names a command the transcript contributes, platform
// neutral, scoped to an active session, and never firing while somebody types.

import { describe, expect, it } from "vitest";

import { type TranscriptActs } from "../mounted-transcript.js";
import { createTranscriptCommands } from "./commands.js";
import { TRANSCRIPT_KEY_BINDINGS } from "./keybindings.js";

/** Acts that do nothing: only the command ids are read here. */
const IDLE_ACTS: TranscriptActs = {
  openFind: () => {},
  stepFindNext: () => {},
  stepFindPrevious: () => {},
  jumpToLatest: () => {},
  foldEveryRun: () => {},
};

describe("transcript commands — the chords", () => {
  const commandIds = new Set(createTranscriptCommands(IDLE_ACTS).map((command) => command.id));

  it("binds only commands this module actually contributes", () => {
    // A chord naming an id nothing registers is a keypress that silently does nothing.
    for (const binding of TRANSCRIPT_KEY_BINDINGS) {
      expect(commandIds.has(binding.commandId)).toBe(true);
    }
  });

  it("negative control: the id set does not admit an unregistered command", () => {
    expect(commandIds.has("transcript.a-command-nobody-contributed")).toBe(false);
  });

  it("writes every chord platform-neutrally, and scopes each to an active session", () => {
    for (const binding of TRANSCRIPT_KEY_BINDINGS) {
      expect(binding.chord.startsWith("$mod+")).toBe(true);
      expect(binding.when).toBe("sessionActive");
    }
  });

  it("declines to fire while somebody is typing", () => {
    // None of these is a chord a person wants firing mid-message. `undefined` is
    // the default, and stating it here is what keeps a later `true` deliberate.
    for (const binding of TRANSCRIPT_KEY_BINDINGS) {
      expect(binding.allowInTextInput).toBeUndefined();
    }
  });

  it("claims no chord twice", () => {
    const chords = TRANSCRIPT_KEY_BINDINGS.map((binding) => binding.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });
});
