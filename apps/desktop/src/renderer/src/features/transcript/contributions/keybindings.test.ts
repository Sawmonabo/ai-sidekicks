// The transcript's chords: each names a command the transcript contributes, platform
// neutral, scoped to an active session, and never firing while somebody types.

import { describe, expect, it } from "vitest";

import { type LedgerStructureActs } from "../mounted-transcript.js";
import { ledgerStructureCommands } from "./commands.js";
import { LEDGER_KEY_BINDINGS } from "./keybindings.js";

/** Acts that do nothing: only the command ids are read here. */
const IDLE_ACTS: LedgerStructureActs = {
  openFind: () => {},
  stepFindNext: () => {},
  stepFindPrevious: () => {},
  scrollToTail: () => {},
  collapseAllTerminalChapters: () => {},
};

describe("ledger commands — the chords", () => {
  const commandIds = new Set(ledgerStructureCommands(IDLE_ACTS).map((command) => command.id));

  it("binds only commands this module actually contributes", () => {
    // A chord naming an id nothing registers is a keypress that silently does
    // nothing, which is invisible until somebody presses it.
    for (const binding of LEDGER_KEY_BINDINGS) {
      expect(commandIds.has(binding.commandId)).toBe(true);
    }
  });

  it("negative control: the id set does not admit an unregistered command", () => {
    expect(commandIds.has("ledger.a-command-nobody-contributed")).toBe(false);
  });

  it("writes every chord platform-neutrally, and scopes each to an active session", () => {
    for (const binding of LEDGER_KEY_BINDINGS) {
      expect(binding.chord.startsWith("$mod+")).toBe(true);
      expect(binding.when).toBe("sessionActive");
    }
  });

  it("declines to fire while somebody is typing", () => {
    // None of these is a chord a person wants firing mid-message. `undefined` is
    // the default, and stating it here is what keeps a later `true` deliberate.
    for (const binding of LEDGER_KEY_BINDINGS) {
      expect(binding.allowInTextInput).toBeUndefined();
    }
  });

  it("claims no chord twice", () => {
    const chords = LEDGER_KEY_BINDINGS.map((binding) => binding.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });
});
