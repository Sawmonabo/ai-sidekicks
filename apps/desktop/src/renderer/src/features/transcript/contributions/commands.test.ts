// What the transcript's palette commands do when run: each runs its own act, reaches the
// transcript that is mounted, and says so when none is.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Refusal } from "@renderer/lib/refusal/refusal.js";
import { KeybindingTable } from "@renderer/registries/keybindings/keybinding-table.js";
import { commandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { keybindingOverrides } from "@renderer/registries/keybindings/keybinding-override-store.js";
import { publishCommandRefusalSink } from "@renderer/registries/commands/command-refusal.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { MountedTranscript, type TranscriptActs } from "../mounted-transcript.js";
import { createTranscriptCommands, registerTranscriptCommands } from "./commands.js";
import { TRANSCRIPT_OWNER } from "./screens.js";
import { publishCommandWindow } from "@renderer/registries/commands/command-window.js";

// A command acts in the window used last; the test's document stands in for it.
beforeEach(() => publishCommandWindow(() => document));

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

function commandById(commands: readonly CommandDefinition[], commandId: string): CommandDefinition {
  const command = commands.find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    throw new Error(`the builder produced no command named ${commandId}`);
  }
  return command;
}

describe("transcript commands — the rows themselves", () => {
  it("runs exactly its own act, and only when run", () => {
    const expectations: readonly (readonly [string, string])[] = [
      ["transcript.find", "openFind"],
      ["transcript.findNext", "stepFindNext"],
      ["transcript.findPrevious", "stepFindPrevious"],
      ["transcript.scrollToTail", "jumpToLatest"],
      ["transcript.collapseTerminalRunGroups", "foldEveryRun"],
    ];
    for (const [commandId, actName] of expectations) {
      const fired: string[] = [];
      commandById(createTranscriptCommands(recordingActs(fired)), commandId).run();
      expect(fired).toStrictEqual([actName]);
    }
  });
});

describe("transcript commands — the contribution reaches the palette and the keyboard", () => {
  /** Contributing an empty set is how a window is left with none of the transcript's rows. */
  function withdrawTranscriptContribution(): void {
    commandContributionRegistry.contribute({
      owner: TRANSCRIPT_OWNER,
      commands: [],
      keyBindings: [],
    });
  }

  afterEach(() => {
    withdrawTranscriptContribution();
  });

  /** A table over the window's real registry and its real chord list. */
  function keyBindingTable(): KeybindingTable {
    const table = new KeybindingTable({
      registry: commandRegistry,
      readContext: () => ({ sessionActive: true }),
    });
    table.setBindings(keybindingOverrides.snapshot.bindings);
    return table;
  }

  /**
   * Press one chord. `$mod` is Cmd on macOS and Ctrl elsewhere and this case does not care
   * which, so the other modifier is tried when the first press was not consumed.
   */
  function pressModifiedKey(table: KeybindingTable, key: string): boolean {
    return (
      table.handleKeyDown(new KeyboardEvent("keydown", { key, ctrlKey: true })) ||
      table.handleKeyDown(new KeyboardEvent("keydown", { key, metaKey: true }))
    );
  }

  it("opens find on the transcript that is mounted when the chord is pressed", () => {
    // The whole seam in one case: contributed at composition, resolved at press.
    const fired: string[] = [];
    const transcript = new MountedTranscript();
    registerTranscriptCommands(commandContributionRegistry, transcript);
    const release = transcript.adopt(recordingActs(fired), document);
    expect(pressModifiedKey(keyBindingTable(), "f")).toBe(true);
    expect(fired).toStrictEqual(["openFind"]);
    release();
  });

  it("states a refusal where a person can read it when no transcript is mounted", () => {
    // With no transcript on screen the refusal goes to the frame's banner, which is what a
    // transcript chord pressed from the settings page needs.
    const raised: Refusal[] = [];
    const withdrawSink = publishCommandRefusalSink((refusal) => raised.push(refusal));
    registerTranscriptCommands(commandContributionRegistry, new MountedTranscript());
    expect(pressModifiedKey(keyBindingTable(), "f")).toBe(true);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.code).toBe("transcript.no_mounted_transcript");
    expect(raised[0]?.origin).toBe("transcript");
    withdrawSink();
  });
});
