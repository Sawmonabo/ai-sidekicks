// The map joins commands to bindings, and the recorder reads one keystroke as one act. Verdicts
// about a binding set are the keybinding service's own and are tested in
// `registries/keybindings/keybinding-audit.test.ts`.

import { describe, expect, it } from "vitest";

import {
  type CommandDefinition,
  type Keybinding,
} from "@renderer/registries/commands/command-types.js";
import {
  composeKeybindingRows,
  matchKeybindingRows,
  readChordFromEvent,
  readHeldModifiersFromEvent,
  type ChordRecording,
} from "./keybinding-map.js";

function command(id: string, title: string, group = "Navigation"): CommandDefinition {
  return { id, title, group, run: () => undefined };
}

/** One keystroke as the recorder receives it, with only the fields it reads. */
function press(
  fields: Partial<
    Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
  >,
): Parameters<typeof readChordFromEvent>[0] {
  return {
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...fields,
  };
}

describe("composing rows", () => {
  const commands = [
    command("frame.goToWorkflows", "Go to workflows"),
    command("frame.goToSessions", "Go to sessions"),
    command("app.checkForUpdates", "Check for updates", "Application"),
  ];
  const bindings: readonly Keybinding[] = [
    { chord: "$mod+1", commandId: "frame.goToSessions" },
    { chord: "$mod+2", commandId: "frame.goToWorkflows", when: "sessionActive" },
  ];

  it("carries each command's chord and the scope of that chord", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    const workflows = rows.find((row) => row.commandId === "frame.goToWorkflows");
    expect(workflows?.chord).toBe("$mod+2");
    expect(workflows?.whenExpression).toBe("sessionActive");
  });

  it("leaves a command with no binding without a chord rather than inventing one", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(rows.find((row) => row.commandId === "app.checkForUpdates")?.chord).toBeUndefined();
  });

  it("orders by category and then by name, so the list matches the palette", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(rows.map((row) => row.commandId)).toStrictEqual([
      "app.checkForUpdates",
      "frame.goToSessions",
      "frame.goToWorkflows",
    ]);
  });

  it("marks a bound chord the host takes, and leaves the others unmarked", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings: [{ chord: "$mod+Space", commandId: "frame.goToSessions" }, ...bindings.slice(1)],
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(rows.find((row) => row.commandId === "frame.goToSessions")?.unavailableReason).toContain(
      "Spotlight",
    );
    // Marking every row would be as wrong as marking none; only the reserved one has a reason.
    expect(
      rows.find((row) => row.commandId === "frame.goToWorkflows")?.unavailableReason,
    ).toBeUndefined();
  });

  it("marks the rows a person changed, including one they left with no chord", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      overrides: { "frame.goToSessions": "$mod+1", "app.checkForUpdates": null },
      platform: "darwin",
    });
    const changed = rows.filter((row) => row.overridden).map((row) => row.commandId);
    expect(changed).toStrictEqual(["app.checkForUpdates", "frame.goToSessions"]);
  });

  it("carries the chord the console ships, so a reset can name what it restores", () => {
    // Composed against a changed effective table: the shipped chord must survive the override.
    const rows = composeKeybindingRows({
      commands,
      bindings: [{ chord: "$mod+9", commandId: "frame.goToSessions" }, ...bindings.slice(1)],
      shippedBindings: bindings,
      overrides: { "frame.goToSessions": "$mod+9" },
      platform: "darwin",
    });
    const changed = rows.find((row) => row.commandId === "frame.goToSessions");
    expect(changed?.chord).toBe("$mod+9");
    expect(changed?.shippedChord).toBe("$mod+1");
  });

  it("leaves a command the console ships no chord for without a default to restore", () => {
    // "Back to no chord" and "back to some chord" differ; only an absent `shippedChord` carries
    // the first.
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(
      rows.find((row) => row.commandId === "app.checkForUpdates")?.shippedChord,
    ).toBeUndefined();
  });

  it("negative control: with no overrides, no row claims to have been changed", () => {
    // Guards against a composer that marks every row, offering a reset with nothing to reset.
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(rows.some((row) => row.overridden)).toBe(false);
  });
});

describe("reading a keystroke as a chord", () => {
  it("composes the held modifiers and the physical key, in the console's order", () => {
    const read = readChordFromEvent(
      press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true }),
      "darwin",
    );
    expect(read).toStrictEqual<ChordRecording>({ outcome: "captured", chord: "$mod+Shift+KeyK" });
  });

  it("writes the platform's command modifier as `$mod` and the other one literally", () => {
    // On macOS `⌃` and `⌘` are different keys; folding them installs on the wrong one.
    expect(readChordFromEvent(press({ key: "k", code: "KeyK", ctrlKey: true }), "darwin")).toEqual({
      outcome: "captured",
      chord: "Control+KeyK",
    });
    expect(readChordFromEvent(press({ key: "k", code: "KeyK", ctrlKey: true }), "win32")).toEqual({
      outcome: "captured",
      chord: "$mod+KeyK",
    });
  });

  it("does not complete on a modifier held on its own", () => {
    // On the way to ⌘⇧K a person passes through ⌘ and ⌘⇧;
    // settling on either binds the wrong chord.
    expect(
      readChordFromEvent(press({ key: "Meta", code: "MetaLeft", metaKey: true }), "darwin"),
    ).toEqual({ outcome: "incomplete", heldModifiers: ["$mod"] });
    expect(
      readChordFromEvent(
        press({ key: "Shift", code: "ShiftLeft", metaKey: true, shiftKey: true }),
        "darwin",
      ),
    ).toEqual({ outcome: "incomplete", heldModifiers: ["$mod", "Shift"] });
  });

  it("cancels on Escape and clears on Backspace or Delete, pressed alone", () => {
    expect(readChordFromEvent(press({ key: "Escape", code: "Escape" }))).toEqual({
      outcome: "canceled",
    });
    expect(readChordFromEvent(press({ key: "Backspace", code: "Backspace" }))).toEqual({
      outcome: "cleared",
    });
    expect(readChordFromEvent(press({ key: "Delete", code: "Delete" }))).toEqual({
      outcome: "cleared",
    });
  });

  it("negative control: the same keys held with a modifier are chords, not commands", () => {
    // Guards `$mod+Backspace` from being unbindable by reading it as a clearing.
    expect(
      readChordFromEvent(press({ key: "Backspace", code: "Backspace", metaKey: true }), "darwin"),
    ).toEqual({ outcome: "captured", chord: "$mod+Backspace" });
    expect(
      readChordFromEvent(press({ key: "Escape", code: "Escape", shiftKey: true }), "darwin"),
    ).toEqual({ outcome: "captured", chord: "Shift+Escape" });
  });

  it("falls back to the key when the host supplies no physical code", () => {
    expect(readChordFromEvent(press({ key: "F5", code: "" }))).toEqual({
      outcome: "captured",
      chord: "F5",
    });
  });
});

describe("reading what is held right now", () => {
  it("answers the same tokens a chord is composed from", () => {
    // The hint and the chord read one function, so a modifier has one name in both.
    const held = press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(readHeldModifiersFromEvent(held, "darwin")).toStrictEqual(["$mod", "Shift"]);
    expect(readChordFromEvent(held, "darwin")).toStrictEqual<ChordRecording>({
      outcome: "captured",
      chord: "$mod+Shift+KeyK",
    });
  });

  it("answers the state a release leaves behind, not the key that ended", () => {
    // A keyup carries the flags the host is in after the release, so `⇧` released while `⌥` is
    // down reads as `⌥` alone; recomputing is correct where clearing is not.
    expect(
      readHeldModifiersFromEvent(
        press({ key: "Shift", code: "ShiftLeft", altKey: true, shiftKey: false }),
        "darwin",
      ),
    ).toStrictEqual(["Alt"]);
  });

  it("answers nothing once the last modifier is released", () => {
    expect(
      readHeldModifiersFromEvent(press({ key: "Shift", code: "ShiftLeft" }), "darwin"),
    ).toStrictEqual([]);
  });

  it("negative control: the key that ended does not decide the answer", () => {
    // Guards against a reader that keys on `key` and subtracts the released modifier itself,
    // which is wrong for a stuck flag and for a chord read on keydown.
    expect(
      readHeldModifiersFromEvent(
        press({ key: "Shift", code: "ShiftLeft", shiftKey: true }),
        "darwin",
      ),
    ).toStrictEqual(["Shift"]);
  });
});

describe("filtering rows", () => {
  const bindings: readonly Keybinding[] = [
    { chord: "$mod+1", commandId: "frame.goToSessions", when: "sessionActive" },
  ];
  const rows = composeKeybindingRows({
    commands: [
      command("frame.goToSessions", "Go to sessions"),
      command("app.checkForUpdates", "Check for updates", "Application"),
    ],
    bindings,
    shippedBindings: bindings,
    platform: "darwin",
  });

  it("answers every row before anything is typed", () => {
    expect(matchKeybindingRows(rows, "   ")).toHaveLength(2);
  });

  it("narrows on the name, and on the command id", () => {
    expect(matchKeybindingRows(rows, "sessions").map((row) => row.commandId)).toStrictEqual([
      "frame.goToSessions",
    ]);
    expect(matchKeybindingRows(rows, "app.check").map((row) => row.commandId)).toStrictEqual([
      "app.checkForUpdates",
    ]);
  });

  it("narrows on the chord and on the when-scope, the section's other two axes", () => {
    expect(matchKeybindingRows(rows, "$mod+1").map((row) => row.commandId)).toStrictEqual([
      "frame.goToSessions",
    ]);
    expect(matchKeybindingRows(rows, "sessionActive").map((row) => row.commandId)).toStrictEqual([
      "frame.goToSessions",
    ]);
  });

  it("negative control: a query nothing matches narrows to nothing", () => {
    // A filter that always answered everything would satisfy the assertions above.
    expect(matchKeybindingRows(rows, "zzzqqq")).toHaveLength(0);
  });
});
