// What the ledger's structure contributes to the palette, and what it must not do.
//
// Two claims, and the second is the one this lane's definition of done names: find,
// filters, and jumps register through `palette/contributions.ts` and never through a
// second command registry. A module that registered at import time would satisfy
// every assertion about the command LIST while doing exactly the thing forbidden, so
// the acts are counted before anything is run as well as after.

import { describe, expect, it } from "vitest";

import { CommandRegistry, type ConsoleCommand } from "../../palette/index.js";
import {
  LEDGER_COMMAND_GROUP,
  LEDGER_KEY_BINDINGS,
  ledgerStructureCommands,
  type LedgerStructureActs,
} from "./structure-commands.js";

/** The acts, each recording that it and only it fired. */
function recordingActs(fired: string[]): LedgerStructureActs {
  return {
    openFind: () => fired.push("openFind"),
    stepFindNext: () => fired.push("stepFindNext"),
    stepFindPrevious: () => fired.push("stepFindPrevious"),
    clearFilters: () => fired.push("clearFilters"),
    scrollToTail: () => fired.push("scrollToTail"),
    collapseAllTerminalChapters: () => fired.push("collapseAllTerminalChapters"),
    toggleReplay: () => fired.push("toggleReplay"),
    jumpToNextSeam: () => fired.push("jumpToNextSeam"),
  };
}

function commandById(commands: readonly ConsoleCommand[], commandId: string): ConsoleCommand {
  const command = commands.find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    throw new Error(`the builder produced no command named ${commandId}`);
  }
  return command;
}

describe("ledger commands — the contribution is a value, and building it registers nothing", () => {
  it("fires no act merely by being built", () => {
    const fired: string[] = [];
    ledgerStructureCommands(recordingActs(fired));
    expect(fired).toStrictEqual([]);
  });

  it("builds a fresh list per window rather than handing out one shared array", () => {
    // Every `run` closes over one window's ledger, which is why this is a function
    // of the acts and not a module-scope constant.
    const acts = recordingActs([]);
    expect(ledgerStructureCommands(acts)).not.toBe(ledgerStructureCommands(acts));
  });

  it("contributes through the palette's own registry, which accepts the rows whole", () => {
    // The one registry, driven for real rather than shape-checked: if these rows
    // were built for something else, `registerAll` is where that would show.
    const registry = new CommandRegistry();
    registry.registerAll(ledgerStructureCommands(recordingActs([])));
    expect(registry.size).toBe(8);
    expect(registry.all().map((command) => command.id)).toStrictEqual(
      ledgerStructureCommands(recordingActs([])).map((command) => command.id),
    );
  });

  it("offers every act in a window with a session, through the palette's own evaluator", () => {
    const registry = new CommandRegistry();
    registry.registerAll(ledgerStructureCommands(recordingActs([])));
    expect(registry.commandsFor({ sessionActive: true })).toHaveLength(8);
  });

  it("negative control: a window with no session is offered none of them", () => {
    // The clause is evaluated by `when-clause.ts`, whose fail-closed rule answers
    // false for a key the context does not carry — so this holds for a context
    // that says `false` and for one that says nothing at all.
    const registry = new CommandRegistry();
    registry.registerAll(ledgerStructureCommands(recordingActs([])));
    expect(registry.commandsFor({ sessionActive: false })).toStrictEqual([]);
    expect(registry.commandsFor({})).toStrictEqual([]);
  });
});

describe("ledger commands — the rows themselves", () => {
  const commands = ledgerStructureCommands(recordingActs([]));

  it("offers eight acts under one group, each id unique and namespaced", () => {
    expect(commands).toHaveLength(8);
    expect(new Set(commands.map((command) => command.id)).size).toBe(8);
    for (const command of commands) {
      expect(command.group).toBe(LEDGER_COMMAND_GROUP);
      expect(command.id.startsWith("ledger.")).toBe(true);
      expect(command.title.endsWith(".")).toBe(false);
    }
  });

  it("gates every act on an active session, so a window with none offers nothing to act on", () => {
    for (const command of commands) {
      expect(command.when).toBe("sessionActive");
    }
  });

  it("negative control: the gate is a real clause and not an empty string", () => {
    // An absent or empty `when` means unconditional, which is the failure this
    // guards — the fail-closed reading depends on the clause being present.
    for (const command of commands) {
      expect(command.when).not.toBe("");
      expect(command.when).toBeDefined();
    }
  });

  it("runs exactly its own act, and only when run", () => {
    const expectations: readonly (readonly [string, string])[] = [
      ["ledger.find", "openFind"],
      ["ledger.findNext", "stepFindNext"],
      ["ledger.findPrevious", "stepFindPrevious"],
      ["ledger.clearFilters", "clearFilters"],
      ["ledger.scrollToTail", "scrollToTail"],
      ["ledger.collapseTerminalChapters", "collapseAllTerminalChapters"],
      ["ledger.toggleReplay", "toggleReplay"],
      ["ledger.jumpToNextSeam", "jumpToNextSeam"],
    ];
    for (const [commandId, actName] of expectations) {
      const fired: string[] = [];
      commandById(ledgerStructureCommands(recordingActs(fired)), commandId).run();
      expect(fired).toStrictEqual([actName]);
    }
  });
});

describe("ledger commands — the chords", () => {
  const commandIds = new Set(
    ledgerStructureCommands(recordingActs([])).map((command) => command.id),
  );

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
