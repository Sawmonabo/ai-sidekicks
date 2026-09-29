// What the transcript contributes to the palette, and what it must not do: its commands
// register through the one command registry and never at import time. A module that
// registered at import time would satisfy every assertion about the command list, so the
// acts are counted before anything is run as well as after.

import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleRefusal } from "@renderer/lib/refusal.js";
import {
  CommandRegistry,
  KeyBindingTable,
  consoleCommandSurface,
  consoleCommands,
  consoleKeybindingOverrides,
  publishConsoleActRefusalSink,
  type ConsoleCommand,
} from "@renderer/console/palette/index.js";
import { MountedTranscript, type TranscriptActs } from "../mounted-transcript.js";
import {
  TRANSCRIPT_COMMAND_GROUP,
  TRANSCRIPT_COMMAND_OWNER,
  createTranscriptCommands,
  registerTranscriptCommands,
} from "./commands.js";

/** The acts, each recording that it and only it fired. */
function recordingActs(fired: string[]): TranscriptActs {
  return {
    openFind: () => fired.push("openFind"),
    stepFindNext: () => fired.push("stepFindNext"),
    stepFindPrevious: () => fired.push("stepFindPrevious"),
    jumpToLatest: () => fired.push("jumpToLatest"),
    foldEveryRun: () => fired.push("foldEveryRun"),
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
    createTranscriptCommands(recordingActs(fired));
    expect(fired).toStrictEqual([]);
  });

  it("builds a fresh list per window rather than handing out one shared array", () => {
    // Every `run` closes over one window's ledger, which is why this is a function
    // of the acts and not a module-scope constant.
    const acts = recordingActs([]);
    expect(createTranscriptCommands(acts)).not.toBe(createTranscriptCommands(acts));
  });

  it("contributes through the palette's own registry, which accepts the rows whole", () => {
    // The one registry, driven for real rather than shape-checked: if these rows
    // were built for something else, `registerAll` is where that would show.
    const registry = new CommandRegistry();
    registry.registerAll(createTranscriptCommands(recordingActs([])));
    expect(registry.size).toBe(5);
    expect(registry.all().map((command) => command.id)).toStrictEqual(
      createTranscriptCommands(recordingActs([])).map((command) => command.id),
    );
  });

  it("offers every act in a window with a session, through the palette's own evaluator", () => {
    const registry = new CommandRegistry();
    registry.registerAll(createTranscriptCommands(recordingActs([])));
    expect(registry.commandsFor({ sessionActive: true })).toHaveLength(5);
  });

  it("negative control: a window with no session is offered none of them", () => {
    // The clause is evaluated by `when-clause.ts`, whose fail-closed rule answers
    // false for a key the context does not carry — so this holds for a context
    // that says `false` and for one that says nothing at all.
    const registry = new CommandRegistry();
    registry.registerAll(createTranscriptCommands(recordingActs([])));
    expect(registry.commandsFor({ sessionActive: false })).toStrictEqual([]);
    expect(registry.commandsFor({})).toStrictEqual([]);
  });
});

describe("ledger commands — the rows themselves", () => {
  const commands = createTranscriptCommands(recordingActs([]));

  it("offers five acts under one group, each id unique and namespaced", () => {
    expect(commands).toHaveLength(5);
    expect(new Set(commands.map((command) => command.id)).size).toBe(5);
    for (const command of commands) {
      expect(command.group).toBe(TRANSCRIPT_COMMAND_GROUP);
      expect(command.id.startsWith("transcript.")).toBe(true);
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
      ["transcript.find", "openFind"],
      ["transcript.findNext", "stepFindNext"],
      ["transcript.findPrevious", "stepFindPrevious"],
      ["transcript.scrollToTail", "jumpToLatest"],
      ["transcript.collapseTerminalChapters", "foldEveryRun"],
    ];
    for (const [commandId, actName] of expectations) {
      const fired: string[] = [];
      commandById(createTranscriptCommands(recordingActs(fired)), commandId).run();
      expect(fired).toStrictEqual([actName]);
    }
  });
});

describe("ledger commands — the contribution reaches the palette and the keyboard", () => {
  /** Contributing an empty set is how a window is left with none of this family's rows. */
  function withdrawLedgerContribution(): void {
    consoleCommandSurface.contribute({
      owner: TRANSCRIPT_COMMAND_OWNER,
      commands: [],
      keyBindings: [],
    });
  }

  afterEach(() => {
    withdrawLedgerContribution();
  });

  /** A table over the window's real registry and its real chord list. */
  function keyBindingTable(): KeyBindingTable {
    const table = new KeyBindingTable({
      registry: consoleCommands,
      readContext: () => ({ sessionActive: true }),
    });
    table.setBindings(consoleKeybindingOverrides.surface.bindings);
    return table;
  }

  /**
   * Press one chord. `$mod` is Cmd on macOS and Ctrl elsewhere and this case does
   * not care which host it is running on, so the other modifier is tried only when
   * the first press was not consumed.
   */
  function pressModifiedKey(table: KeyBindingTable, key: string): boolean {
    return (
      table.handleKeyDown(new KeyboardEvent("keydown", { key, ctrlKey: true })) ||
      table.handleKeyDown(new KeyboardEvent("keydown", { key, metaKey: true }))
    );
  }

  it("puts every act in the window's palette once the family is composed", () => {
    registerTranscriptCommands(consoleCommandSurface);
    const offered = consoleCommands
      .commandsFor({ sessionActive: true })
      .map((command) => command.id);
    for (const command of createTranscriptCommands(recordingActs([]))) {
      expect(offered).toContain(command.id);
    }
  });

  it("opens find on the ledger that is mounted when the chord is pressed", () => {
    // The whole seam in one case: contributed at composition, resolved at press.
    const fired: string[] = [];
    const seat = new MountedTranscript();
    registerTranscriptCommands(consoleCommandSurface, seat);
    const release = seat.adopt(recordingActs(fired));
    expect(pressModifiedKey(keyBindingTable(), "f")).toBe(true);
    expect(fired).toStrictEqual(["openFind"]);
    release();
  });

  it("walks forward through the matches from the keyboard", () => {
    const fired: string[] = [];
    const seat = new MountedTranscript();
    registerTranscriptCommands(consoleCommandSurface, seat);
    const release = seat.adopt(recordingActs(fired));
    expect(pressModifiedKey(keyBindingTable(), "g")).toBe(true);
    expect(fired).toStrictEqual(["stepFindNext"]);
    release();
  });

  it("states a refusal where a person can read it when no ledger is mounted", () => {
    // Not a silent press: the act has no surface of its own, so it takes rule 9's
    // banner — which is exactly what a ledger chord from the settings page needs.
    const raised: ConsoleRefusal[] = [];
    const withdrawSink = publishConsoleActRefusalSink((refusal) => raised.push(refusal));
    registerTranscriptCommands(consoleCommandSurface, new MountedTranscript());
    expect(pressModifiedKey(keyBindingTable(), "f")).toBe(true);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.code).toBe("transcript.no_mounted_transcript");
    expect(raised[0]?.origin).toBe("ledger");
    withdrawSink();
  });

  it("replaces its own rows when the console is composed twice", () => {
    // Composition runs at module scope in production and repeatedly in a test, and
    // the command registry refuses a duplicate id — so a second pass must replace.
    registerTranscriptCommands(consoleCommandSurface);
    const afterFirst = consoleCommands.size;
    expect(() => {
      registerTranscriptCommands(consoleCommandSurface);
    }).not.toThrow();
    expect(consoleCommands.size).toBe(afterFirst);
  });

  it("negative control: nothing of this family is offered or bound before it composes", () => {
    // Every case above passes over a console that had these rows all along, which is
    // precisely what this family did NOT have.
    withdrawLedgerContribution();
    expect(consoleCommands.has("transcript.find")).toBe(false);
    expect(
      consoleKeybindingOverrides.surface.bindings.map((binding) => binding.commandId),
    ).not.toContain("transcript.find");
    const fired: string[] = [];
    const seat = new MountedTranscript();
    seat.adopt(recordingActs(fired));
    expect(pressModifiedKey(keyBindingTable(), "f")).toBe(false);
    expect(fired).toStrictEqual([]);
  });
});
